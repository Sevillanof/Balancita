/**
 * Typed failure modes of the analysis gateway. Each carries a stable `code`
 * that the HTTP envelope maps to a JSON `{ error: { code, message } }` body,
 * and that the browser provider maps back to a typed error.
 */

export type AnalysisGatewayErrorCode =
  | 'quota_exceeded'
  | 'timeout'
  | 'invalid_response'
  | 'invalid_request'
  | 'missing_key'
  | 'upstream_error'
  | 'server_config'

export class AnalysisQuotaExceededError extends Error {
  readonly code = 'quota_exceeded' as const

  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'AnalysisQuotaExceededError'
  }
}

export class AnalysisTimeoutError extends Error {
  readonly code = 'timeout' as const

  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'AnalysisTimeoutError'
  }
}

export class AnalysisInvalidResponseError extends Error {
  readonly code = 'invalid_response' as const

  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'AnalysisInvalidResponseError'
  }
}

export class AnalysisInvalidRequestError extends Error {
  readonly code = 'invalid_request' as const

  constructor(message: string) {
    super(message)
    this.name = 'AnalysisInvalidRequestError'
  }
}

export class AnalysisMissingKeyError extends Error {
  readonly code = 'missing_key' as const

  constructor(message: string) {
    super(message)
    this.name = 'AnalysisMissingKeyError'
  }
}

export class AnalysisUpstreamError extends Error {
  readonly code = 'upstream_error' as const

  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'AnalysisUpstreamError'
  }
}

export class ServerConfigError extends Error {
  readonly code = 'server_config' as const

  constructor(message: string) {
    super(message)
    this.name = 'ServerConfigError'
  }
}
