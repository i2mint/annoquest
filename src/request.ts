/**
 * Building and checking requests: the agent primitives that come before a
 * reader ever sees anything.
 *
 * `createRequest` fills defaults and ids and validates. `checkRequest` resolves
 * every item's target against the document text and fails loudly on a passage
 * that is missing or ambiguous, so a request with a dangling anchor never ships.
 */
import { findQuote, indexText, passageHash, sectionSpan, sliceIndex, type TextIndex } from './anchor';
import { AnnoquestError } from './errors';
import { resolveResponseType } from './presets';
import { Request, type Doc, type Item, type RequestInput } from './spec';

const toBase64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** An unguessable id (128 bits): request ids double as capabilities. */
export function newId(bytes = 16): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

const slug = (s: string) =>
  s.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').slice(0, 40) || 'item';

type Loose<T> = Omit<T, 'id'> & { id?: string };
export type CreateInput = Omit<RequestInput, 'id' | 'items'> & {
  id?: string;
  items: Array<Loose<NonNullable<RequestInput['items']>[number]>>;
};

/**
 * Make a valid request from loose input: an id if absent, item ids from titles
 * or positions, defaults filled, every response type resolvable.
 */
export function createRequest(input: CreateInput, { now = () => new Date().toISOString() } = {}): Request {
  const used = new Set<string>();
  const items = (input.items ?? []).map((it, i) => {
    let id = it.id ?? slug(it.title ?? `item-${i + 1}`);
    if (used.has(id)) id = `${id}-${i + 1}`;
    used.add(id);
    return { ...it, id };
  });
  const parsed = Request.safeParse({ ...input, id: input.id ?? newId(), items, createdAt: input.createdAt ?? now() });
  if (!parsed.success) {
    const lines = parsed.error.issues.map((x) => `  ${x.path.join('.') || '(root)'}: ${x.message}`);
    throw new AnnoquestError('invalid', `The request is not valid:\n${lines.join('\n')}`, parsed.error.issues);
  }
  const req = parsed.data;
  const docIds = new Set(req.documents.map((d) => d.id));
  const dupDocs = req.documents.length !== docIds.size;
  if (dupDocs) throw new AnnoquestError('invalid', 'Two documents share an id; document ids must be unique.');
  const readerIds = new Set(req.readers.map((r) => r.id));
  for (const item of req.items) {
    if (item.doc && !docIds.has(item.doc)) {
      throw new AnnoquestError('invalid', `Item "${item.id}" points at document "${item.doc}", which is not in documents (${[...docIds].join(', ')}).`);
    }
    for (const r of item.readers ?? []) {
      if (!readerIds.has(r)) throw new AnnoquestError('invalid', `Item "${item.id}" is for reader "${r}", who is not in readers.`);
    }
    resolveResponseType(item, req);
  }
  return req;
}

/**
 * Parse and validate an already-built request (e.g. read from a file or a link).
 * Unlike `createRequest`, it never invents an id: answers are keyed by it.
 */
export function parseRequest(value: unknown): Request {
  const id = (value as { id?: unknown } | null)?.id;
  if (typeof id !== 'string' || !id) throw new AnnoquestError('invalid', 'This request has no id. Build it with `annoquest create` (or createRequest) first.');
  return createRequest(value as CreateInput);
}

export const docOf = (request: Request, item: Item): Doc => request.documents.find((d) => d.id === item.doc) ?? request.documents[0]!;

export interface ItemCheck {
  item: string;
  ok: boolean;
  /** `exact` | `fuzzy` | `section` (no quote) | `none` (no target). */
  how?: 'exact' | 'fuzzy' | 'section' | 'none';
  problem?: string;
  passage?: string;
  passageHash?: string;
}

export interface CheckReport {
  ok: boolean;
  items: ItemCheck[];
  /** The request with each item's `passageHash` set from what was found. */
  request: Request;
}

/** Resolve one item's target in a parsed document. */
export function checkItem(item: Item, doc: Document, cache = new Map<Node, TextIndex>()): ItemCheck {
  const t = item.target;
  if (!t || (!t.section && !t.quote)) return { item: item.id, ok: true, how: 'none' };
  const root: Node = doc.body ?? doc.documentElement;
  const index = cache.get(root) ?? cache.set(root, indexText(root)).get(root)!;
  let span = { start: 0, end: index.text.length };
  if (t.section) {
    const el = doc.getElementById(t.section);
    if (!el) return { item: item.id, ok: false, problem: `There is no element with id "${t.section}" in the document.` };
    span = sectionSpan(index, el);
  }
  if (!t.quote) return { item: item.id, ok: true, how: 'section', passage: index.text.slice(span.start, Math.min(span.end, span.start + 280)) };
  let r = findQuote(sliceIndex(index, span.start, span.end), t.quote);
  let offset = span.start;
  let widened = false;
  if (!r.ok && t.section) {
    r = findQuote(index, t.quote);
    offset = 0;
    widened = r.ok;
  }
  if (!r.ok) {
    const problem =
      r.reason === 'ambiguous'
        ? `The quote "${t.quote.exact.slice(0, 60)}" occurs ${r.candidates} times${t.section ? ` in #${t.section}` : ''}; add a prefix or suffix (the text just before or after it) to say which.`
        : `The quote "${t.quote.exact.slice(0, 60)}" is not in the document${t.section ? ` (looked in #${t.section}, then everywhere)` : ''}. Copy it from the document as served.`;
    return { item: item.id, ok: false, problem };
  }
  const passage = index.text.slice(r.match.start + offset, r.match.end + offset);
  return {
    item: item.id,
    ok: true,
    how: r.match.how,
    passage,
    passageHash: passageHash(passage),
    ...(widened ? { problem: `Found outside #${t.section}; check the section id.` } : {}),
  };
}

/**
 * Check every item against its document. `documents` maps document id to a
 * parsed DOM; documents not given are skipped (reported as unchecked).
 */
export function checkRequest(request: Request, documents: Record<string, Document>): CheckReport {
  const caches = new Map<string, Map<Node, TextIndex>>();
  const results = request.items.map((item) => {
    const d = docOf(request, item);
    const dom = documents[d.id];
    if (!dom) return { item: item.id, ok: false, problem: `Document "${d.id}" was not loaded, so this item was not checked.` } as ItemCheck;
    const cache = caches.get(d.id) ?? caches.set(d.id, new Map()).get(d.id)!;
    return checkItem(item, dom, cache);
  });
  const byId = new Map(results.map((r) => [r.item, r]));
  const checked: Request = {
    ...request,
    items: request.items.map((it) => {
      const h = byId.get(it.id)?.passageHash;
      return h ? { ...it, passageHash: h } : it;
    }),
  };
  return { ok: results.every((r) => r.ok), items: results, request: checked };
}

/**
 * A fingerprint of what an item asks (title, prompt, response type, labels, comment rule, target),
 * so an answer can tell when a later revision of the request changed the question under it.
 */
export function itemHash(item: Pick<Item, 'title' | 'prompt' | 'response' | 'labels' | 'comment' | 'target'>): string {
  const canon = (v: unknown): unknown =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, canon(x)]))
      : Array.isArray(v)
        ? v.map(canon)
        : v;
  const { title, prompt, response, labels, comment, target } = item;
  return passageHash(JSON.stringify(canon({ title, prompt, response, labels, comment, target })));
}

export interface RevisionDiff {
  added: string[];
  removed: string[];
  changed: string[];
  unchanged: number;
}

/** What a new version of a request changes, item by item (answers bind by item id). */
export function diffRequests(before: Request, after: Request): RevisionDiff {
  if (before.id !== after.id) throw new AnnoquestError('invalid', `A revision keeps its request id: ${after.id} is not ${before.id}.`);
  const old = new Map(before.items.map((i) => [i.id, itemHash(i)]));
  const now = new Map(after.items.map((i) => [i.id, itemHash(i)]));
  const added = [...now.keys()].filter((k) => !old.has(k));
  const removed = [...old.keys()].filter((k) => !now.has(k));
  const changed = [...now.keys()].filter((k) => old.has(k) && old.get(k) !== now.get(k));
  return { added, removed, changed, unchanged: now.size - added.length - changed.length };
}
