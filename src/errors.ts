/**
 * The one error type annoquest throws, with a machine-readable code.
 *
 * Messages say what is wrong and what to do about it, because the first reader
 * of most errors is an agent deciding its next step.
 */
export type ErrorCode = 'invalid' | 'anchor' | 'bad-payload' | 'io';

export class AnnoquestError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AnnoquestError';
  }
}
