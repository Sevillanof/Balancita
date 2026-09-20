import type {
  AnalysisInput,
  AnalysisProvider,
  AnalysisResult,
  AnalysisVolatility,
} from '../domain/analysis'
import { ANALYSIS_CLASSIFICATIONS } from '../domain/analysis'
import {
  AnalysisInvalidResponseError,
  AnalysisUnavailableError,
  analysisErrorFromServer,
  type GeminiAnalysisError,
} from '../domain/analysis-errors'
import { moneyToDecimalString } from '../domain/money'

/** Body sent to the gateway; holding money travels as decimal strings. */
type GeminiWirePayload = {
  instrumentId: string
  symbol: string
  assetClass: string
  currency: string
  quote: unknown
  candles: readonly unknown[]
  holding: { quantity: string; averageCost: string } | null
}

type ServerEnvelope = {
  result?: unknown
  cached?: boolean
  error?: { code: string; message: string }
}

function isServerEnvelope(value: unknown): value is ServerEnvelope {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as ServerEnvelope
  return candidate.error !== undefined || candidate.result !== undefined
}

function isAnalysisResult(value: unknown): value is AnalysisResult {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as {
    instrumentId?: unknown
    classification?: unknown
    reasons?: unknown
    warnings?: unknown
    volatility?: unknown
  }
  if (typeof candidate.instrumentId !== 'string') return false
  if (
    typeof candidate.classification !== 'string' ||
    !ANALYSIS_CLASSIFICATIONS.includes(
      candidate.classification as (typeof ANALYSIS_CLASSIFICATIONS)[number],
    )
  ) {
    return false
  }
  if (
    !Array.isArray(candidate.reasons) ||
    !candidate.reasons.every((reason) => typeof reason === 'string')
  ) {
    return false
  }
  if (
    !Array.isArray(candidate.warnings) ||
    !candidate.warnings.every((warning) => typeof warning === 'string')
  ) {
    return false
  }
  if (!isVolatility(candidate.volatility)) return false
  return true
}

function isVolatility(value: unknown): value is AnalysisVolatility {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as AnalysisVolatility
  return (
    Number.isInteger(candidate.lookbackCandles) &&
    candidate.lookbackCandles >= 0 &&
    Number.isFinite(candidate.averageTrueRangePercent) &&
    candidate.averageTrueRangePercent >= 0 &&
    (candidate.level === 'low' ||
      candidate.level === 'moderate' ||
      candidate.level === 'high')
  )
}

/**
 * Remote analysis over the Gemini gateway via `POST {server}/api/analyze`.
 * The API key lives only on the server: the browser sends market data and
 * receives a validated verdict. Any network, parsing or shape failure maps to
 * a typed error so callers can fail closed without ever guessing.
 */
export class GeminiAnalysisProvider implements AnalysisProvider {
  private readonly serverUrl: string
  private readonly fetchImpl: typeof fetch

  constructor(
    serverUrl: string,
    fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {
    this.serverUrl = serverUrl.replace(/\/+$/, '')
    this.fetchImpl = fetchImpl
  }

  async analyze(input: AnalysisInput): Promise<AnalysisResult> {
    const payload: GeminiWirePayload = {
      instrumentId: input.instrumentId,
      symbol: input.symbol,
      assetClass: input.assetClass,
      currency: input.currency,
      quote: input.quote,
      candles: input.candles,
      holding:
        input.holding === null
          ? null
          : {
              quantity: moneyToDecimalString(input.holding.quantity),
              averageCost: moneyToDecimalString(input.holding.averageCost),
            },
    }

    let response: Response
    try {
      response = await this.fetchImpl(`${this.serverUrl}/api/analyze`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
    } catch (cause) {
      throw new AnalysisUnavailableError(
        'The Gemini analysis service could not be reached.',
        cause,
      )
    }

    if (!response.ok) {
      throw await this.errorFromHttpResponse(response)
    }

    let envelope: unknown
    try {
      envelope = await response.json()
    } catch (cause) {
      throw new AnalysisInvalidResponseError(
        'The Gemini analysis service returned a non-JSON response.',
        cause,
      )
    }

    if (!isServerEnvelope(envelope)) {
      throw new AnalysisInvalidResponseError(
        'The Gemini analysis service returned an unexpected envelope.',
      )
    }
    if (envelope.error !== undefined) {
      throw analysisErrorFromServer(envelope.error)
    }
    if (!isAnalysisResult(envelope.result)) {
      throw new AnalysisInvalidResponseError(
        'The Gemini analysis result does not match the expected shape.',
      )
    }
    return envelope.result
  }

  private async errorFromHttpResponse(
    response: Response,
  ): Promise<GeminiAnalysisError> {
    try {
      const parsed = (await response.json()) as unknown
      if (isServerEnvelope(parsed) && parsed.error !== undefined) {
        return analysisErrorFromServer(parsed.error)
      }
    } catch (cause) {
      throw new AnalysisUnavailableError(
        `The Gemini analysis service answered HTTP ${response.status} with an unreadable body.`,
        cause,
      )
    }
    throw new AnalysisUnavailableError(
      `The Gemini analysis service answered HTTP ${response.status} without a recognizable error.`,
    )
  }
}
