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
import { mergeResponses } from '../src/collect';
import type { Request, Responses } from '../src/spec';

export { mergeResponses };

export type Stored = Responses & { id: string };

export const defaultStore = (): DataProvider<Stored> => createLocalStorageProvider<Stored>({ storageKey: 'annoquest:responses' });

export async function loadLocal(store: DataProvider<Stored>, id: string): Promise<Stored | undefined> {
  try {
    return await store.getOne(id);
  } catch {
    return undefined;
  }
}

/** Write locally, merged with what is stored (another tab may have written since). */
export async function saveLocal(store: DataProvider<Stored>, value: Stored): Promise<boolean> {
  try {
    value = mergeResponses(value, await loadLocal(store, value.id));
    if (store.upsert) await store.upsert(value);
    else await store.update(value.id, value).catch(() => store.create(value));
    return true;
  } catch {
    return false;
  }
}

export type SinkState =
  | { kind: 'local' }
  | { kind: 'pending' }
  | { kind: 'waiting' }
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

/** The sink a request asks for (seam 4): null for `local`. Add a sink kind here, nowhere else. */
export function makeSink(request: Request, onState: (s: SinkState) => void): HttpSink | null {
  switch (request.sink.kind) {
    case 'http':
      return createHttpSink(request.sink.url, request.id, onState);
    default:
      return null;
  }
}

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

  const retry = (state: SinkState) => {
    backoff = Math.min(maxBackoff, backoff ? backoff * 2 : 5000);
    onState(state.kind === 'offline' ? { kind: 'offline', retryIn: backoff } : state);
    clearTimeout(timer);
    timer = setTimeout(() => void flush(), backoff);
  };

  const post = (value: Responses, keepalive: boolean) => {
    const body = JSON.stringify(value);
    return fetch(at(`/requests/${encodeURIComponent(requestId)}/responses`), {
      method: 'POST',
      headers: JSON_HEADERS,
      body,
      credentials: 'same-origin',
      // Browsers cap keepalive bodies at 64 KB; above that a normal request is the better bet.
      keepalive: keepalive && body.length < 60000,
    });
  };

  const send = async (keepalive = false) => {
    if (!pending) return;
    const value = pending;
    pending = null;
    onState({ kind: 'saving' });
    try {
      const res = await post(value, keepalive);
      const json = res.headers.get('content-type')?.includes('json') ? await res.json().catch(() => null) : null;
      if (res.status === 401 || (res.ok && !json?.saved)) {
        // 401, or a gateway's login page answering 200: the session is gone.
        pending ??= value;
        authBlocked = true;
        onState({ kind: 'auth' });
        return;
      }
      if (res.status === 404) {
        pending ??= value; // the request is not registered yet: keep trying, slowly
        return retry({ kind: 'waiting' });
      }
      if (res.status >= 400 && res.status < 500) {
        pending ??= value;
        onState({ kind: 'error', message: `Your answers are saved here, but the server refused them (${json?.detail ?? res.status}).` });
        return;
      }
      if (!res.ok) throw new Error(`The server answered ${res.status}.`);
      backoff = 0;
      authBlocked = false;
      onState(pending ? { kind: 'pending' } : { kind: 'sent', at: new Date().toISOString() });
    } catch (e) {
      pending ??= value; // keep it for the retry unless newer input replaced it
      retry({ kind: 'offline', retryIn: 0 });
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

  /** Last chance (page hidden or closing): send now, without queueing behind a send in flight. */
  const lastChance = () => {
    clearTimeout(timer);
    if (!pending || authBlocked) return;
    const value = pending;
    pending = null;
    void post(value, true)
      .then(async (res) => {
        const json = res.headers.get('content-type')?.includes('json') ? await res.json().catch(() => null) : null;
        if (!res.ok || !json?.saved) throw new Error(String(res.status));
        if (!pending) onState({ kind: 'sent', at: new Date().toISOString() });
      })
      .catch(() => {
        // Not saved after all: keep it, and let the normal path retry (it sorts out why).
        pending ??= value;
        clearTimeout(timer);
        timer = setTimeout(() => void flush(), 5000);
      });
  };

  const onHide = () => {
    if (document.visibilityState === 'hidden') lastChance();
  };
  const onPageHide = () => lastChance();
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
      if (res && res.status === 409) {
        throw new Error('This link does not match the request registered under its id, so answers cannot be sent. Ask its sender for a fresh link.');
      }
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
      onState({ kind: 'pending' });
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
