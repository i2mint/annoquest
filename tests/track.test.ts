import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTracker } from '../viewer/track';
import type { EventInput } from '../src/spec';

/** A window and a document just big enough for the tracker: a page `height` tall, scrolled to `scrollY`. */
function fakeFrame(height: number) {
  const listeners: Record<string, Array<() => void>> = {};
  const view = { scrollY: 0, innerHeight: 500 };
  const doc = {
    defaultView: view,
    scrollingElement: { scrollHeight: height },
    addEventListener: (t: string, f: () => void) => void (listeners[t] ??= []).push(f),
  };
  const scroll = (y: number) => {
    view.scrollY = y;
    for (const f of listeners.scroll ?? []) f();
  };
  return { doc: doc as unknown as Document, view, setHeight: (h: number) => void (doc.scrollingElement.scrollHeight = h), scroll };
}

function fakeWindow() {
  return {
    innerWidth: 1000,
    innerHeight: 800,
    document: { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} },
    addEventListener() {},
    removeEventListener() {},
    setInterval: (f: () => void, ms: number) => setInterval(f, ms),
    clearInterval: (t: ReturnType<typeof setInterval>) => clearInterval(t),
  } as unknown as Window;
}

describe('tracker', () => {
  afterEach(() => vi.useRealTimers());

  it('records scroll depth on every page of a single-page app, not only the first', () => {
    vi.useFakeTimers();
    const events: EventInput[] = [];
    const frame = fakeFrame(2000);
    const t = createTracker((e) => events.push(...e), { beat: 1000, win: fakeWindow() });
    t.page('https://x.org/app/');
    t.watch(frame.doc);
    frame.scroll(500);
    vi.advanceTimersByTime(1000);
    // An in-app route: the same document, new content, and no scroll since.
    frame.setHeight(1000);
    frame.view.scrollY = 0;
    t.page('https://x.org/app/#/theme/3');
    t.watch(frame.doc);
    vi.advanceTimersByTime(1000);
    t.page('https://x.org/app/#/');
    vi.advanceTimersByTime(1000);
    t.dispose();
    const beats = events.filter((e) => e.type === 'beat') as Array<Extract<EventInput, { type: 'beat' }>>;
    expect(beats.map((b) => [b.url, b.depth])).toEqual([
      ['https://x.org/app/', 0.5],
      ['https://x.org/app/#/theme/3', 0.5],
      ['https://x.org/app/#/', 0.5],
    ]);
  });
});
