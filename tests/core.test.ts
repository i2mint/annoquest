import { JSDOM } from 'jsdom';
import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';
import {
  bakeRequest,
  checkRequest,
  createRequest,
  decodePayload,
  describeQuote,
  encodePayload,
  findQuote,
  indexText,
  matchToRange,
  normalizeText,
  positionOf,
  readLink,
  replyLink,
  requestLink,
  summarize,
  parseResponses,
  parseRequest,
  mergeResponses,
  latestPerReader,
  itemHash,
  diffRequests,
  publishRevision,
  summaryMarkdown,
  toElicitation,
  type Responses,
} from '../src/index';

const HTML = `<!doctype html><html><head><title>Plan</title><style>.x{}</style></head><body>
<nav id="TOC"><a href="#goals">Goals</a></nav>
<section id="goals"><h2>Goals</h2>
<p>We will ship the pilot in two weeks. The pilot covers   three sites.</p>
<details id="risks"><summary>Risks</summary><p>The pilot may slip if the vendor is late. The pilot covers three sites.</p></details>
</section>
<section id="budget"><h2>Budget</h2><p>The budget is “fixed” at 10k — no more.</p><script>var pilot = 1</script></section>
</body></html>`;

const dom = () => parseHTML(HTML).document as unknown as Document;

const base = () =>
  createRequest({
    title: 'Plan review',
    readers: [{ id: 'ann', email: 'ann@example.org' }, { id: 'bo' }],
    documents: [{ id: 'plan', source: { kind: 'inline', html: HTML } }],
    items: [
      { title: 'Timeline', prompt: 'Is two weeks realistic?', priority: 'must', target: { section: 'goals', quote: { exact: 'ship the pilot in two weeks' } } },
      { title: 'Read the risks', prompt: 'Please read.', response: 'read', target: { section: 'risks' } },
      { title: 'Budget', prompt: 'OK with the cap?', response: 'approve', target: { quote: { exact: 'The budget is "fixed" at 10k - no more.' } } },
    ],
  });

describe('anchoring', () => {
  it('folds whitespace and typography the same way on both sides', () => {
    expect(normalizeText('  a\n\t b “c” — d  ')).toBe('a b "c" - d');
  });

  it('skips scripts, styles and navigation', () => {
    const idx = indexText(dom().body);
    expect(idx.text).not.toContain('var pilot');
    expect(idx.text).not.toMatch(/^Goals Goals/);
  });

  it('finds an exact quote and maps it back to a DOM range', () => {
    const d = new JSDOM(HTML).window.document;
    const idx = indexText(d.body);
    const r = findQuote(idx, { exact: 'covers three sites', prefix: 'The pilot ' });
    // Two occurrences, equal context: ambiguous without more context.
    expect(r.ok).toBe(false);
    const r2 = findQuote(idx, { exact: 'covers three sites', prefix: 'in two weeks. The pilot ' });
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(matchToRange(idx, r2.match, d).toString().replace(/\s+/g, ' ')).toBe('covers three sites');
  });

  it('re-anchors approximately when the text changed', () => {
    const idx = indexText(dom().body);
    const r = findQuote(idx, { exact: 'We will ship the pilot within two weeks' });
    expect(r.ok && r.match.how).toBe('fuzzy');
  });

  it('turns a selection into a unique quote', () => {
    const d = dom();
    const idx = indexText(d.body);
    const second = idx.text.lastIndexOf('covers three sites');
    const q = describeQuote(idx, second, second + 'covers three sites'.length);
    const r = findQuote(idx, q);
    expect(r.ok && r.match.start).toBe(second);
    const p = d.querySelector('#risks p')!.firstChild!;
    expect(positionOf(idx, p, 0)).toBe(idx.text.indexOf('The pilot may slip'));
  });
});

describe('requests', () => {
  it('fills ids and defaults, and refuses unknown response types', () => {
    const r = base();
    expect(r.id.length).toBeGreaterThanOrEqual(20);
    expect(r.items.map((i) => i.id)).toEqual(['timeline', 'read-the-risks', 'budget']);
    expect(r.items[1]!.priority).toBe('should');
    expect(() => createRequest({ ...r, items: [{ prompt: 'x', response: 'nope' }] })).toThrow(/does not exist/);
  });

  it('checks every anchor and records passage hashes', () => {
    const report = checkRequest(base(), { plan: dom() });
    expect(report.ok).toBe(true);
    expect(report.items.map((i) => i.how)).toEqual(['exact', 'section', 'exact']);
    expect(report.request.items[0]!.passageHash).toBeTruthy();
  });

  it('fails loudly on a missing passage or section', () => {
    const r = createRequest({ ...base(), items: [{ prompt: 'x', target: { section: 'nope' } }, { prompt: 'y', target: { quote: { exact: 'not in the text at all, really' } } }] });
    const report = checkRequest(r, { plan: dom() });
    expect(report.ok).toBe(false);
    expect(report.items[0]!.problem).toMatch(/no element with id "nope"/);
    expect(report.items[1]!.problem).toMatch(/not in the document/);
  });
});

describe('links and baking', () => {
  it('round-trips a request through a link', () => {
    const r = base();
    const link = requestLink(r, 'https://viewer.example/', { reader: 'ann' });
    expect(link.url).toContain('?reader=ann#r=');
    expect(readLink(link.url).request).toEqual(r);
    expect(decodePayload(encodePayload({ a: 1 }))).toEqual({ a: 1 });
  });

  it('bakes the request into the viewer, script-safe', () => {
    const r = createRequest({ ...base(), title: 'A </script> title' });
    const page = bakeRequest(r, '<html><head><title>x</title><!--annoquest:request--></head><body></body></html>');
    expect(page).toContain('<title>A &lt;/script> title</title>');
    const json = page.match(/<script type="application\/json" id="annoquest-request">(.*?)<\/script>/s)![1]!;
    expect(JSON.parse(json).title).toBe('A </script> title');
  });
});

describe('collecting', () => {
  const answer = (value: Responses['answers'][string]['value'], comment?: string) => ({ value, comment, at: '2026-10-02T10:00:00Z', rev: 1 });
  it('summarises by tone, worst first', () => {
    const req = checkRequest(base(), { plan: dom() }).request;
    const ann: Responses = {
      schema: 'annoquest/responses', version: 1, request: req.id, reader: { id: 'ann' }, by: 'ann@example.org',
      answers: { timeline: answer('agree'), 'read-the-risks': answer(true), budget: answer('changes', 'Too tight') },
      extras: [{ id: 'x1', doc: 'plan', target: { quote: { exact: 'vendor is late' } }, comment: 'Which vendor?', at: '2026-10-02T10:01:00Z' }],
      removed: [],
      updatedAt: '2026-10-02T10:02:00Z',
    };
    const bo: Responses = { ...ann, by: undefined, reader: { id: 'bo' }, answers: { timeline: answer('discuss') }, extras: [], updatedAt: '2026-10-02T09:00:00Z' };
    const s = summarize(req, [ann, bo]);
    expect(s.items.map((i) => [i.id, i.status])).toEqual([
      ['budget', 'blocked'],
      ['timeline', 'discuss'],
      ['read-the-risks', 'pending'],
    ]);
    expect(s.items[2]!.missing).toEqual(['bo']);
    expect(s.readers.find((r) => r.reader === 'ann@example.org')).toMatchObject({ answered: 3, expected: 3 });
    const md = summaryMarkdown(s);
    expect(md).toContain('1 blocked · 1 to discuss · 1 waiting');
    expect(md).toContain('Which vendor?');
    expect(readLink(replyLink(ann, 'https://v.example/?spec=x').url).responses).toEqual(ann);
  });
});

describe('elicitation', () => {
  it('turns an item into a titled-enum schema with a conditional comment', () => {
    const r = base();
    const e = toElicitation(r.items[2]!, r);
    expect(e.requestedSchema.properties.answer).toMatchObject({ type: 'string', oneOf: expect.arrayContaining([{ const: 'approve', title: 'Approve' }]) });
    expect(e.requestedSchema.properties.comment?.description).toMatch(/Changes required/);
    expect(e.message).toContain('OK with the cap?');
  });
});

describe('review fixes', () => {
  it('reads block boundaries as spaces, and scopes a heading id to its section', () => {
    const d = parseHTML('<html><body><h2 id="a">Alpha</h2><p>One end.</p><p>Next start.</p><h2 id="b">Beta</h2><p>Other.</p></body></html>').document as unknown as Document;
    const idx = indexText(d.body);
    expect(idx.text.trimEnd()).toBe('Alpha One end. Next start. Beta Other.');
    const r = createRequest({ title: 't', documents: [{ id: 'd', source: { kind: 'inline', html: '' } }], items: [{ prompt: 'p', target: { section: 'a', quote: { exact: 'end. Next' } } }, { prompt: 'q', target: { section: 'a', quote: { exact: 'Other' } } }] });
    const report = checkRequest(r, { d });
    expect(report.items[0]).toMatchObject({ ok: true, how: 'exact' });
    expect(report.items[1]!.problem).toMatch(/Found outside #a/);
  });

  it('maps an element-end boundary to the text after the element', () => {
    const d = new JSDOM('<p id="x">abc</p><p>def</p>').window.document;
    const idx = indexText(d.body);
    expect(positionOf(idx, d.getElementById('x')!, 1)).toBe(idx.text.indexOf('def'));
  });

  it('never trusts a client-claimed `by`, and requires ids when parsing', () => {
    const base = { request: 'r1', answers: {}, updatedAt: '2026-10-02T10:00:00Z' };
    const { responses } = parseResponses([{ ...base, by: 'forged@example.org' }, { responses: base, by: 'real@example.org' }]);
    expect(responses.map((r) => r.by)).toEqual([undefined, 'real@example.org']);
    expect(() => parseRequest({ title: 't', documents: [{ id: 'd', source: { kind: 'url', url: 'x' } }], items: [{ prompt: 'p' }] })).toThrow(/no id/);
  });
});

describe('re-review fixes', () => {
  const r = (over: Partial<Responses>): Responses => ({ schema: 'annoquest/responses', version: 1, request: 'r', reader: { id: 'a' }, answers: {}, extras: [], removed: [], updatedAt: '2026-10-02T10:00:00Z', ...over });
  const x = (id: string) => ({ id, doc: 'd', target: { quote: { exact: 'q' } }, comment: 'c', at: 't' });
  it('a removed comment stays removed when an older copy is merged in', () => {
    const older = r({ extras: [x('x1'), x('x2')] });
    const newer = r({ extras: [x('x2')], removed: ['x1'], updatedAt: '2026-10-02T11:00:00Z' });
    expect(mergeResponses(newer, older).extras.map((e) => e.id)).toEqual(['x2']);
    expect(mergeResponses(older, newer).extras.map((e) => e.id)).toEqual(['x2']);
  });
  it('collect folds every save of a reader, so two tabs both count', () => {
    const tabA = r({ answers: { i1: { value: 'agree', at: '2026-10-02T10:00:00Z', rev: 1 } } });
    const tabB = r({ answers: { i2: { value: 'discuss', at: '2026-10-02T10:05:00Z', rev: 1 } }, updatedAt: '2026-10-02T10:05:00Z' });
    expect(Object.keys(latestPerReader([tabA, tabB])[0]!.answers).sort()).toEqual(['i1', 'i2']);
  });
});

describe('viewer CSS', () => {
  it('never transforms the shadow-root document pane (Chrome paints it blank inside a rounded iframe)', async () => {
    const { readFileSync } = await import('node:fs');
    const css = readFileSync(new URL('../viewer/styles.css', import.meta.url), 'utf8');
    const rule = css.match(/\.doc-shadow\s*\{[^}]*\}/)![0];
    expect(rule).toContain('contain: paint');
    expect(rule).not.toMatch(/transform|will-change/);
  });
});

describe('revisions', () => {
  const v1 = () =>
    createRequest({
      id: 'rev-test-0001',
      title: 'v1',
      readers: [{ id: 'sam' }],
      documents: [{ id: 'd', source: { kind: 'url', url: 'x' } }],
      items: [
        { id: 'keep', prompt: 'Same?' },
        { id: 'reword', prompt: 'Old wording?' },
        { id: 'drop', prompt: 'Going away?' },
      ],
    });

  it('diffs a revision item by item, and refuses a changed id', () => {
    const a = v1();
    const b = createRequest({ ...a, title: 'v2', items: [a.items[0]!, { ...a.items[1]!, prompt: 'New wording?' }, { id: 'new', prompt: 'Added?' }] });
    expect(diffRequests(a, b)).toEqual({ added: ['new'], removed: ['drop'], changed: ['reword'], unchanged: 1 });
    expect(() => diffRequests(a, { ...b, id: 'another-id-1' })).toThrow(/keeps its request id/);
    expect(itemHash(a.items[0]!)).toBe(itemHash({ ...a.items[0]!, minutes: 3 } as typeof a.items[0]));
  });

  it('marks answers to changed items as updated, and keeps answers to removed ones', () => {
    const a = v1();
    const at = '2026-10-05T10:00:00Z';
    const answers = Object.fromEntries(a.items.map((i) => [i.id, { value: 'agree', at, rev: 1, itemHash: itemHash(i) }]));
    const sam: Responses = { schema: 'annoquest/responses', version: 1, request: a.id, reader: { id: 'sam' }, answers, extras: [], removed: [], updatedAt: at };
    const b = { ...createRequest({ ...a, items: [a.items[0]!, { ...a.items[1]!, prompt: 'New wording?' }] }), revision: 2 };
    const s = summarize(b, [sam]);
    expect(s.items.find((i) => i.id === 'keep')!.answers[0]!.updated).toBe(false);
    expect(s.items.find((i) => i.id === 'reword')!.answers[0]!.updated).toBe(true);
    expect(s.removed).toEqual([{ item: 'drop', reader: 'sam', value: 'agree', comment: undefined, at }]);
    const md = summaryMarkdown(s);
    expect(md).toContain('(revision 2)');
    expect(md).toContain('answered before the item was updated');
    expect(md).toContain('Answers to removed items');
  });

  it('publishes a revision through the API, with the sender\'s headers', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: 'rev-test-0001', revision: 2, created: true }), { status: 201, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const r = await publishRevision({ ...v1(), revision: 1 }, { api: 'https://host/api/', headers: { Authorization: 'Bearer t' }, fetch: fake });
    expect(r).toEqual({ revision: 2, created: true });
    expect(calls[0]!.url).toBe('https://host/api/requests/rev-test-0001/revisions');
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer t');
    expect(JSON.parse(calls[0]!.init.body as string).revision).toBeUndefined();
    const refused = (async () => new Response(JSON.stringify({ detail: 'Only the sender' }), { status: 403, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    await expect(publishRevision(v1(), { api: '/api', fetch: refused })).rejects.toThrow(/Only the sender/);
  });
});
