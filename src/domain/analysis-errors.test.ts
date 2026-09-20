import { describe, expect, it } from 'vitest'
import {
  AnalysisInvalidResponseError,
  AnalysisQuotaExceededError,
  AnalysisUnavailableError,
  analysisErrorFromServer,
} from './analysis-errors'

describe('analysisErrorFromServer', () => {
  it('maps quota_exceeded to a typed quota error', () => {
    const error = analysisErrorFromServer({
      code: 'quota_exceeded',
      message: 'limit',
    })
    expect(error).toBeInstanceOf(AnalysisQuotaExceededError)
    expect(error.code).toBe('quota_exceeded')
    expect(error.message).toBe('limit')
  })

  it('maps timeout to a typed timeout error', () => {
    expect(
      analysisErrorFromServer({ code: 'timeout', message: 'slow' }).code,
    ).toBe('timeout')
  })

  it('maps invalid_response to a typed response error', () => {
    const error = analysisErrorFromServer({
      code: 'invalid_response',
      message: 'shape',
    })
    expect(error).toBeInstanceOf(AnalysisInvalidResponseError)
  })

  it('maps missing_key and upstream_error to an unavailable error', () => {
    expect(
      analysisErrorFromServer({ code: 'missing_key', message: 'x' }),
    ).toBeInstanceOf(AnalysisUnavailableError)
    expect(
      analysisErrorFromServer({ code: 'upstream_error', message: 'x' }),
    ).toBeInstanceOf(AnalysisUnavailableError)
    expect(
      analysisErrorFromServer({ code: 'bad_request', message: 'x' }),
    ).toBeInstanceOf(AnalysisUnavailableError)
  })

  it('falls back to an unavailable error for unknown codes', () => {
    const error = analysisErrorFromServer({ code: 'warp_drive', message: 'x' })
    expect(error).toBeInstanceOf(AnalysisUnavailableError)
  })
})
