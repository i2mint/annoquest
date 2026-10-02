/**
 * Keeping answers: on the device first (every change), then at the sink.
 *
 * Client storage is a zodal `DataProvider` (seam 3; localStorage by default).
 * The sink (seam 4) is `local` (nothing leaves the device until the reader
 * sends a reply link) or `http` (debounced autosubmit of the whole responses
 * document, flushed with `keepalive` on `pagehide` / hidden, retried with
 * backoff, and paused on 401 until the reader signs in again).
 */
import type { DataProvider } from '@zodal/store';
import { createLocalStorageProvider } from '@zodal/store-localstorage';
import type { Request, Responses } from '../src/spec';

export type Stored = Responses & { id: string };

export const defaultStore = (): DataProvider<Stored> => createLocalStorageProvider<Stored>({ storageKey: 'annoquest:responses' });

export async function loadLocal(store: DataProvider<Stored>, id: string): Promise<Stored | undefined> {
  try {
    return await store.getOne(id);
  } catch {
    return undefined;
  }
}

export async function saveLocal(store: DataProvider<Stored>, value: Stored): Promise<boolean> {
  try {
    if (store.upsert) await store.upsert(value);
    else await store.update(value.id, value).catch(() => store.create(value));
    return true;
  } catch {
    return false;
  }
}

/** Merge two copies of a reader's responses: per answer the higher rev wins; extras are unioned. */
export function mergeResponses<T extends Responses>(a: T, b: Responses | undefined): T {
  if (!b) return a;
  const answers = { ...a.answers };
  for (const [k, v] of Object.entries(b.answers)) {
    const mine = answers[k];
    if (!mine || mine.rev < v.rev || (mine.rev === v.rev && mine.at < v.at)) answers[k] = v;
  }
  const ids = new Set(a.extras.map((x) => x.id));
  const extras = [...a.extras, ...b.extras.filter((x) => !ids.has(x.id))];
  return {
    ...a,
    answers,
    extras,
    updatedAt: a.updatedAt > b.updatedAt ? a.updatedAt : b.updatedAt,
    finishedAt: a.finishedAt ?? b.finishedAt,
  };
}

export type SinkState =
  | { kind: 'local' }
  | { kind: 'saving' }
  | { kind: 'sent'; at: string }
  | { kind: 'offline'; retryIn: number }
  | { kind: 'auth' }
  | { kind: 'error'; message: string };

export interface HttpSink {
  /** Who the server says the reader is (null when it does not say). */
  whoami(): Promise<string | null>;
  register(request: Request): Promise<void>;
  mine(): Promise<Responses | undefined>;
  schedule(value: Responses): void;
  flush(opts?: { keepalive?: boolean }): Promise<void>;
  dispose(): void;
}

const JSON_HEADERS = { Accept: 'application/json', 'Content-Type': 'application/json' };

export function createHttpSink(
  base: string,
  requestId: string,
  onState: (s: SinkState) => void,
  { delay = 2000, maxBackoff = 60000 } = {},
): HttpSink {
  const api = base.replace(/\/$/, '');
  const at = (p: string) => `${api}${p}`;
  let pending: Responses | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let backoff = 0;
  let inFlight: Promise<void> | null = null;
  let authBlocked = false;

  const send = async (keepalive = false) => {
    if (!pending) return;
    const value = pending;
    pending = null;
    onState({ kind: 'saving' });
    try {
      const res = await fetch(at(`/requests/${encodeURIComponent(requestId)}/responses`), {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(value),
        credentials: 'same-origin',
        keepalive,
      });
      if (res.status === 401) {
        pending ??= value;
        authBlocked = true;
        onState({ kind: 'auth' });
        return;
      }
      if (!res.ok) throw new Error(`The server answered ${res.status}.`);
      backoff = 0;
      authBlocked = false;
      onState({ kind: 'sent', at: new Date().toISOString() });
    } catch (e) {
      pending ??= value; // keep it for the retry unless newer input replaced it
      backoff = Math.min(maxBackoff, backoff ? backoff * 2 : 5000);
      onState({ kind: 'offline', retryIn: backoff });
      clearTimeout(timer);
      timer = setTimeout(() => void flush(), backoff);
      if (!(e instanceof TypeError)) console.warn('[annoquest] submit failed:', e);
    }
  };

  const flush = ({ keepalive = false } = {}): Promise<void> => {
    clearTimeout(timer);
    const next = (inFlight ?? Promise.resolve()).then(() => send(keepalive));
    inFlight = next.finally(() => {
      if (inFlight === next) inFlight = null;
    });
    return next;
  };

  const onHide = () => {
    if (document.visibilityState === 'hidden') void flush({ keepalive: true });
  };
  const onPageHide = () => void flush({ keepalive: true });
  const onOnline = () => void flush();
  addEventListener('pagehide', onPageHide);
  document.addEventListener('visibilitychange', onHide);
  addEventListener('online', onOnline);

  return {
    async whoami() {
      try {
        const res = await fetch(at('/whoami'), { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
        if (res.status === 401) {
          onState({ kind: 'auth' });
          return null;
        }
        return res.ok ? ((await res.json()).user ?? null) : null;
      } catch {
        return null;
      }
    },
    async register(request) {
      const res = await fetch(at(`/requests/${encodeURIComponent(request.id)}`), {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify(request),
        credentials: 'same-origin',
      }).catch(() => null);
      if (res && res.status === 401) onState({ kind: 'auth' });
    },
    async mine() {
      try {
        const res = await fetch(at(`/requests/${encodeURIComponent(requestId)}/responses/mine`), {
          headers: { Accept: 'application/json' },
          credentials: 'same-origin',
        });
        return res.ok ? ((await res.json()) as Responses) : undefined;
      } catch {
        return undefined;
      }
    },
    schedule(value) {
      pending = value;
      if (authBlocked) return;
      clearTimeout(timer);
      timer = setTimeout(() => void flush(), delay);
    },
    flush,
    dispose() {
      clearTimeout(timer);
      removeEventListener('pagehide', onPageHide);
      document.removeEventListener('visibilitychange', onHide);
      removeEventListener('online', onOnline);
    },
  };
}
