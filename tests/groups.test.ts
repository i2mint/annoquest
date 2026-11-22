import { describe, expect, it } from 'vitest';
import { diffResponses, exportLog, exportMarkdown, foldBatches, groupThreads, mergeResponses, OWNER_KEY, Responses, type EventBatch, type Extra } from '../src/index';

const x = (id: string, comment: string, at: string, parent?: string): Extra => ({ id, doc: 'page', target: { quote: { exact: 'Hello' } }, comment, at, rev: 0, ...(parent ? { parent } : {}) });
let n = 0;
const ev = (at: string, e: Record<string, unknown>) => ({ id: `e${n++}`, session: 's', seq: n, at, ...e });
const b = (reader: string, events: unknown[], extra: Partial<EventBatch> = {}): EventBatch =>
  ({ schema: 'annoquest/events', request: 'r1', reader, device: `dev-${reader}`, events, ...extra }) as EventBatch;

describe('review groups', () => {
  const batches = [
    b('ann', [ev('2026-11-01T10:00:00Z', { type: 'extra', extra: x('a1', 'Unclear', '2026-11-01T10:00:00Z') })]),
    b('bo', [
      ev('2026-11-01T10:01:00Z', { type: 'extra', extra: x('b1', 'Agreed', '2026-11-01T10:01:00Z', 'a1') }),
      ev('2026-11-01T10:02:00Z', { type: 'extra', extra: x('b2', 'Typo here', '2026-11-01T10:02:00Z') }),
      // Bo cannot resolve Ann's comment: not its author, not the owner.
      ev('2026-11-01T10:03:00Z', { type: 'resolve', extra: 'a1', resolved: true }),
    ]),
    b('ann', [ev('2026-11-01T10:04:00Z', { type: 'extra', extra: x('a2', 'Yes, will fix', '2026-11-01T10:04:00Z', 'b1') })]),
    // Bo resolves his own comment, then the owner resolves Ann's.
    b('bo', [ev('2026-11-01T10:05:00Z', { type: 'resolve', extra: 'b2', resolved: true })]),
    b('owner', [ev('2026-11-01T10:06:00Z', { type: 'resolve', extra: 'a1', resolved: true })], { role: 'owner', device: 'owner' }),
  ];

  it('threads replies under the comment they answer, nested replies flattened', () => {
    const threads = groupThreads(foldBatches('r1', batches));
    expect(threads.map((t) => [t.root.extra.id, t.replies.map((r) => r.extra.id)])).toEqual([
      ['a1', ['b1', 'a2']],
      ['b2', []],
    ]);
  });

  it('counts a resolve only from the author or the owner, the latest winning', () => {
    const [a1, b2] = groupThreads(foldBatches('r1', batches));
    expect(a1!.resolution).toMatchObject({ resolved: true, by: OWNER_KEY });
    expect(b2!.resolution).toMatchObject({ resolved: true, by: 'bo' });
    const withoutOwner = groupThreads(foldBatches('r1', batches.slice(0, 4)));
    expect(withoutOwner[0]!.resolution).toBeUndefined(); // Bo's resolve of Ann's comment is ignored
    const reopened = [...batches, b('ann', [ev('2026-11-01T10:07:00Z', { type: 'resolve', extra: 'a1', resolved: false })])];
    expect(groupThreads(foldBatches('r1', reopened))[0]!.resolution).toMatchObject({ resolved: false, by: 'ann' });
  });

  it('keeps the owner apart from a reader named owner', () => {
    const logs = foldBatches('r1', [...batches, b('owner', [ev('2026-11-01T10:08:00Z', { type: 'resolve', extra: 'b2', resolved: false })])]);
    // The reader called "owner" is not the owner: its reopen of Bo's comment does not count.
    expect(groupThreads(logs).find((t) => t.root.extra.id === 'b2')!.resolution?.resolved).toBe(true);
  });

  it('round-trips a resolve through the viewer diff and merge', () => {
    const before = Responses.parse({ request: 'r1', updatedAt: '' });
    const after = { ...before, resolutions: { a1: { resolved: true, at: '2026-11-01T10:00:00Z' } } };
    expect(diffResponses(before, after)).toEqual([{ type: 'resolve', extra: 'a1', resolved: true, at: '2026-11-01T10:00:00Z' }]);
    const later = { ...before, resolutions: { a1: { resolved: false, at: '2026-11-01T11:00:00Z' } } };
    expect(mergeResponses(after, later).resolutions!.a1!.resolved).toBe(false);
    expect(mergeResponses(before, before)).not.toHaveProperty('resolutions');
  });

  it('renders threads in the markdown export', () => {
    const md = exportMarkdown(exportLog(batches, { requestId: 'r1' }));
    expect(md).toContain('## Discussion');
    expect(md).toMatch(/\*\*ann\*\*: Unclear \(resolved by the owner\)\n {2}- \*\*bo\*\*: Agreed\n {2}- \*\*ann\*\*: Yes, will fix/);
  });
});
