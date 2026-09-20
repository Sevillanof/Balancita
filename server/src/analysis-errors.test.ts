import { describe, expect, it } from 'vitest'
import {
  AnalysisInvalidRequestError,
  AnalysisInvalidResponseError,
  AnalysisMissingKeyError,
  AnalysisQuotaExceededError,
  AnalysisTimeoutError,
  AnalysisUpstreamError,
  ServerConfigError,
} from './analysis-errors.ts'

describe('analysis gateway errors', () => {
  const cases: Array<[string, () => Error, string]> = [
    [
      'AnalysisQuotaExceededError',
      () => new AnalysisQuotaExceededError('over budget'),
      'AnalysisQuotaExceededError',
    ],
    [
      'AnalysisTimeoutError',
      () => new AnalysisTimeoutError('took too long'),
      'AnalysisTimeoutError',
    ],
    [
      'AnalysisInvalidResponseError',
      () => new AnalysisInvalidResponseError('bad json'),
      'AnalysisInvalidResponseError',
    ],
    [
      'AnalysisInvalidRequestError',
      () => new AnalysisInvalidRequestError('bad body'),
      'AnalysisInvalidRequestError',
    ],
    [
      'AnalysisMissingKeyError',
      () => new AnalysisMissingKeyError('no key'),
      'AnalysisMissingKeyError',
    ],
    [
      'AnalysisUpstreamError',
      () => new AnalysisUpstreamError('gemini down'),
      'AnalysisUpstreamError',
    ],
    [
      'ServerConfigError',
      () => new ServerConfigError('bad config'),
      'ServerConfigError',
    ],
  ]

  it('exposes an identifiable name and keeps the message', () => {
    for (const [label, make, name] of cases) {
      const error = make()
      expect(error).toBeInstanceOf(Error)
      expect(error.name).toBe(name)
      expect(error.message.length).toBeGreaterThan(0)
      expect(String(label)).toBe(label)
    }
  })

  it('carries a stable machine code used by the HTTP envelope', () => {
    const withCode = [
      new AnalysisQuotaExceededError('over budget'),
      new AnalysisTimeoutError('late'),
      new AnalysisInvalidResponseError('shape mismatch'),
      new AnalysisInvalidRequestError('bad body'),
      new AnalysisMissingKeyError('no key'),
      new AnalysisUpstreamError('down'),
    ]
    const codes = withCode.map((error) => error.code)
    expect(codes).toEqual([
      'quota_exceeded',
      'timeout',
      'invalid_response',
      'invalid_request',
      'missing_key',
      'upstream_error',
    ])
  })
})
