/**
 * The request and response schemas: the single source of truth.
 *
 * Every other shape in annoquest (the CLI's `schema` output, the viewer's
 * controls, the server's stored records, the summary) is derived from these.
 * A request is what an agent builds and a reader opens; responses are what a
 * reader gives back, one document per request and reader.
 */
import { z } from 'zod';

export const SPEC_VERSION = 1;

// ---- response types -------------------------------------------------------

/** How an answer reads at a glance; collection works on tones, so it is preset-agnostic. */
export const Tone = z.enum(['positive', 'neutral', 'attention', 'blocking']);
export type Tone = z.infer<typeof Tone>;

export const Option = z.object({
  value: z.string().min(1),
  label: z.string().min(1),
  tone: Tone.default('neutral'),
  /** Ask for a reason when this option is picked. Blocking options always require one. */
  comment: z.enum(['optional', 'encouraged', 'required']).optional(),
  hint: z.string().optional(),
});
export type Option = z.infer<typeof Option>;

/**
 * `ack`: a single tick ("I've read this"). `choice`: pick one. `multi`: pick any.
 * `text`: a free comment only.
 */
export const ResponseKind = z.enum(['ack', 'choice', 'multi', 'text']);
export type ResponseKind = z.infer<typeof ResponseKind>;

export const ResponseType = z.object({
  kind: ResponseKind,
  options: z.array(Option).default([]),
  label: z.string().optional(),
});
export type ResponseType = z.infer<typeof ResponseType>;

// ---- documents and targets ------------------------------------------------

export const DocumentSource = z.discriminatedUnion('kind', [
  /**
   * A live page. Same-origin with the viewer for highlights; otherwise the passage is shown in the card.
   * Its own scripts are off unless `scripts` is true: turn them on for a page that draws its content
   * with JavaScript (a dashboard, a single-page app). Only for pages you trust: a same-origin page with
   * scripts can reach the viewer, as any page on that origin already can. Passages are re-found
   * whenever the page re-renders.
   */
  z.object({ kind: z.literal('url'), url: z.string().min(1), scripts: z.boolean().optional() }),
  /** A snapshot baked into the request page. */
  z.object({ kind: z.literal('inline'), html: z.string(), baseUrl: z.string().optional() }),
]);
export type DocumentSource = z.infer<typeof DocumentSource>;

export const Doc = z.object({
  id: z.string().min(1),
  title: z.string().optional(),
  source: DocumentSource,
  /** Where a reader can open the original (for "open in the original" links). Defaults to a url source. */
  href: z.string().optional(),
});
export type Doc = z.infer<typeof Doc>;

/** W3C Web Annotation `TextQuoteSelector`. */
export const Quote = z.object({
  exact: z.string().min(1),
  prefix: z.string().optional(),
  suffix: z.string().optional(),
  /** Which match of `exact` in the page this is, from 1: recorded always, used only to break a tie the context cannot. */
  occurrence: z.number().int().positive().optional(),
});
export type Quote = z.infer<typeof Quote>;

export const Target = z.object({
  /** An element id in the document (a section, a `<details>`, a heading). Scopes the quote search. */
  section: z.string().optional(),
  quote: Quote.optional(),
});
export type Target = z.infer<typeof Target>;

// ---- items and requests ---------------------------------------------------

export const Priority = z.enum(['must', 'should', 'could']);
export type Priority = z.infer<typeof Priority>;
export const PRIORITIES: readonly Priority[] = Priority.options;

export const CommentPolicy = z.enum(['none', 'optional', 'required']);

export const Item = z.object({
  id: z.string().min(1),
  /** Document id; defaults to the request's first document. */
  doc: z.string().optional(),
  target: Target.optional(),
  title: z.string().optional(),
  prompt: z.string().min(1),
  priority: Priority.default('should'),
  /** A preset name (see `presets`) or an inline response type. */
  response: z.union([z.string().min(1), ResponseType]).default('agree'),
  /** Per-item wording for the preset's options, keyed by option value. */
  labels: z.record(z.string(), z.string()).optional(),
  comment: CommentPolicy.default('optional'),
  /** Estimated reading time, shown to the reader. */
  minutes: z.number().positive().optional(),
  /** Reader ids this item is for; all readers when absent. */
  readers: z.array(z.string()).optional(),
  /** Hash of the passage as resolved when the request was built (see `checkRequest`). */
  passageHash: z.string().optional(),
});
export type Item = z.infer<typeof Item>;
export type ItemInput = z.input<typeof Item>;

export const Person = z.object({
  id: z.string().min(1).optional(),
  name: z.string().optional(),
  email: z.string().optional(),
});
export type Person = z.infer<typeof Person>;

export const Mode = z.enum(['guided', 'checklist']);
export type Mode = z.infer<typeof Mode>;

export const Reader = Person.extend({
  id: z.string().min(1),
  mode: Mode.optional(),
  role: z.enum(['approver', 'reviewer', 'informed']).optional(),
});
export type Reader = z.infer<typeof Reader>;

export const Sink = z.discriminatedUnion('kind', [
  /** Answers stay on the reader's device; the done screen offers a reply link and a download. */
  z.object({ kind: z.literal('local') }),
  /** Answers are submitted automatically to an annoquest server API (e.g. `/api`). */
  z.object({ kind: z.literal('http'), url: z.string().min(1) }),
]);
export type Sink = z.infer<typeof Sink>;

export const Request = z.object({
  schema: z.literal('annoquest/request').default('annoquest/request'),
  version: z.literal(SPEC_VERSION).default(SPEC_VERSION),
  id: z.string().min(8),
  title: z.string().min(1),
  /** Shown before the first item: why this request, what to expect. Plain text, blank lines split paragraphs. */
  intro: z.string().optional(),
  requester: Person.optional(),
  readers: z.array(Reader).default([]),
  mode: Mode.default('guided'),
  due: z.string().optional(),
  documents: z.array(Doc).min(1),
  responseTypes: z.record(z.string(), ResponseType).default({}),
  /** What to walk the reader through; none makes a freeform request (with `allowExtra`). */
  items: z.array(Item).default([]),
  sink: Sink.default({ kind: 'local' }),
  /** Let the reader annotate passages that no item points at (freeform annotation). */
  allowExtra: z.boolean().default(true),
  /** Record which pages the reader opens and for how long (see `events.ts`); say so in `intro`. */
  track: z.boolean().default(false),
  createdAt: z.string().optional(),
  /** Set by a server: which revision of this request (same id) this is, from 1. */
  revision: z.number().int().positive().optional(),
  /** Set on a request made from a content link: the page, and the server's token for its site. */
  content: z.object({ url: z.string().min(1), token: z.string().min(1) }).optional(),
});
export type Request = z.infer<typeof Request>;
export type RequestInput = z.input<typeof Request>;

// ---- responses ------------------------------------------------------------

export const Answer = z.object({
  /** `true` for ack, an option value for choice, option values for multi; absent for text-only. */
  value: z.union([z.literal(true), z.string(), z.array(z.string())]).optional(),
  comment: z.string().optional(),
  at: z.string(),
  /** Increases with every change to this answer; last write wins per item. */
  rev: z.number().int().nonnegative().default(0),
  /** The passage hash the reader saw when answering; differs from the item's when the passage changed. */
  passageHash: z.string().optional(),
  /** Hash of the item (wording, options, target) when answered; differs once a revision changed the item. */
  itemHash: z.string().optional(),
});
export type Answer = z.infer<typeof Answer>;

/** A reader's own annotation on a passage no item asked about. */
export const Extra = z.object({
  id: z.string().min(1),
  doc: z.string(),
  /** The page it was made on, when the reader followed a link away from the document's own address. */
  url: z.string().optional(),
  target: Target,
  comment: z.string(),
  at: z.string(),
  /** Increases with every edit; the highest wins in a merge (absent reads as 0). */
  rev: z.number().int().nonnegative().optional(),
});
export type Extra = z.infer<typeof Extra>;

export const Responses = z.object({
  schema: z.literal('annoquest/responses').default('annoquest/responses'),
  version: z.literal(SPEC_VERSION).default(SPEC_VERSION),
  request: z.string(),
  reader: Person.default({}),
  answers: z.record(z.string(), Answer).default({}),
  extras: z.array(Extra).default([]),
  /** Ids of extras the reader removed: a tombstone, so a merge with an older copy cannot bring them back. */
  removed: z.array(z.string()).default([]),
  updatedAt: z.string(),
  finishedAt: z.string().optional(),
  /** Set by a server from its identity header; never trusted from a client. */
  by: z.string().optional(),
});
export type Responses = z.infer<typeof Responses>;

// ---- events ---------------------------------------------------------------

/**
 * What the viewer sends as things happen (see `events.ts`): small, append-only, each with a
 * random `id` so a resend is harmless. `answer` and `extra` carry the whole record at that
 * revision, so the final state is a fold of the events alone.
 */
const EventBase = {
  id: z.string().min(1),
  /** One per page load. */
  session: z.string().min(1),
  /** Order within a session. */
  seq: z.number().int().nonnegative(),
  at: z.string(),
};

export const Event = z.discriminatedUnion('type', [
  z.object({ ...EventBase, type: z.literal('open'), viewport: z.object({ w: z.number(), h: z.number() }).optional() }),
  /** A page shown in the frame: the first load, a followed link, an in-app route. */
  z.object({ ...EventBase, type: z.literal('view'), url: z.string(), title: z.string().optional() }),
  z.object({ ...EventBase, type: z.literal('visibility'), state: z.enum(['visible', 'hidden']) }),
  /** Every few seconds while visible: `active` if the reader interacted since the last one; `depth` the furthest scroll (0–1). */
  z.object({ ...EventBase, type: z.literal('beat'), url: z.string().optional(), active: z.boolean(), depth: z.number().min(0).max(1).optional() }),
  z.object({ ...EventBase, type: z.literal('answer'), item: z.string().min(1), answer: Answer }),
  z.object({ ...EventBase, type: z.literal('extra'), extra: Extra }),
  z.object({ ...EventBase, type: z.literal('remove'), extra: z.string().min(1) }),
  z.object({ ...EventBase, type: z.literal('name'), name: z.string() }),
  z.object({ ...EventBase, type: z.literal('finish') }),
]);
export type Event = z.infer<typeof Event>;
/** An event before it is stamped with its id, session, seq and time. */
export type EventInput = Event extends infer E ? (E extends Event ? Omit<E, 'id' | 'session' | 'seq' | 'at'> & { at?: string } : never) : never;

/** One post from one device: the unit the server stores (write-once). */
export const EventBatch = z.object({
  schema: z.literal('annoquest/events').default('annoquest/events'),
  request: z.string(),
  /** The reader key: `?reader=` / `?user_id=` from the link, a listed reader, or the device id. */
  reader: z.string().min(1),
  /** A random id kept in this browser. */
  device: z.string().min(1),
  /** The reader's own details, as on `Responses`. */
  person: Person.optional(),
  events: z.array(Event),
  /** Set by a server from its identity header; never trusted from a client. */
  by: z.string().nullish(),
});
export type EventBatch = z.infer<typeof EventBatch>;
