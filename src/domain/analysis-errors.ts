/**
 * Typed failure modes of the remote analysis provider. The server gateway
 * answers with a stable `{ error: { code, message } }` envelope; this module
 * keeps the mapping in one place so UI consumers can branch on `code` without
 * string matching.
 */

export type GeminiAnalysisErrorCode =
  | 'quota_exceeded'
  | 'timeout'
  | 'invalid_request'
  | 'invalid_response'
  | 'missing_key'
  | 'upstream_error'

export class GeminiAnalysisError extends Error {
  readonly code: GeminiAnalysisErrorCode
  readonly cause?: unknown

  constructor(code: GeminiAnalysisErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'GeminiAnalysisError'
    this.code = code
  }
}

export class AnalysisQuotaExceededError extends GeminiAnalysisError {
  constructor(message: string, cause?: unknown) {
    super('quota_exceeded', message, cause)
    this.name = 'AnalysisQuotaExceededError'
  }
}

export class AnalysisTimeoutError extends GeminiAnalysisError {
  constructor(message: string, cause?: unknown) {
    super('timeout', message, cause)
    this.name = 'AnalysisTimeoutError'
  }
}

export class AnalysisInvalidResponseError extends GeminiAnalysisError {
  constructor(message: string, cause?: unknown) {
    super('invalid_response', message, cause)
    this.name = 'AnalysisInvalidResponseError'
  }
}

export class AnalysisUnavailableError extends GeminiAnalysisError {
  constructor(message: string, cause?: unknown) {
    super('upstream_error', message, cause)
    this.name = 'AnalysisUnavailableError'
  }
}

/**
 * Maps a server envelope code onto the corresponding typed error. Anything not
 * explicitly recognized surfaces as an unavailable error: when the gateway
 * answers in an unexpected way, the app must fail closed, never guess.
 */
export function analysisErrorFromServer(envelope: {
  code: string
  message: string
}): GeminiAnalysisError {
  switch (envelope.code) {
    case 'quota_exceeded':
      return new AnalysisQuotaExceededError(envelope.message)
    case 'timeout':
      return new AnalysisTimeoutError(envelope.message)
    case 'invalid_response':
    case 'invalid_request':
      return new AnalysisInvalidResponseError(envelope.message)
    case 'missing_key':
    case 'upstream_error':
    default:
      return new AnalysisUnavailableError(envelope.message)
  }
}
