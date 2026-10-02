/**
 * Anchoring: find an item's passage in a document, robustly.
 *
 * The document's text is indexed once (text nodes under a root, with
 * whitespace collapsed and typographic characters folded, so a quote copied
 * from a Markdown rendering still matches the HTML). A quote is found by exact
 * match first, disambiguated by its prefix and suffix; failing that, by an
 * approximate match scored on quote, context and position, the way the
 * Hypothesis client re-anchors (docs/research/browser-techniques.md §1).
 *
 * Works on any DOM: the browser's, or linkedom's in Node (the CLI's `check`).
 */
import search from 'approx-string-match';
import type { Quote } from './spec';

const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'NAV', 'SVG']);
const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

// One char in, one char out, so offsets survive folding.
const FOLD: Record<string, string> = {
  '‘': "'", '’': "'", '‚': "'", 'ʼ': "'", '′': "'",
  '“': '"', '”': '"', '„': '"', '″': '"',
  '‐': '-', '‑': '-', '‒': '-', '–': '-', '—': '-', '−': '-',
};
const isSpace = (c: string) => /\s| | | | /.test(c);

/** Fold a string the way the index folds document text. */
export function normalizeText(s: string): string {
  let out = '';
  let prevSpace = true;
  for (const ch of s) {
    if (isSpace(ch)) {
      if (!prevSpace) out += ' ';
      prevSpace = true;
    } else {
      out += FOLD[ch] ?? ch;
      prevSpace = false;
    }
  }
  return out.trimEnd();
}

export interface TextIndex {
  /** The folded text. */
  text: string;
  nodes: Text[];
  /** For each char of `text`: index into `nodes`, and offset inside that node. */
  nodeOf: Int32Array;
  offsetOf: Int32Array;
}

/** Index the text under `root`, skipping scripts, styles and navigation. */
export function indexText(root: Node): TextIndex {
  const nodes: Text[] = [];
  const nodeOf: number[] = [];
  const offsetOf: number[] = [];
  let text = '';
  let prevSpace = true;
  const walk = (n: Node) => {
    if (n.nodeType === ELEMENT_NODE) {
      if (SKIP.has((n as Element).tagName.toUpperCase())) return;
      for (let c = n.firstChild; c; c = c.nextSibling) walk(c);
    } else if (n.nodeType === TEXT_NODE) {
      const data = (n as Text).data;
      const ni = nodes.push(n as Text) - 1;
      for (let i = 0; i < data.length; i++) {
        const ch = data[i]!;
        if (isSpace(ch)) {
          if (prevSpace) continue;
          text += ' ';
          prevSpace = true;
        } else {
          text += FOLD[ch] ?? ch;
          prevSpace = false;
        }
        nodeOf.push(ni);
        offsetOf.push(i);
      }
    }
  };
  walk(root);
  return { text, nodes, nodeOf: Int32Array.from(nodeOf), offsetOf: Int32Array.from(offsetOf) };
}

export interface Match {
  start: number;
  end: number;
  /** `exact`: the quote occurs verbatim (after folding); `fuzzy`: approximately. */
  how: 'exact' | 'fuzzy';
  score: number;
}

export type FindResult =
  | { ok: true; match: Match }
  | { ok: false; reason: 'not-found' | 'ambiguous'; candidates: number };

const similarity = (a: string, b: string): number => {
  if (!a.length || !b.length) return a.length === b.length ? 1 : 0;
  const m = search(a, b, b.length);
  if (!m.length) return 0;
  return 1 - Math.min(...m.map((x) => x.errors)) / b.length;
};

function contextScore(text: string, start: number, end: number, q: Quote): number {
  let s = 0;
  if (q.prefix) {
    const p = normalizeText(q.prefix);
    s += similarity(text.slice(Math.max(0, start - p.length - 4), start), p);
  }
  if (q.suffix) {
    const x = normalizeText(q.suffix);
    s += similarity(text.slice(end, end + x.length + 4), x);
  }
  return s;
}

/**
 * Find a quote in an index. Ambiguous means several equally good places and no
 * context to choose: the caller should lengthen the prefix or suffix.
 */
export function findQuote(index: TextIndex, quote: Quote, { minQuality = 0.75 } = {}): FindResult {
  const { text } = index;
  const exact = normalizeText(quote.exact);
  if (!exact) return { ok: false, reason: 'not-found', candidates: 0 };
  const hits: number[] = [];
  for (let i = text.indexOf(exact); i !== -1; i = text.indexOf(exact, i + 1)) hits.push(i);
  if (hits.length === 1) return { ok: true, match: { start: hits[0]!, end: hits[0]! + exact.length, how: 'exact', score: 1 } };
  if (hits.length > 1) {
    const scored = hits.map((h) => ({ h, s: contextScore(text, h, h + exact.length, quote) })).sort((a, b) => b.s - a.s);
    if (scored[0]!.s - scored[1]!.s > 0.05) {
      const h = scored[0]!.h;
      return { ok: true, match: { start: h, end: h + exact.length, how: 'exact', score: 1 } };
    }
    return { ok: false, reason: 'ambiguous', candidates: hits.length };
  }
  // Approximate: the document changed since the quote was taken.
  const maxErrors = Math.min(256, Math.floor(exact.length * (1 - minQuality)));
  const found = search(text, exact, maxErrors);
  if (!found.length) return { ok: false, reason: 'not-found', candidates: 0 };
  const best = found
    .map((m) => {
      const q = 1 - m.errors / exact.length;
      return { m, q, s: 50 * q + 20 * contextScore(text, m.start, m.end, quote) };
    })
    .sort((a, b) => b.s - a.s);
  const top = best[0]!;
  if (top.q < minQuality) return { ok: false, reason: 'not-found', candidates: 0 };
  if (best.length > 1 && best[1]!.s === top.s && best[1]!.m.start !== top.m.start) {
    return { ok: false, reason: 'ambiguous', candidates: best.length };
  }
  return { ok: true, match: { start: top.m.start, end: top.m.end, how: 'fuzzy', score: top.q } };
}

/** A DOM range over a match. */
export function matchToRange(index: TextIndex, match: Pick<Match, 'start' | 'end'>, doc: Document): Range {
  const range = doc.createRange();
  const a = match.start;
  const b = Math.max(a, match.end - 1);
  range.setStart(index.nodes[index.nodeOf[a]!]!, index.offsetOf[a]!);
  range.setEnd(index.nodes[index.nodeOf[b]!]!, index.offsetOf[b]! + 1);
  return range;
}

/** The index position of a DOM point (for turning a reader's selection into a quote). */
export function positionOf(index: TextIndex, node: Node, offset: number): number {
  let ni = index.nodes.indexOf(node as Text);
  if (ni === -1) {
    // An element boundary: use the first indexed text node at or after it.
    const child = node.childNodes[offset] ?? null;
    const target = child ?? node;
    ni = index.nodes.findIndex((t) => target === t || !!(target.compareDocumentPosition(t) & 4) || target.contains(t));
    if (ni === -1) return index.text.length;
    offset = 0;
  }
  let lo = 0;
  let hi = index.text.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const n = index.nodeOf[mid]!;
    if (n < ni || (n === ni && index.offsetOf[mid]! < offset)) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** A quote for `[start, end)`, with enough context to be unique (at least `context` chars). */
export function describeQuote(index: TextIndex, start: number, end: number, { context = 32 } = {}): Quote {
  const { text } = index;
  const exact = text.slice(start, end);
  let n = context;
  for (;;) {
    const quote = { exact, prefix: text.slice(Math.max(0, start - n), start), suffix: text.slice(end, end + n) };
    const r = findQuote(index, quote);
    if ((r.ok && r.match.start === start) || n > 400) return quote;
    n *= 2;
  }
}

/** FNV-1a over the folded passage: a cheap, synchronous fingerprint for staleness checks. */
export function passageHash(passage: string): string {
  let h = 0x811c9dc5;
  const s = normalizeText(passage);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}
