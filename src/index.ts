/**
 * annoquest: guided annotation requests, agent-first.
 *
 * An agent builds a request (documents + prioritised items, each anchored to a
 * section or passage, each with a response type), checks its anchors, and
 * delivers it as a baked page or a link. A reader is guided through it; answers
 * autosave and, with an `http` sink, autosubmit. The agent collects answers and
 * summarises where readers are aligned, blocked, or yet to answer.
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
  passageHash,
  type TextIndex,
  type Match,
  type FindResult,
} from './anchor';
export { createRequest, parseRequest, checkRequest, checkItem, newId, docOf, type CreateInput, type CheckReport, type ItemCheck } from './request';
export { encodePayload, decodePayload, requestLink, specLink, replyLink, readLink, linkTier } from './link';
export { bakeRequest, inlineDocuments, scriptSafeJson, REQUEST_SCRIPT_ID } from './bake';
export { parseResponses, latestPerReader, readerKey, summarize, summaryMarkdown, type Summary, type ItemSummary, type ItemStatus } from './collect';
export { toElicitation, type Elicitation } from './elicit';
