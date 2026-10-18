/**
 * Reading analytics, viewer side: which page is on screen, whether the tab is
 * visible, whether the reader is doing anything, how far down they scrolled.
 *
 * Emits `open` once, `view` when the page changes, `visibility` when the tab is
 * hidden or shown, and a `beat` every `BEAT_MS` while visible (with `active`
 * when the reader scrolled, pointed or typed since the last one, and the page's
 * furthest scroll so far). The fold in src/events.ts turns these into time per
 * page; nothing here keeps totals.
 */
import { BEAT_MS } from '../src/events';
import type { EventInput } from '../src/spec';

export interface Tracker {
  /** The page in the frame changed (or its first load): `url` is the original address. */
  page(url: string, title?: string): void;
  /** Watch a document for activity and scrolling (the frame's, after each navigation). */
  watch(doc: Document): void;
  dispose(): void;
}

const ACTIVITY = ['scroll', 'wheel', 'pointerdown', 'pointermove', 'keydown', 'touchstart', 'selectionchange'] as const;

export function createTracker(emit: (events: EventInput[]) => void, { beat = BEAT_MS, win = window }: { beat?: number; win?: Window } = {}): Tracker {
  let url: string | undefined;
  let active = false;
  const depth = new Map<string, number>();
  const watched = new WeakSet<Document>();
  const touch = () => void (active = true);
  const scrolled = (doc: Document) => () => {
    touch();
    const w = doc.defaultView;
    const el = doc.scrollingElement ?? doc.documentElement;
    if (!w || !el || !url) return;
    const d = Math.min(1, (w.scrollY + w.innerHeight) / Math.max(1, el.scrollHeight));
    if (d > (depth.get(url) ?? 0)) depth.set(url, Math.round(d * 100) / 100);
  };
  const visible = () => win.document.visibilityState !== 'hidden';
  const onVisibility = () => emit([{ type: 'visibility', state: visible() ? 'visible' : 'hidden' }]);

  emit([{ type: 'open', viewport: { w: win.innerWidth, h: win.innerHeight } }]);
  win.document.addEventListener('visibilitychange', onVisibility);
  for (const t of ACTIVITY) win.addEventListener(t, touch, { passive: true, capture: true });
  const timer = win.setInterval(() => {
    if (!visible() || !url) return;
    emit([{ type: 'beat', url, active, ...(depth.has(url) ? { depth: depth.get(url) } : {}) }]);
    active = false;
  }, beat);

  return {
    page(next, title) {
      if (next === url) return;
      url = next;
      emit([{ type: 'view', url, ...(title ? { title } : {}) }]);
    },
    watch(doc) {
      if (watched.has(doc)) return;
      watched.add(doc);
      const onScroll = scrolled(doc);
      try {
        for (const t of ACTIVITY) doc.addEventListener(t, t === 'scroll' ? onScroll : touch, { passive: true, capture: true });
        onScroll();
        active = false; // measuring the first screen is not the reader doing something
      } catch {
        /* a document we cannot reach: nothing to watch */
      }
    },
    dispose() {
      win.clearInterval(timer);
      win.document.removeEventListener('visibilitychange', onVisibility);
      for (const t of ACTIVITY) win.removeEventListener(t, touch, { capture: true });
    },
  };
}
