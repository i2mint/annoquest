import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';
import {
  analytics,
  contentRequest,
  contentRequestId,
  createRequest,
  describeQuote,
  diffResponses,
  exportLog,
  exportMarkdown,
  findQuote,
  foldBatches,
  foldResponses,
  indexText,
  mergeResponses,
  originalUrl,
  pageKey,
  proxyUrl,
  Responses,
  type Event,
  type EventBatch,
  type EventInput,
} from '../src/index';

let n = 0;
/** Stamp event inputs the way the viewer's sink does. */
const stamp = (session: string, start: number, inputs: EventInput[]): Event[] =>
  inputs.map((e, i) => ({ ...e, id: `e${n++}`, session, seq: i, at: e.at ?? new Date(start + i * 1000).toISOString() }) as Event);
const batch = (events: Event[], over: Partial<EventBatch> = {}): EventBatch => ({ schema: 'annoquest/events', request: 'c-r', reader: 'ann', device: 'dev1', events, ...over });

const blank = (at = '2026-10-19T10:00:00.000Z') => Responses.parse({ request: 'c-r', updatedAt: at });

describe('the event log', () => {
  it('rebuilds the final state from the events alone, after an edit in a later session', () => {
    const r0 = blank();
    const r1 = structuredClone(r0);
    r1.extras.push({ id: 'x1', doc: 'page', url: 'https://e.org/a', target: { quote: { exact: 'Hello', occurrence: 2 } }, comment: 'first', at: '2026-10-19T10:00:01.000Z', rev: 0 });
    r1.answers.q = { value: 'agree', at: '2026-10-19T10:00:02.000Z', rev: 1 };
    const s1 = stamp('s1', Date.parse('2026-10-19T10:00:00Z'), diffResponses(r0, r1));
    // A reload: the viewer holds r1 again (from the device or the server), then the comment is edited.
    const r2 = structuredClone(r1);
    r2.extras[0] = { ...r2.extras[0]!, comment: 'edited', at: '2026-10-19T11:00:00.000Z', rev: 1 };
    r2.extras.push({ id: 'x2', doc: 'page', target: { quote: { exact: 'gone' } }, comment: 'oops', at: '2026-10-19T11:00:01.000Z', rev: 0 });
    const s2 = stamp('s2', Date.parse('2026-10-19T11:00:00Z'), diffResponses(r1, r2));
    const r3 = structuredClone(r2);
    r3.extras = r3.extras.filter((x) => x.id !== 'x2');
    r3.removed = ['x2'];
    const s3 = stamp('s3', Date.parse('2026-10-19T11:00:05Z'), diffResponses(r2, r3));
    expect(s2.map((e) => e.type)).toEqual(['extra', 'extra']);
    expect(s3.map((e) => e.type)).toEqual(['remove']);
    // Delivered out of order, one batch twice: the fold does not care.
    const [log] = foldBatches('c-r', [batch(s3), batch(s2), batch(s1), batch(s2)]);
    expect(log!.responses.extras).toEqual([r3.extras[0]]);
    expect(log!.responses.extras[0]!.comment).toBe('edited');
    expect(log!.responses.answers.q!.value).toBe('agree');
    expect(log!.responses.removed).toEqual(['x2']);
  });

  it('diffs only what changed', () => {
    const a = blank();
    a.answers.q = { value: 'agree', at: 't1', rev: 1 };
    expect(diffResponses(a, a)).toEqual([]);
    const b = structuredClone(a);
    b.reader.name = 'Ann';
    b.finishedAt = 't2';
    expect(diffResponses(a, b).map((e) => e.type)).toEqual(['name', 'finish']);
    expect(diffResponses(null, a).map((e) => e.type)).toEqual(['answer']);
  });

  it('keeps readers apart, and a signed-in identity over the declared one', () => {
    const e = stamp('s', 0, [{ type: 'view', url: 'u' }]);
    const logs = foldBatches('c-r', [batch(e), batch(stamp('t', 0, [{ type: 'view', url: 'u' }]), { reader: 'bo', device: 'dev2' }), batch(stamp('v', 0, [{ type: 'open' }]), { reader: 'x', by: 'Sam@Example.org' })]);
    expect(logs.map((l) => l.reader).sort()).toEqual(['ann', 'bo', 'sam@example.org']);
  });

  it('merges an edited extra by rev', () => {
    const a = blank();
    a.extras = [{ id: 'x', doc: 'd', target: {}, comment: 'old', at: '2026-01-02', rev: 0 }];
    const b = blank();
    b.extras = [{ id: 'x', doc: 'd', target: {}, comment: 'new', at: '2026-01-01', rev: 1 }];
    expect(mergeResponses(a, b).extras[0]!.comment).toBe('new');
    expect(mergeResponses(b, a).extras[0]!.comment).toBe('new');
  });
});

describe('reading analytics', () => {
  const T = Date.parse('2026-10-19T10:00:00Z');
  const at = (s: number) => new Date(T + s * 1000).toISOString();
  it('counts time on screen per page, caps gaps, skips hidden time, and keeps the furthest scroll', () => {
    const events = stamp('s1', T, [
      { type: 'open', at: at(0) },
      { type: 'view', url: 'A', title: 'Page A', at: at(0) },
      { type: 'beat', url: 'A', active: true, depth: 0.3, at: at(15) },
      { type: 'beat', url: 'A', active: false, depth: 0.2, at: at(30) },
      { type: 'view', url: 'B', at: at(40) },
      { type: 'visibility', state: 'hidden', at: at(50) },
      { type: 'visibility', state: 'visible', at: at(600) },
      { type: 'beat', url: 'B', active: true, at: at(700) }, // a 100 s gap counts 45 s
    ]);
    const a = analytics(events);
    const [A, B] = a.pages;
    expect(A).toMatchObject({ url: 'A', title: 'Page A', views: 1, dwellMs: 40_000, activeMs: 25_000, depth: 0.3 });
    expect(B).toMatchObject({ url: 'B', views: 1, dwellMs: 10_000 + 45_000, activeMs: 45_000 });
    expect(a.dwellMs).toBe(95_000);
    expect(a.path.map((p) => p.url)).toEqual(['A', 'B']);
    expect(a.sessions).toHaveLength(1);
  });

  it('exports state and analytics, as JSON and Markdown', () => {
    const events = stamp('s1', T, [
      { type: 'view', url: 'https://e.org/a', title: 'A', at: at(0) },
      { type: 'extra', extra: { id: 'x', doc: 'page', url: 'https://e.org/a', target: { quote: { exact: 'the | pipe', occurrence: 2 } }, comment: 'hm', at: at(5), rev: 0 }, at: at(5) },
      { type: 'beat', url: 'https://e.org/a', active: true, depth: 0.5, at: at(15) },
    ]);
    const x = exportLog([batch(events)]);
    expect(x.readers[0]!.analytics.pages[0]!.dwellMs).toBe(15_000);
    const md = exportMarkdown(x);
    expect(md).toContain('| https://e.org/a | “the | pipe” | 2 | hm |');
    expect(md).toContain('| A — https://e.org/a | 1 | 15 s | 15 s | 50% |');
  });
});

describe('anchors with an occurrence', () => {
  const doc = parseHTML('<html><body><p>alpha beta</p><p>alpha beta</p><p>alpha beta</p></body></html>').document as unknown as Document;
  const idx = indexText(doc.body);
  it('records which match a selection is, and uses it when the context cannot choose', () => {
    const second = idx.text.indexOf('alpha', 1);
    const q = describeQuote(idx, second, second + 5);
    expect(q.occurrence).toBe(2);
    const r = findQuote(idx, q);
    expect(r.ok && r.match.start).toBe(second);
    const third = idx.text.lastIndexOf('alpha');
    const bare = findQuote(idx, { exact: 'alpha beta', occurrence: 3 });
    expect(bare.ok && bare.match.start).toBe(third);
    expect(findQuote(idx, { exact: 'alpha beta' }).ok).toBe(false);
  });
});

describe('content links', () => {
  it('derive the request id the server derives', async () => {
    // tests_py/test_freeform.py asserts the same value for the same input.
    expect(await contentRequestId('https://example.org/a', 'tok')).toBe('c-x8Tyt-0v08NNPHh33Ffl-a');
  });

  it('frame a same-origin page directly (with its scripts) and any other through the proxy', async () => {
    const here = await contentRequest({ url: '/cosmo/#/', token: 't', api: '/api/aq', viewer: 'https://site.test/annoquest/?content=x' });
    expect(here.documents[0]!.source).toEqual({ kind: 'url', url: 'https://site.test/cosmo/#/', scripts: true });
    expect(here.items).toEqual([]);
    expect(here.track && here.allowExtra).toBe(true);
    expect(here.content).toEqual({ url: 'https://site.test/cosmo/#/', token: 't' });
    const there = await contentRequest({ url: 'https://e.org/p', token: 't', api: '/api/aq', viewer: 'https://site.test/annoquest/' });
    expect(there.documents[0]!.source).toEqual({ kind: 'url', url: proxyUrl('/api/aq', 'https://e.org/p', 't') });
    expect(originalUrl(proxyUrl('/api/aq', 'https://e.org/p?x=1', 't'), 'https://site.test/')).toBe('https://e.org/p?x=1');
  });

  it('count in-app routes as pages, and in-page anchors as the same page', () => {
    expect(pageKey('https://s/c/#/theme/1')).toBe('https://s/c/#/theme/1');
    expect(pageKey('https://s/doc.html#section-2')).toBe('https://s/doc.html');
  });

  it('allow a request with no items', () => {
    const r = createRequest({ title: 'Free', documents: [{ id: 'd', source: { kind: 'url', url: 'x' } }], items: [] });
    expect(r.items).toEqual([]);
    expect(foldResponses(r.id, []).extras).toEqual([]);
  });
});
