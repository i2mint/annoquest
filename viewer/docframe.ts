/**
 * The document side of the viewer: a document the guide drives.
 *
 * The document lives on a *surface*: either a same-origin iframe (sandboxed with
 * `allow-same-origin` and without `allow-scripts`, so its own scripts never run
 * while the guide can still read its DOM), or a shadow root in the viewer's own
 * DOM, for when the viewer runs in an opaque origin and a nested frame would be
 * unreachable (see shadowdoc.ts). On either, the guide anchors passages,
 * highlights them (CSS Custom Highlight API, falling back to the selection),
 * opens enclosing `<details>`, scrolls, and turns the reader's selection into a quote.
 */
import { describeQuote, findQuote, indexText, matchToRange, positionOf, passageHash, sectionSpan, sliceIndex, type TextIndex } from '../src/anchor';
import type { Item, Quote, Target } from '../src/spec';

export interface Anchored {
  range: Range | null;
  passage?: string;
  passageHash?: string;
  /** `section` when only the section was found (no quote, or the quote is gone). */
  how: 'exact' | 'fuzzy' | 'section' | 'missing' | 'none';
  sectionLabel?: string;
}

/**
 * Highlight names. A frame has a registry of its own; shadow-root surfaces share the viewer
 * window's, so each one gets its own suffix or a second document would repaint the first's.
 */
const names = (suffix = '') => ({ all: `aq-item${suffix}`, done: `aq-done${suffix}`, current: `aq-current${suffix}`, extra: `aq-extra${suffix}` });

const styleFor = (hl: ReturnType<typeof names>) => `
::highlight(${hl.all}) { background-color: rgba(250, 204, 21, 0.22); }
::highlight(${hl.done}) { background-color: rgba(34, 197, 94, 0.16); }
::highlight(${hl.extra}) { background-color: rgba(59, 130, 246, 0.18); }
::highlight(${hl.current}) { background-color: rgba(245, 158, 11, 0.55); }
.aq-section-current { outline: 3px solid rgba(245, 158, 11, 0.7); outline-offset: 6px; border-radius: 4px; }
html { scroll-padding-top: 20vh; }
`;

/** The nearest heading-like text for a section element (its h1–h6 or summary). */
function labelOf(el: Element | null): string | undefined {
  if (!el) return undefined;
  const h = el.matches('h1,h2,h3,h4,h5,h6,summary') ? el : el.querySelector(':scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > summary, :scope > header h1');
  return h?.textContent?.replace(/\s+/g, ' ').trim() || undefined;
}

type Win = Window & typeof globalThis;
type RangeLike = Pick<Range, 'startContainer' | 'startOffset' | 'endContainer' | 'endOffset'>;

/** Where a document is shown, and how to reach into it. */
export interface Surface {
  /** The tree to look ids up in. */
  root: Document | ShadowRoot;
  /** The node whose text is indexed (the body, or the shadow root's body stand-in). */
  body: Node;
  /** The document that owns the nodes (ranges are made from it; events fire on it). */
  doc: Document;
  win: Win;
  /** Where the guide's highlight styles go. */
  styleHost: Node;
  /** The visible area, in client coordinates, for checking that a passage is in view. */
  viewport(): { top: number; bottom: number };
  /** The reader's current selection inside this surface, if any. */
  selectedRange(): RangeLike | null;
  /** The text position under a point, if the browser can say. */
  caretAt(x: number, y: number): { node: Node; offset: number } | null;
  /** Appended to highlight names when the highlight registry is shared with other surfaces. */
  highlightSuffix?: string;
}

/** A same-origin iframe's document; throws when the frame cannot be reached. */
export function frameSurface(frame: HTMLIFrameElement): Surface {
  const doc = frame.contentDocument;
  if (!doc) throw new Error('The document frame is not same-origin; highlights are unavailable.');
  const win = frame.contentWindow as Win;
  return {
    root: doc,
    body: doc.body ?? doc.documentElement,
    doc,
    win,
    styleHost: doc.head ?? doc.documentElement,
    viewport: () => ({ top: 0, bottom: win.innerHeight }),
    selectedRange: () => {
      const sel = win.getSelection();
      return sel && !sel.isCollapsed && sel.rangeCount ? sel.getRangeAt(0) : null;
    },
    caretAt: (x, y) => caretIn(doc, x, y),
  };
}

/** A shadow root in the viewer's own DOM, its body stand-in, and the element that scrolls it. */
export function shadowSurface(shadow: ShadowRoot, body: HTMLElement, scroller: HTMLElement, key = ''): Surface {
  return {
    // Unambiguous per document id ('a.b' and 'a_b' must not collide).
    highlightSuffix: `-${Array.from(key || 'doc', (c) => (/[A-Za-z0-9]/.test(c) ? c : `_${c.codePointAt(0)!.toString(16)}_`)).join('')}`,
    root: shadow,
    body,
    doc: document,
    win: window as Win,
    styleHost: shadow,
    viewport: () => {
      const r = scroller.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom };
    },
    selectedRange: () => {
      // Selections inside a shadow tree: Chrome exposes them on the root, the standard way is
      // getComposedRanges (whose argument form changed between browser versions).
      const own = (shadow as unknown as { getSelection?: () => Selection | null }).getSelection?.();
      if (own && !own.isCollapsed && own.rangeCount) return own.getRangeAt(0);
      const sel = window.getSelection() as (Selection & { getComposedRanges?: (...a: unknown[]) => StaticRange[] }) | null;
      if (!sel || sel.isCollapsed) return null;
      let ranges: StaticRange[] | undefined;
      try {
        ranges = sel.getComposedRanges?.({ shadowRoots: [shadow] });
      } catch {
        try {
          ranges = sel.getComposedRanges?.(shadow);
        } catch {
          ranges = undefined;
        }
      }
      const r = ranges?.[0] ?? (sel.rangeCount ? sel.getRangeAt(0) : null);
      return r && body.contains(r.startContainer) ? r : null;
    },
    caretAt: (x, y) => caretIn(document, x, y, shadow),
  };
}

function caretIn(doc: Document, x: number, y: number, shadow?: ShadowRoot): { node: Node; offset: number } | null {
  const d = doc as Document & { caretPositionFromPoint?: (x: number, y: number, o?: unknown) => { offsetNode: Node; offset: number } | null };
  try {
    const pos = d.caretPositionFromPoint?.(x, y, shadow ? { shadowRoots: [shadow] } : undefined);
    if (pos) return { node: pos.offsetNode, offset: pos.offset };
  } catch {
    /* older signature */
  }
  const r = doc.caretRangeFromPoint?.(x, y);
  return r ? { node: r.startContainer, offset: r.startOffset } : null;
}

export class DocFrame {
  readonly doc: Document;
  readonly win: Win;
  private index: TextIndex;
  private anchored = new Map<string, Anchored>();
  private outlined: Element | null = null;
  readonly hl: ReturnType<typeof names>;

  constructor(readonly surface: Surface) {
    this.doc = surface.doc;
    this.win = surface.win;
    this.hl = names(surface.highlightSuffix);
    const style = this.doc.createElement('style');
    style.textContent = styleFor(this.hl);
    surface.styleHost.appendChild(style);
    this.index = indexText(surface.body);
  }

  private byId(id: string): Element | null {
    return this.surface.root.getElementById(id);
  }

  private sectionBounds(id: string): { el: Element; start: number; end: number } | null {
    const el = this.byId(id);
    return el ? { el, ...sectionSpan(this.index, el) } : null;
  }

  anchor(item: Pick<Item, 'id' | 'target'>): Anchored {
    const cached = this.anchored.get(item.id);
    if (cached) return cached;
    const a = this.resolve(item.target);
    this.anchored.set(item.id, a);
    return a;
  }

  resolve(t: Target | undefined): Anchored {
    if (!t || (!t.section && !t.quote)) return { range: null, how: 'none' };
    const sec = t.section ? this.sectionBounds(t.section) : null;
    const sectionLabel = labelOf(sec?.el ?? null);
    if (t.quote) {
      const tryIn = (idx: TextIndex, offset: number) => {
        const r = findQuote(idx, t.quote as Quote);
        return r.ok ? { start: r.match.start + offset, end: r.match.end + offset, how: r.match.how } : null;
      };
      const m = (sec && tryIn(sliceIndex(this.index, sec.start, sec.end), sec.start)) || tryIn(this.index, 0);
      if (m) {
        const range = matchToRange(this.index, m, this.doc);
        const passage = this.index.text.slice(m.start, m.end);
        const el = range.startContainer.parentElement?.closest('[id]') ?? null;
        return { range, passage, passageHash: passageHash(passage), how: m.how, sectionLabel: sectionLabel ?? labelOf(el) };
      }
    }
    if (sec) {
      const range = this.doc.createRange();
      const head = sec.el.matches('details') ? sec.el.querySelector(':scope > summary') : sec.el.querySelector(':scope > h1, :scope > h2, :scope > h3, :scope > h4');
      range.selectNodeContents(head ?? sec.el);
      return { range, how: t.quote ? 'missing' : 'section', sectionLabel, passage: this.index.text.slice(sec.start, Math.min(sec.end, sec.start + 400)) };
    }
    return { range: null, how: 'missing' };
  }

  /** Paint highlights: every item passage, done ones in another colour, the current one strongest. */
  paint(items: Item[], { current, done, extras }: { current?: string; done: Set<string>; extras: Target[] }) {
    const reg = (this.win as unknown as { CSS?: { highlights?: Map<string, unknown> } }).CSS?.highlights;
    const Highlight = (this.win as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
    const ranges = (pred: (i: Item) => boolean) =>
      items.filter(pred).map((i) => this.anchor(i)).filter((a) => a.range && a.how !== 'section' && a.how !== 'missing').map((a) => a.range!);
    const cur = items.find((i) => i.id === current);
    const curA = cur ? this.anchor(cur) : null;
    this.outlined?.classList.remove('aq-section-current');
    this.outlined = null;
    if (cur?.target?.section && (curA?.how === 'section' || curA?.how === 'missing')) {
      this.outlined = this.byId(cur.target.section);
      this.outlined?.classList.add('aq-section-current');
    }
    if (reg && Highlight) {
      const hl = this.hl;
      reg.set(hl.all, new Highlight(...ranges((i) => i.id !== current && !done.has(i.id))));
      reg.set(hl.done, new Highlight(...ranges((i) => i.id !== current && done.has(i.id))));
      reg.set(hl.extra, new Highlight(...extras.map((t) => this.resolve(t).range).filter((r): r is Range => !!r)));
      reg.set(hl.current, new Highlight(...(curA?.range && curA.how !== 'section' ? [curA.range] : [])));
    } else if (curA?.range && curA.how !== 'section' && this.surface.root === this.doc) {
      const sel = this.win.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(curA.range);
    }
  }

  /** Bring an item's passage into view, opening any `<details>` around it. */
  reveal(item: Item) {
    const a = this.anchor(item);
    const node = a.range?.startContainer ?? (item.target?.section ? this.byId(item.target.section) : null);
    const el = node && (node.nodeType === 1 ? (node as Element) : node.parentElement);
    if (!el) return;
    for (let d = el.closest('details'); d; d = d.parentElement?.closest('details') ?? null) d.open = true;
    const sec = item.target?.section ? this.byId(item.target.section) : null;
    if (sec?.matches('details')) (sec as HTMLDetailsElement).open = true;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    // A big page is still laying out (images decoding, details opening) when this runs,
    // so the first scroll can land short. Look again, and re-aim if the passage is not in view.
    const target = a.range ?? el;
    const settle = (n: number) =>
      setTimeout(() => {
        const r = target.getBoundingClientRect();
        const v = this.surface.viewport();
        if (r.bottom < v.top || r.top > v.bottom) el.scrollIntoView({ block: 'center' });
        if (n > 0) settle(n - 1);
      }, 500);
    settle(3);
  }

  /** The item whose passage contains a point the reader clicked (or the clicked node), if any. */
  itemAt(items: Item[], x: number, y: number, target?: Node | null): string | undefined {
    const caret = this.surface.caretAt(x, y);
    const passages = items.map((it) => ({ id: it.id, a: this.anchor(it) })).filter(({ a }) => a.range && a.how !== 'section');
    if (caret && this.surface.body.contains(caret.node)) {
      // The caret saw the click: it is in a passage or it is not, nothing to guess.
      return passages.find(({ a }) => a.range!.isPointInRange(caret.node, caret.offset))?.id;
    }
    if (!target) return undefined;
    // No caret API (or it did not see into the shadow tree): the smallest passage touching the clicked node.
    const touching = passages.filter(({ a }) => a.range!.intersectsNode(target));
    touching.sort((p, q) => p.a.range!.toString().length - q.a.range!.toString().length);
    return touching[0]?.id;
  }

  /** The reader's current selection as a target (quote + nearest section id), or null. */
  selection(): { target: Target; text: string } | null {
    const range = this.surface.selectedRange();
    if (!range) return null;
    const start = positionOf(this.index, range.startContainer, range.startOffset);
    const end = positionOf(this.index, range.endContainer, range.endOffset);
    const text = this.index.text.slice(start, end).trim();
    if (text.length < 3) return null;
    const lead = this.index.text.slice(start, end).length - this.index.text.slice(start, end).trimStart().length;
    const s = start + lead;
    const quote = describeQuote(this.index, s, s + text.length);
    const node = range.startContainer;
    const section = (node.nodeType === 1 ? (node as Element) : node.parentElement)?.closest('section[id], details[id], [id]')?.id;
    return { target: { quote, ...(section ? { section } : {}) }, text };
  }
}

/** A text-fragment link to a passage in the original page, for when the frame cannot show it. */
export function textFragmentUrl(href: string, quote?: Quote): string {
  if (!quote) return href;
  const enc = (s: string) => encodeURIComponent(s).replace(/-/g, '%2D');
  const words = quote.exact.trim().split(/\s+/);
  const text = words.length > 8 ? `${enc(words.slice(0, 4).join(' '))},${enc(words.slice(-4).join(' '))}` : enc(quote.exact.trim());
  return `${href.split('#')[0]}#:~:text=${text}`;
}
