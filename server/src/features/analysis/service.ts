import {
  AnalysisInvalidResponseError,
  AnalysisQuotaExceededError,
  AnalysisTimeoutError,
  AnalysisUpstreamError,
} from '../../platform/analysis-errors.ts'
import { AnalysisCache, hashAnalysisInput } from '../../platform/cache.ts'
import type { GeminiClient } from '../../platform/gemini/gemini-client.ts'
import { AnalysisRateLimiter } from '../../platform/limits.ts'
import { buildAnalysisPrompt } from '../../platform/gemini/prompt.ts'
import {
  isAnalysisResultJson,
  type AnalysisInputRequest,
  type AnalysisResultJson,
} from './wire.ts'

/**
 * JSON Schema passed to Gemini as `responseJsonSchema`. The model is allowed
 * to attach extra fields (additionalProperties true) but every field the app
 * depends on is required and typed.
 */
export const ANALYSIS_RESULT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    instrumentId: { type: 'string' },
    classification: { enum: ['watch', 'neutral', 'review'] },
    recommendation: { enum: ['buy', 'sell', 'hold'] },
    reasons: { type: 'array', items: { type: 'string' } },
    warnings: { type: 'array', items: { type: 'string' } },
    volatility: {
      type: 'object',
      properties: {
        lookbackCandles: { type: 'integer', minimum: 0 },
        averageTrueRangePercent: { type: 'number', minimum: 0 },
        level: { enum: ['low', 'moderate', 'high'] },
      },
      required: ['lookbackCandles', 'averageTrueRangePercent', 'level'],
    },
    disclaimer: { type: 'string' },
  },
  required: [
    'instrumentId',
    'classification',
    'recommendation',
    'reasons',
    'warnings',
    'volatility',
    'disclaimer',
  ],
  additionalProperties: true,
} as const

export interface AnalyzeOutcome {
  result: AnalysisResultJson
  cached: boolean
}

export interface AnalyzeServiceDeps {
  client: GeminiClient
  limiter: AnalysisRateLimiter
  cache: AnalysisCache
  model: string
  maxOutputTokens: number
  timeoutMs: number
}

function isTimeoutCause(cause: unknown): boolean {
  if (!(cause instanceof Error)) return false
  return cause.name === 'TimeoutError' || cause.name === 'AbortError'
}

function isQuotaCause(cause: unknown): boolean {
  if (typeof cause !== 'object' || cause === null) return false
  const candidate = cause as {
    status?: unknown
    statusCode?: unknown
    code?: unknown
  }
  return (
    candidate.status === 429 ||
    candidate.statusCode === 429 ||
    candidate.code === 429
  )
}

/**
 * Orchestrates one analysis request: cache first, then rate budget, then the
 * model call under a hard timeout. Any failure surfaces as a typed error so
 * the HTTP layer can map it to a stable envelope.
 */
export class AnalyzeService {
  private readonly client: GeminiClient
  private readonly limiter: AnalysisRateLimiter
  private readonly cache: AnalysisCache
  private readonly model: string
  private readonly maxOutputTokens: number
  private readonly timeoutMs: number

  constructor(deps: AnalyzeServiceDeps) {
    this.client = deps.client
    this.limiter = deps.limiter
    this.cache = deps.cache
    this.model = deps.model
    this.maxOutputTokens = deps.maxOutputTokens
    this.timeoutMs = deps.timeoutMs
  }

  async analyze(input: AnalysisInputRequest): Promise<AnalyzeOutcome> {
    const key = hashAnalysisInput(input)
    const cached = this.cache.get(key)
    if (cached !== undefined) {
      return { result: cached, cached: true }
    }

    if (!this.limiter.tryConsume()) {
      throw new AnalysisQuotaExceededError(
        'Gemini usage is over the configured rate limit right now; try again later.',
      )
    }

    let text: string
    try {
      text = await this.client.generateStructuredText({
        model: this.model,
        prompt: buildAnalysisPrompt(input),
        maxOutputTokens: this.maxOutputTokens,
        signal: AbortSignal.timeout(this.timeoutMs),
        jsonSchema: ANALYSIS_RESULT_JSON_SCHEMA,
      })
    } catch (cause) {
      if (isTimeoutCause(cause)) {
        throw new AnalysisTimeoutError(
          `Gemini did not respond within ${this.timeoutMs}ms; the request was aborted.`,
          cause,
        )
      }
      if (isQuotaCause(cause)) {
        throw new AnalysisQuotaExceededError(
          'Gemini rate limits were hit; try again later.',
          cause,
        )
      }
      throw new AnalysisUpstreamError(
        'The Gemini request could not be completed.',
        cause,
      )
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (cause) {
      throw new AnalysisInvalidResponseError(
        'Gemini returned text that is not valid JSON.',
        cause,
      )
    }
    if (!isAnalysisResultJson(parsed)) {
      throw new AnalysisInvalidResponseError(
        'Gemini returned JSON that does not match the expected analysis shape.',
      )
    }

    this.cache.set(key, parsed)
    return { result: parsed, cached: false }
  }
}
