/**
 * The document side of the viewer: a same-origin iframe the guide drives.
 *
 * The frame is sandboxed with `allow-same-origin` and without `allow-scripts`,
 * so the document's own scripts never run, while the parent can still read its
 * DOM, anchor passages, highlight them (CSS Custom Highlight API, falling back
 * to the frame's selection), open enclosing `<details>`, scroll, and turn the
 * reader's selection into a quote.
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

const HL = { all: 'aq-item', done: 'aq-done', current: 'aq-current', extra: 'aq-extra' } as const;

const STYLE = `
::highlight(${HL.all}) { background-color: rgba(250, 204, 21, 0.22); }
::highlight(${HL.done}) { background-color: rgba(34, 197, 94, 0.16); }
::highlight(${HL.extra}) { background-color: rgba(59, 130, 246, 0.18); }
::highlight(${HL.current}) { background-color: rgba(245, 158, 11, 0.55); }
.aq-section-current { outline: 3px solid rgba(245, 158, 11, 0.7); outline-offset: 6px; border-radius: 4px; }
html { scroll-padding-top: 20vh; }
`;

/** The nearest heading-like text for a section element (its h1–h6 or summary). */
function labelOf(el: Element | null): string | undefined {
  if (!el) return undefined;
  const h = el.matches('h1,h2,h3,h4,h5,h6,summary') ? el : el.querySelector(':scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > summary, :scope > header h1');
  return h?.textContent?.replace(/\s+/g, ' ').trim() || undefined;
}

export class DocFrame {
  readonly doc: Document;
  readonly win: Window & typeof globalThis;
  private index: TextIndex;
  private anchored = new Map<string, Anchored>();
  private outlined: Element | null = null;

  constructor(readonly frame: HTMLIFrameElement) {
    const doc = frame.contentDocument;
    if (!doc) throw new Error('The document frame is not same-origin; highlights are unavailable.');
    this.doc = doc;
    this.win = frame.contentWindow as Window & typeof globalThis;
    const style = doc.createElement('style');
    style.textContent = STYLE;
    (doc.head ?? doc.documentElement).appendChild(style);
    this.index = indexText(doc.body ?? doc.documentElement);
  }

  private sectionBounds(id: string): { el: Element; start: number; end: number } | null {
    const el = this.doc.getElementById(id);
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
      this.outlined = this.doc.getElementById(cur.target.section);
      this.outlined?.classList.add('aq-section-current');
    }
    if (reg && Highlight) {
      reg.set(HL.all, new Highlight(...ranges((i) => i.id !== current && !done.has(i.id))));
      reg.set(HL.done, new Highlight(...ranges((i) => i.id !== current && done.has(i.id))));
      reg.set(HL.extra, new Highlight(...extras.map((t) => this.resolve(t).range).filter((r): r is Range => !!r)));
      reg.set(HL.current, new Highlight(...(curA?.range && curA.how !== 'section' ? [curA.range] : [])));
    } else if (curA?.range && curA.how !== 'section') {
      const sel = this.win.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(curA.range);
    }
  }

  /** Bring an item's passage into view, opening any `<details>` around it. */
  reveal(item: Item) {
    const a = this.anchor(item);
    const node = a.range?.startContainer ?? (item.target?.section ? this.doc.getElementById(item.target.section) : null);
    const el = node && (node.nodeType === 1 ? (node as Element) : node.parentElement);
    if (!el) return;
    for (let d = el.closest('details'); d; d = d.parentElement?.closest('details') ?? null) d.open = true;
    const sec = item.target?.section ? this.doc.getElementById(item.target.section) : null;
    if (sec?.matches('details')) (sec as HTMLDetailsElement).open = true;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  /** The item whose passage contains a point the reader clicked, if any. */
  itemAt(items: Item[], x: number, y: number): string | undefined {
    const d = this.doc as Document & { caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null };
    const pos = d.caretPositionFromPoint?.(x, y);
    const r = pos ? null : this.doc.caretRangeFromPoint?.(x, y);
    const node = pos?.offsetNode ?? r?.startContainer;
    const off = pos?.offset ?? r?.startOffset ?? 0;
    if (!node) return undefined;
    for (const it of items) {
      const range = this.anchor(it).range;
      if (range && this.anchor(it).how !== 'section' && range.isPointInRange(node, off)) return it.id;
    }
    return undefined;
  }

  /** The reader's current selection as a target (quote + nearest section id), or null. */
  selection(): { target: Target; text: string } | null {
    const sel = this.win.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    const start = positionOf(this.index, range.startContainer, range.startOffset);
    const end = positionOf(this.index, range.endContainer, range.endOffset);
    const text = this.index.text.slice(start, end).trim();
    if (text.length < 3) return null;
    const lead = this.index.text.slice(start, end).length - this.index.text.slice(start, end).trimStart().length;
    const s = start + lead;
    const quote = describeQuote(this.index, s, s + text.length);
    const section = range.startContainer.parentElement?.closest('section[id], details[id], [id]')?.id;
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
