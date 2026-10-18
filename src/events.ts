/**
 * The event log: what the viewer sends as things happen, and the pure fold that
 * rebuilds everything from it.
 *
 * `answer` and `extra` events carry whole records, so the fold needs no history
 * beyond the events: per answer and per extra the highest `(rev, at)` wins,
 * removals are tombstones, a resent event (same id) counts once. The same fold
 * gives the reading analytics: per page, the views, the time on screen (each gap
 * capped, so a tab left open does not read as an hour of reading), the part of
 * it with interaction, and the furthest scroll.
 *
 * `diffResponses` goes the other way: the events that take one `Responses` to
 * another, which is how the viewer decides what to send without the UI code
 * knowing about events at all.
 */
import { EventBatch, Responses, type Answer, type Event, type EventInput, type Extra, type Person, type Request } from './spec';

/** The longest gap between two events that still counts as time on the page. */
export const DWELL_CAP_MS = 45_000;
/** How often the viewer sends a `beat` while the page is visible. */
export const BEAT_MS = 15_000;

export interface PageStats {
  url: string;
  title?: string;
  views: number;
  firstAt: string;
  lastAt: string;
  /** On screen, tab visible. */
  dwellMs: number;
  /** The part of `dwellMs` with interaction (scroll, pointer, keys). */
  activeMs: number;
  /** Furthest scroll, 0–1. */
  depth?: number;
}

export interface Analytics {
  sessions: Array<{ session: string; device: string; start: string; end: string; dwellMs: number }>;
  firstAt?: string;
  lastAt?: string;
  dwellMs: number;
  activeMs: number;
  pages: PageStats[];
  /** Every page view, in order. */
  path: Array<{ at: string; url: string; title?: string; session: string }>;
}

export interface ReaderLog {
  reader: string;
  person?: Person;
  devices: string[];
  responses: Responses;
  analytics: Analytics;
}

const later = (a: { rev?: number; at: string }, b: { rev?: number; at: string }) => (b.rev ?? 0) > (a.rev ?? 0) || ((b.rev ?? 0) === (a.rev ?? 0) && b.at > a.at);

/** Parse event batches from anything JSON-ish (a server record `{events…, by}` keeps its `by`). */
export function parseBatches(values: unknown[], request?: Pick<Request, 'id'>) {
  const ok: EventBatch[] = [];
  const rejected: Array<{ index: number; reason: string }> = [];
  values.forEach((v, index) => {
    const p = EventBatch.safeParse(v);
    if (!p.success) return rejected.push({ index, reason: p.error.issues[0]?.message ?? 'not an event batch' });
    if (request && p.data.request !== request.id) return rejected.push({ index, reason: `belongs to request ${p.data.request}` });
    ok.push(p.data);
  });
  return { batches: ok, rejected };
}

export const isBatch = (v: unknown) => !!v && typeof v === 'object' && (v as { schema?: unknown }).schema === 'annoquest/events';

/** Who a batch is from: the server-asserted identity first, then the reader key it declares. */
export const batchReader = (b: EventBatch) => b.by?.toLowerCase() ?? b.reader;

/** One reader's state from their events alone (any number of devices and sessions). */
export function foldResponses(request: string, events: Event[], { person }: { person?: Person } = {}): Responses {
  const r = Responses.parse({ request, reader: person ?? {}, updatedAt: '' });
  const extras = new Map<string, Extra>();
  const removed = new Set<string>();
  let nameAt = '';
  for (const e of events) {
    if (e.type === 'answer') {
      const cur = r.answers[e.item];
      if (!cur || later(cur, e.answer)) r.answers[e.item] = e.answer;
    } else if (e.type === 'extra') {
      const cur = extras.get(e.extra.id);
      if (!cur || later(cur, e.extra)) extras.set(e.extra.id, e.extra);
    } else if (e.type === 'remove') removed.add(e.extra);
    else if (e.type === 'name' && e.at >= nameAt) {
      nameAt = e.at;
      r.reader = { ...r.reader, name: e.name || undefined };
    } else if (e.type === 'finish' && (!r.finishedAt || e.at < r.finishedAt)) r.finishedAt = e.at;
    else continue;
    if (e.at > r.updatedAt) r.updatedAt = e.at;
  }
  r.extras = [...extras.values()].filter((x) => !removed.has(x.id)).sort((a, b) => (a.at < b.at ? -1 : 1));
  r.removed = [...removed].sort();
  return r;
}

/** Reading analytics from one reader's events (`device` per event, for the session list). */
export function analytics(events: Array<Event & { device?: string }>, { cap = DWELL_CAP_MS } = {}): Analytics {
  const pages = new Map<string, PageStats>();
  const page = (url: string, at: string) => {
    let p = pages.get(url);
    if (!p) pages.set(url, (p = { url, views: 0, firstAt: at, lastAt: at, dwellMs: 0, activeMs: 0 }));
    return p;
  };
  const bySession = new Map<string, typeof events>();
  for (const e of events) (bySession.get(e.session) ?? bySession.set(e.session, []).get(e.session)!).push(e);
  const out: Analytics = { sessions: [], dwellMs: 0, activeMs: 0, pages: [], path: [] };
  for (const [session, es] of bySession) {
    es.sort((a, b) => a.seq - b.seq);
    let url: string | undefined;
    let visible = true;
    let last: number | undefined;
    let dwell = 0;
    for (const e of es) {
      const t = Date.parse(e.at);
      if (last !== undefined && visible && url && t > last) {
        const gap = Math.min(t - last, cap);
        const active = e.type === 'beat' ? e.active : e.type !== 'visibility' && e.type !== 'open';
        const p = page(url, e.at);
        p.dwellMs += gap;
        dwell += gap;
        if (active) {
          p.activeMs += gap;
          out.activeMs += gap;
        }
      }
      if (e.type === 'view') {
        url = e.url;
        const p = page(url, e.at);
        p.views++;
        if (e.title) p.title = e.title;
        out.path.push({ at: e.at, url, title: e.title, session });
      } else if (e.type === 'visibility') visible = e.state === 'visible';
      else if (e.type === 'beat') {
        if (e.url) url = e.url;
        if (url && e.depth !== undefined) {
          const p = page(url, e.at);
          p.depth = Math.max(p.depth ?? 0, e.depth);
        }
      }
      if (url && pages.has(url)) {
        const p = pages.get(url)!;
        if (e.at > p.lastAt) p.lastAt = e.at;
      }
      last = t;
    }
    out.dwellMs += dwell;
    out.sessions.push({ session, device: es[0]?.device ?? '', start: es[0]!.at, end: es[es.length - 1]!.at, dwellMs: dwell });
  }
  out.sessions.sort((a, b) => (a.start < b.start ? -1 : 1));
  out.path.sort((a, b) => (a.at < b.at ? -1 : 1));
  out.pages = [...pages.values()].sort((a, b) => (a.firstAt < b.firstAt ? -1 : 1));
  out.firstAt = out.sessions[0]?.start;
  out.lastAt = out.sessions.reduce<string | undefined>((m, s) => (!m || s.end > m ? s.end : m), undefined);
  return out;
}

/** Every reader's final state and analytics, from event batches (any order, resends included). */
export function foldBatches(request: string, batches: EventBatch[]): ReaderLog[] {
  const readers = new Map<string, { person?: Person; devices: Set<string>; events: Map<string, Event & { device: string }> }>();
  for (const b of batches) {
    if (b.request !== request) continue;
    const k = batchReader(b);
    const r = readers.get(k) ?? readers.set(k, { devices: new Set(), events: new Map() }).get(k)!;
    r.devices.add(b.device);
    if (b.person && (b.person.name || b.person.email || b.person.id)) r.person = { ...r.person, ...b.person };
    for (const e of b.events) if (!r.events.has(e.id)) r.events.set(e.id, { ...e, device: b.device });
  }
  return [...readers].map(([reader, r]) => {
    const events = [...r.events.values()].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.seq - b.seq));
    const person = { ...r.person, id: r.person?.id ?? reader };
    const responses = foldResponses(request, events, { person });
    const by = batches.find((b) => batchReader(b) === reader && b.by)?.by;
    return { reader, person: responses.reader, devices: [...r.devices], responses: by ? { ...responses, by } : responses, analytics: analytics(events) };
  });
}

/** The events that take `prev` to `next` (what changed: answers, extras, removals, the name, finishing). */
export function diffResponses(prev: Responses | null | undefined, next: Responses): EventInput[] {
  const out: EventInput[] = [];
  for (const [item, a] of Object.entries(next.answers)) {
    const p = prev?.answers[item];
    if (!p || p.rev !== a.rev || p.at !== a.at) out.push({ type: 'answer', item, answer: a as Answer, at: a.at });
  }
  const before = new Map((prev?.extras ?? []).map((x) => [x.id, x]));
  for (const x of next.extras) {
    const p = before.get(x.id);
    if (!p || (p.rev ?? 0) !== (x.rev ?? 0) || p.comment !== x.comment || p.at !== x.at) out.push({ type: 'extra', extra: x, at: x.at });
  }
  const gone = new Set(prev?.removed ?? []);
  for (const id of next.removed ?? []) if (!gone.has(id)) out.push({ type: 'remove', extra: id });
  if ((next.reader.name ?? '') !== (prev?.reader.name ?? '') && next.reader.name !== undefined) out.push({ type: 'name', name: next.reader.name });
  if (next.finishedAt && !prev?.finishedAt) out.push({ type: 'finish', at: next.finishedAt });
  return out;
}

// ---- export -----------------------------------------------------------------

export interface Export {
  request: string;
  title?: string;
  readers: ReaderLog[];
}

/** Everything from a request's events: per reader the final state and the reading analytics. */
export function exportLog(batches: EventBatch[], { request, requestId }: { request?: Request; requestId?: string } = {}): Export {
  const id = request?.id ?? requestId ?? batches[0]?.request ?? '';
  return { request: id, title: request?.title, readers: foldBatches(id, batches) };
}

const mins = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${(ms / 60_000).toFixed(1)} min`);
const one = (s: string) => s.replace(/\s+/g, ' ').trim();

/** The export as Markdown: for each reader, the comments, the answers, and where they read for how long. */
export function exportMarkdown(x: Export, { request }: { request?: Request } = {}): string {
  const lines: string[] = [`# ${x.title ?? request?.title ?? x.request}`, ''];
  if (!x.readers.length) lines.push('No events yet.', '');
  for (const r of x.readers) {
    const who = r.person?.name ? `${r.person.name} (${r.reader})` : r.reader;
    const a = r.analytics;
    lines.push(`## ${who}`, '');
    lines.push(`${a.sessions.length} session${a.sessions.length === 1 ? '' : 's'}, ${mins(a.dwellMs)} on the pages (${mins(a.activeMs)} active), ${a.firstAt ?? '?'} to ${a.lastAt ?? '?'}.`, '');
    const extras = r.responses.extras;
    if (extras.length) {
      lines.push('### Comments', '', '| page | passage | # | comment | at |', '|---|---|---|---|---|');
      for (const e of extras) {
        const q = e.target.quote;
        lines.push(`| ${e.url ?? e.doc} | ${q ? `“${one(q.exact).slice(0, 160)}”` : ''} | ${q?.occurrence ?? 1} | ${one(e.comment).replace(/\|/g, '\\|')} | ${e.at} |`);
      }
      lines.push('');
    }
    const answers = Object.entries(r.responses.answers);
    if (answers.length) {
      lines.push('### Answers', '');
      for (const [item, ans] of answers) {
        const it = request?.items.find((i) => i.id === item);
        const value = ans.value === undefined ? '' : ans.value === true ? '✓' : ([] as string[]).concat(ans.value).join(', ');
        lines.push(`- **${it?.title ?? item}**: ${value}${ans.comment ? ` — ${one(ans.comment)}` : ''}`);
      }
      lines.push('');
    }
    if (a.pages.length) {
      lines.push('### Pages', '', '| page | views | on screen | active | furthest scroll | first seen |', '|---|---|---|---|---|---|');
      for (const p of a.pages) lines.push(`| ${p.title ? `${one(p.title)} — ` : ''}${p.url} | ${p.views} | ${mins(p.dwellMs)} | ${mins(p.activeMs)} | ${p.depth === undefined ? '' : `${Math.round(p.depth * 100)}%`} | ${p.firstAt} |`);
      lines.push('');
    }
  }
  return lines.join('\n');
}
