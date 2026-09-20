import { AnalysisInvalidRequestError } from './analysis-errors.ts'

/**
 * Wire representation of an `AnalysisInput` crossing the HTTP boundary.
 * Portfolio holdings keep their decimal strings, matching how the frontend
 * stores them; no floating point money ever leaves the repository.
 */
export interface WireQuote {
  price: number
  change: number
  changePercent: number
  timestamp: string
  status: string
}

export interface WireCandle {
  time: string
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface WireHolding {
  quantity: string
  averageCost: string
}

export interface AnalysisInputRequest {
  instrumentId: string
  symbol: string
  assetClass: string
  currency: string
  quote: WireQuote
  candles: readonly WireCandle[]
  holding: WireHolding | null
}

export type AnalysisClassification = 'watch' | 'neutral' | 'review'
export type EducationalRecommendation = 'buy' | 'sell' | 'hold'

export interface AnalysisResultJson {
  instrumentId: string
  classification: AnalysisClassification
  recommendation: EducationalRecommendation
  reasons: readonly string[]
  warnings: readonly string[]
  volatility: {
    lookbackCandles: number
    averageTrueRangePercent: number
    level: 'low' | 'moderate' | 'high'
  }
  disclaimer: string
}

const DECIMAL_STRING_RE = /^\d+(?:\.\d{1,8})?$/
const CLASSIFICATIONS = new Set(['watch', 'neutral', 'review'])
const RECOMMENDATIONS = new Set(['buy', 'sell', 'hold'])
const VOLATILITY_LEVELS = new Set(['low', 'moderate', 'high'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function parseQuote(value: unknown): WireQuote {
  if (!isRecord(value)) throw invalid('The quote must be an object.')
  const { price, change, changePercent, timestamp, status } = value
  if (
    !isFiniteNumber(price) ||
    !isFiniteNumber(change) ||
    !isFiniteNumber(changePercent) ||
    !isNonEmptyString(timestamp) ||
    !isNonEmptyString(status)
  ) {
    throw invalid('The quote is missing valid numeric or string fields.')
  }
  return { price, change, changePercent, timestamp, status }
}

function parseCandle(value: unknown): WireCandle {
  if (!isRecord(value)) throw invalid('Each candle must be an object.')
  const { time, open, high, low, close, volume } = value
  if (
    !isNonEmptyString(time) ||
    !isFiniteNumber(open) ||
    !isFiniteNumber(high) ||
    !isFiniteNumber(low) ||
    !isFiniteNumber(close) ||
    !isFiniteNumber(volume)
  ) {
    throw invalid('Each candle must have a timestamp and finite OHLCV numbers.')
  }
  return { time, open, high, low, close, volume }
}

function parseHolding(value: unknown): WireHolding | null {
  if (value === null) return null
  if (!isRecord(value)) throw invalid('The holding must be an object or null.')
  const { quantity, averageCost } = value
  if (
    !isNonEmptyString(quantity) ||
    !isNonEmptyString(averageCost) ||
    !DECIMAL_STRING_RE.test(quantity) ||
    !DECIMAL_STRING_RE.test(averageCost)
  ) {
    throw invalid('The holding values must be positive decimal strings.')
  }
  return { quantity, averageCost }
}

function invalid(message: string): AnalysisInvalidRequestError {
  return new AnalysisInvalidRequestError(message)
}

/**
 * Parses and validates the request body. Candle history is truncated to the
 * last `maxCandles` entries so the prompt budget stays bounded. Throws
 * `AnalysisInvalidRequestError` when the payload is not a well-formed input.
 */
export function parseAnalysisInputRequest(
  value: unknown,
  maxCandles = 500,
): AnalysisInputRequest {
  if (!isRecord(value)) throw invalid('The request body must be an object.')
  const {
    instrumentId,
    symbol,
    assetClass,
    currency,
    quote,
    candles,
    holding,
  } = value
  if (
    !isNonEmptyString(instrumentId) ||
    !isNonEmptyString(symbol) ||
    !isNonEmptyString(assetClass) ||
    !isNonEmptyString(currency)
  ) {
    throw invalid('The request is missing its instrument identity fields.')
  }
  if (!Array.isArray(candles)) {
    throw invalid('The candles must be an array.')
  }
  const trimmed = maxCandles > 0 ? candles.slice(-maxCandles) : candles
  return {
    instrumentId,
    symbol,
    assetClass,
    currency,
    quote: parseQuote(quote),
    candles: trimmed.map(parseCandle),
    holding: parseHolding(holding),
  }
}

/**
 * Runtime guard for the structured JSON the model returns. Unknown extra
 * fields are tolerated so the model is free to add metadata; every field the
 * app depends on must be present and typed.
 */
export function isAnalysisResultJson(
  value: unknown,
): value is AnalysisResultJson {
  if (!isRecord(value)) return false
  const {
    instrumentId,
    classification,
    recommendation,
    reasons,
    warnings,
    volatility,
    disclaimer,
  } = value
  if (!isNonEmptyString(instrumentId)) return false
  if (
    typeof classification !== 'string' ||
    !CLASSIFICATIONS.has(classification)
  ) {
    return false
  }
  if (
    typeof recommendation !== 'string' ||
    !RECOMMENDATIONS.has(recommendation)
  ) {
    return false
  }
  if (!Array.isArray(reasons) || !reasons.every((r) => typeof r === 'string')) {
    return false
  }
  if (
    !Array.isArray(warnings) ||
    !warnings.every((w) => typeof w === 'string')
  ) {
    return false
  }
  if (!isRecord(volatility)) return false
  const { lookbackCandles, averageTrueRangePercent, level } = volatility
  if (
    !isFiniteNumber(lookbackCandles) ||
    !Number.isInteger(lookbackCandles) ||
    lookbackCandles < 0
  ) {
    return false
  }
  if (!isFiniteNumber(averageTrueRangePercent) || averageTrueRangePercent < 0) {
    return false
  }
  if (typeof level !== 'string' || !VOLATILITY_LEVELS.has(level)) {
    return false
  }
  if (!isNonEmptyString(disclaimer)) return false
  return true
}
