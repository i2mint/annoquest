/**
 * Keeping answers: on the device first (every change), then at the sink.
 *
 * Client storage is a zodal `DataProvider` (seam 3; localStorage by default).
 * The sink (seam 4) is `local` (nothing leaves the device until the reader
 * sends a reply link) or `http`: every change and page view is an event
 * (src/events.ts), stamped and put in an outbox kept in this browser, then
 * posted in small batches (debounced, sent with `keepalive` on `pagehide` /
 * hidden, retried with backoff, paused on 401 until the reader signs in
 * again). An event leaves the outbox only once the server has stored it, and a
 * resend is harmless (events have ids), so nothing is lost by closing the tab.
 */
import type { DataProvider } from '@zodal/store';
import { createLocalStorageProvider } from '@zodal/store-localstorage';
import { mergeResponses } from '../src/collect';
import { foldBatches, parseBatches } from '../src/events';
import { newId } from '../src/request';
import type { Event, EventBatch, EventInput, Person, Request, Responses } from '../src/spec';

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
  /** Register the request (PUT). 409: a version the server does not hold (a new one, if you are its sender). */
  register(request: Request): Promise<{ status: number }>;
  /** The latest revision the server holds. */
  latest(): Promise<Request | undefined>;
  /** This reader's state as the server holds it: their events (this device's, without a gateway) folded. */
  mine(): Promise<Responses | undefined>;
  /** Who is sending: set once the reader is known, before the first push. */
  identify(who: { reader: string; person?: Person }): void;
  /** Queue events; they are sent shortly. `quiet` ones (page views, beats) do not change the save state. */
  push(events: EventInput[], opts?: { quiet?: boolean }): void;
  flush(opts?: { keepalive?: boolean }): Promise<void>;
  dispose(): void;
}

const JSON_HEADERS = { Accept: 'application/json', 'Content-Type': 'application/json' };
/** Events per post: keeps each post far below the server's cap and the 64 KB keepalive limit. */
const BATCH = 100;
const QUIET = new Set(['open', 'view', 'visibility', 'beat']);

/** The sink a request asks for (seam 4): null for `local`. Add a sink kind here, nowhere else. */
export function makeSink(request: Request, onState: (s: SinkState) => void, opts: SinkOptions): HttpSink | null {
  switch (request.sink.kind) {
    case 'http':
      return createHttpSink(request.sink.url, request.id, onState, opts);
    default:
      return null;
  }
}

export interface SinkOptions {
  device: string;
  delay?: number;
  maxBackoff?: number;
  /** Where unsent events are kept between page loads (default: localStorage). */
  outboxStorage?: () => Storage;
}

export function createHttpSink(
  base: string,
  requestId: string,
  onState: (s: SinkState) => void,
  { device, delay = 1500, maxBackoff = 60000, outboxStorage = () => localStorage }: SinkOptions,
): HttpSink {
  const api = base.replace(/\/$/, '');
  const at = (p: string) => `${api}${p}`;
  const session = newId(9);
  let seq = 0;
  let who: { reader: string; person?: Person } = { reader: device };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let backoff = 0;
  let inFlight: Promise<void> | null = null;
  let authBlocked = false;

  // The outbox: every event not yet stored by the server, kept across reloads.
  const boxKey = `annoquest:outbox:${requestId}:${device}`;
  type Boxed = { reader: string; person?: Person; event: Event };
  let outbox: Boxed[] = (() => {
    try {
      return JSON.parse(outboxStorage().getItem(boxKey) ?? '[]') as Boxed[];
    } catch {
      return [];
    }
  })();
  const keep = () => {
    try {
      if (outbox.length) outboxStorage().setItem(boxKey, JSON.stringify(outbox));
      else outboxStorage().removeItem(boxKey);
    } catch {
      /* storage refused: the outbox lasts for this page load */
    }
  };
  const loud = () => outbox.some((b) => !QUIET.has(b.event.type));

  const retry = (state: SinkState) => {
    backoff = Math.min(maxBackoff, backoff ? backoff * 2 : 5000);
    if (loud()) onState(state.kind === 'offline' ? { kind: 'offline', retryIn: backoff } : state);
    clearTimeout(timer);
    timer = setTimeout(() => void flush(), backoff);
  };

  /** The next post: the oldest events of one reader (a link opened under two names keeps them apart). */
  const nextBatch = (): { batch: EventBatch; ids: Set<string> } | null => {
    if (!outbox.length) return null;
    const first = outbox[0]!;
    const take = outbox.filter((b) => b.reader === first.reader).slice(0, BATCH);
    return {
      batch: { schema: 'annoquest/events', request: requestId, reader: first.reader, device, person: first.person, events: take.map((b) => b.event) },
      ids: new Set(take.map((b) => b.event.id)),
    };
  };
  const stored = (ids: Set<string>) => {
    outbox = outbox.filter((b) => !ids.has(b.event.id));
    keep();
  };
  const post = (batch: EventBatch, keepalive: boolean) => {
    const body = JSON.stringify(batch);
    return fetch(at(`/requests/${encodeURIComponent(requestId)}/events`), {
      method: 'POST',
      headers: JSON_HEADERS,
      body,
      credentials: 'same-origin',
      // Browsers cap keepalive bodies at 64 KB; above that a normal request is the better bet.
      keepalive: keepalive && body.length < 60000,
    });
  };

  const send = async (keepalive = false) => {
    const next = nextBatch();
    if (!next) return;
    const wasLoud = next.batch.events.some((e) => !QUIET.has(e.type));
    if (wasLoud) onState({ kind: 'saving' });
    try {
      const res = await post(next.batch, keepalive);
      const json = res.headers.get('content-type')?.includes('json') ? await res.json().catch(() => null) : null;
      if (res.status === 401 || (res.ok && !json?.saved)) {
        // 401, or a gateway's login page answering 200: the session is gone.
        authBlocked = true;
        onState({ kind: 'auth' });
        return;
      }
      if (res.status === 404) return retry({ kind: 'waiting' }); // not registered yet: keep trying, slowly
      if (res.status >= 400 && res.status < 500) {
        onState({ kind: 'error', message: `Your answers are saved here, but the server refused them (${json?.detail ?? res.status}).` });
        return;
      }
      if (!res.ok) throw new Error(`The server answered ${res.status}.`);
      stored(next.ids);
      backoff = 0;
      authBlocked = false;
      if (outbox.length) {
        if (loud()) onState({ kind: 'pending' });
        return send(keepalive);
      }
      if (wasLoud) onState({ kind: 'sent', at: new Date().toISOString() });
    } catch (e) {
      retry({ kind: 'offline', retryIn: 0 });
      if (!(e instanceof TypeError)) console.warn('[annoquest] submit failed:', e);
    }
  };

  const flush = ({ keepalive = false } = {}): Promise<void> => {
    clearTimeout(timer);
    timer = undefined;
    const next = (inFlight ?? Promise.resolve()).then(() => send(keepalive));
    inFlight = next.finally(() => {
      if (inFlight === next) inFlight = null;
    });
    return next;
  };

  /** Last chance (page hidden or closing): post what is waiting now, with keepalive. Kept until stored. */
  const lastChance = () => {
    clearTimeout(timer);
    timer = undefined;
    const next = nextBatch();
    if (!next || authBlocked) return;
    void post(next.batch, true)
      .then(async (res) => {
        const json = res.headers.get('content-type')?.includes('json') ? await res.json().catch(() => null) : null;
        if (!res.ok || !json?.saved) throw new Error(String(res.status));
        stored(next.ids);
        if (!outbox.length && next.batch.events.some((e) => !QUIET.has(e.type))) onState({ kind: 'sent', at: new Date().toISOString() });
      })
      .catch(() => {
        // Not stored after all: still in the outbox; the normal path retries (and sorts out why).
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

  const getJson = async (path: string) => {
    try {
      const res = await fetch(at(path), { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
      return res.ok ? await res.json() : undefined;
    } catch {
      return undefined;
    }
  };

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
      return { status: res?.status ?? 0 };
    },
    async latest() {
      return (await getJson(`/requests/${encodeURIComponent(requestId)}`)) as Request | undefined;
    },
    async mine() {
      const rid = encodeURIComponent(requestId);
      // Whole-document saves (before the event log) exist only behind a sign-in: ask for them only there.
      const [logged, legacy] = await Promise.all([
        getJson(`/requests/${rid}/events/mine?device=${encodeURIComponent(device)}`),
        who.person?.email ? getJson(`/requests/${rid}/responses/mine`) : undefined,
      ]);
      const { batches } = parseBatches((logged?.batches as unknown[]) ?? []);
      // Every batch here is this reader's (this device's, or this signed-in user's): fold them as one.
      const one = batches.map((b) => ({ ...b, reader: who.reader, by: undefined }));
      const folded = one.length ? foldBatches(requestId, one)[0]?.responses : undefined;
      // Answers saved as whole documents (before the event log) still count.
      const old = legacy && typeof legacy === 'object' && 'answers' in legacy ? (legacy as Responses) : undefined;
      if (folded && old) return mergeResponses(folded, old);
      return folded ?? old;
    },
    identify(w) {
      who = w;
    },
    push(events, { quiet } = {}) {
      if (!events.length) return;
      const now = new Date().toISOString();
      for (const e of events) outbox.push({ reader: who.reader, person: who.person, event: { ...e, id: newId(9), session, seq: seq++, at: e.at ?? now } as Event });
      keep();
      if (authBlocked) return;
      const isQuiet = quiet ?? events.every((e) => QUIET.has(e.type));
      if (!isQuiet) onState({ kind: 'pending' });
      // A change goes soon; page views and beats ride along, or go within a few seconds of each other.
      const wait = isQuiet ? Math.max(delay, 5000) : delay;
      if (timer === undefined || !isQuiet) {
        clearTimeout(timer);
        timer = setTimeout(() => void flush(), wait);
      }
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
