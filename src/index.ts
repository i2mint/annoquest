/**
 * annoquest: guided annotation requests, agent-first.
 *
 * An agent builds a request (documents + prioritised items, each anchored to a
 * section or passage, each with a response type), checks its anchors, and
 * delivers it as a baked page or a link. A reader is guided through it; answers
 * autosave and, with an `http` sink, autosubmit. The agent collects answers and
 * summarises where readers are aligned, blocked, or yet to answer.
 *
 * A request can also be freeform (no items: the reader highlights and comments on
 * anything), and a content link opens any page that way. With a server, every
 * change and page view is an event, and the final state and the reading
 * analytics are a pure fold of the events (`events.ts`).
 *
 * Everything here is a plain function, JSON in and JSON out: the CLI and any
 * agent tool wrap these, never the other way round.
 */
export * from './spec';
export { presets, resolveResponseType, commentRequired } from './presets';
export { AnnoquestError, type ErrorCode } from './errors';
export {
  normalizeText,
  indexText,
  findQuote,
  matchToRange,
  positionOf,
  describeQuote,
  occurrenceOf,
  passageHash,
  type TextIndex,
  type Match,
  type FindResult,
} from './anchor';
export { createRequest, parseRequest, checkRequest, checkItem, newId, docOf, itemHash, diffRequests, type CreateInput, type CheckReport, type ItemCheck, type RevisionDiff } from './request';
export { encodePayload, decodePayload, requestLink, specLink, replyLink, readLink, linkTier } from './link';
export { bakeRequest, inlineDocuments, scriptSafeJson, REQUEST_SCRIPT_ID } from './bake';
export { parseResponses, mergeResponses, latestPerReader, readerKey, summarize, summaryMarkdown, type Summary, type ItemSummary, type ItemStatus } from './collect';
export { toElicitation, type Elicitation } from './elicit';
export { publishRevision, type RemoteOptions } from './remote';
export { foldResponses, foldBatches, analytics, diffResponses, parseBatches, isBatch, batchReader, exportLog, exportMarkdown, DWELL_CAP_MS, BEAT_MS, type Analytics, type PageStats, type ReaderLog, type Export } from './events';
export { contentLink, contentRequest, contentRequestId, proxyUrl, originalUrl, pageKey, CONTENT_INTRO, type ContentOptions } from './content';
