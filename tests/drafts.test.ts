import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDrafts, guardUnload, slotOf, type DraftValue } from '../viewer/drafts';

/** A Storage with just what drafts use. */
function memory(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
  } as Storage;
}

const target = { quote: { exact: 'a passage' } } as never;
const fresh: DraftValue = { kind: 'new', doc: 'd', target, text: 'a passage', comment: 'half a thought' };
const edit: DraftValue = { kind: 'edit', id: 'x1', comment: 'edited' };
const scope = { request: 'r1', reader: 'thor-test' };

describe('comment drafts', () => {
  afterEach(() => vi.useRealTimers());

  it('writes after a pause and restores on the next page load', () => {
    vi.useFakeTimers();
    const store = memory();
    const a = createDrafts(scope, { storage: () => store, delay: 100 });
    a.set(slotOf(fresh), fresh);
    a.set(slotOf(edit), edit);
    expect(a.all()).toEqual([]); // not written yet
    vi.advanceTimersByTime(100);
    const b = createDrafts(scope, { storage: () => store }); // a reload
    expect(b.all()).toHaveLength(2);
    expect(b.get('new')).toEqual(fresh);
    expect(b.get('edit:x1')).toEqual(edit);
  });

  it('keeps only the latest keystrokes (debounced)', () => {
    vi.useFakeTimers();
    const store = memory();
    const d = createDrafts(scope, { storage: () => store, delay: 100 });
    d.set('new', { ...fresh, comment: 'h' });
    vi.advanceTimersByTime(50);
    d.set('new', { ...fresh, comment: 'he' });
    vi.advanceTimersByTime(100);
    expect((d.get('new') as { comment: string }).comment).toBe('he');
  });

  it('clears on save or cancel, and a cleared draft is not written late', () => {
    vi.useFakeTimers();
    const store = memory();
    const d = createDrafts(scope, { storage: () => store, delay: 100 });
    d.set('new', fresh);
    vi.advanceTimersByTime(100);
    d.set('new', fresh);
    d.set('new', null);
    vi.advanceTimersByTime(500);
    expect(d.get('new')).toBeUndefined();
    expect(d.unsaved).toBe(false);
  });

  it('is scoped by request and reader', () => {
    vi.useFakeTimers();
    const store = memory();
    createDrafts(scope, { storage: () => store, delay: 1 }).set('new', fresh);
    vi.advanceTimersByTime(5);
    expect(createDrafts({ ...scope, reader: 'other' }, { storage: () => store }).all()).toEqual([]);
    expect(createDrafts({ ...scope, request: 'r2' }, { storage: () => store }).all()).toEqual([]);
  });

  it('survives storage that refuses', () => {
    vi.useFakeTimers();
    const refuse = () => {
      throw new Error('denied');
    };
    const d = createDrafts(scope, { storage: refuse, delay: 1 });
    d.set('new', fresh);
    vi.advanceTimersByTime(5);
    expect(d.all()).toEqual([]);
    expect(d.unsaved).toBe(true);
  });

  it('asks before leaving with an open draft, and writes what is waiting', () => {
    vi.useFakeTimers();
    const store = memory();
    const d = createDrafts(scope, { storage: () => store, delay: 10_000 });
    const handlers: Record<string, (e: Event) => void> = {};
    const win = { addEventListener: (t: string, f: (e: Event) => void) => void (handlers[t] = f), removeEventListener: () => {} };
    guardUnload(d, win);
    const quiet = { preventDefault: vi.fn(), returnValue: undefined as unknown } as unknown as BeforeUnloadEvent;
    handlers.beforeunload!(quiet);
    expect(quiet.preventDefault).not.toHaveBeenCalled(); // nothing open: leave freely

    d.set('new', fresh);
    const ev = { preventDefault: vi.fn(), returnValue: undefined as unknown } as unknown as BeforeUnloadEvent;
    handlers.beforeunload!(ev);
    expect(ev.preventDefault).toHaveBeenCalled();
    expect(createDrafts(scope, { storage: () => store }).get('new')).toEqual(fresh); // flushed at once

    d.set('new', null);
    const after = { preventDefault: vi.fn() } as unknown as BeforeUnloadEvent;
    handlers.beforeunload!(after);
    expect(after.preventDefault).not.toHaveBeenCalled(); // saved: leave freely
  });
});
