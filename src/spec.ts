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
  /** A live page. Same-origin with the viewer for highlights; otherwise the passage is shown in the card. */
  z.object({ kind: z.literal('url'), url: z.string().min(1) }),
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
  items: z.array(Item).min(1),
  sink: Sink.default({ kind: 'local' }),
  /** Let the reader annotate passages that no item points at. */
  allowExtra: z.boolean().default(true),
  createdAt: z.string().optional(),
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
});
export type Answer = z.infer<typeof Answer>;

/** A reader's own annotation on a passage no item asked about. */
export const Extra = z.object({
  id: z.string().min(1),
  doc: z.string(),
  target: Target,
  comment: z.string(),
  at: z.string(),
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
