import type {
  Candle,
  Instrument,
  InstrumentCurrency,
  Quote,
} from './market-data'
import type { Money } from './money'
import type { Holding } from './portfolio'

export const ANALYSIS_CLASSIFICATIONS = ['watch', 'neutral', 'review'] as const

export type AnalysisClassification = (typeof ANALYSIS_CLASSIFICATIONS)[number]

/**
 * Volatility measure derived deterministically from candles. Based on a simple
 * average true range (ATR) expressed as a percentage of the latest close, so a
 * mock provider can reason about it without any market API. Numbers are
 * measurements over display data, never monetary arithmetic.
 */
export interface AnalysisVolatility {
  /** Number of candles used as the ATR lookback window. */
  lookbackCandles: number
  /** Average true range as a percentage of the latest close price. */
  averageTrueRangePercent: number
  level: 'low' | 'moderate' | 'high'
}

/**
 * Portfolio exposure of the analyzed instrument. Kept in decimal Money on
 * purpose: quantities, costs and derived P/L must never use floating point.
 */
export interface AnalysisHolding {
  quantity: Money
  averageCost: Money
}

export interface AnalysisInput {
  instrumentId: string
  symbol: string
  assetClass: Instrument['assetClass']
  currency: InstrumentCurrency
  quote: Quote
  candles: readonly Candle[]
  /** Current portfolio position for this instrument, if any. */
  holding: AnalysisHolding | null
}

/**
 * Result of a surveillance/review pass. The classification expresses how much
 * attention the instrument warrants, NEVER a buy or sell recommendation.
 */
export interface AnalysisResult {
  instrumentId: string
  classification: AnalysisClassification
  reasons: readonly string[]
  warnings: readonly string[]
  volatility: AnalysisVolatility
}

/**
 * Contract for local or external analysis. The concrete provider stays behind
 * this surface; results are advisory and never authorized to move money.
 */
export interface AnalysisProvider {
  analyze(input: AnalysisInput): Promise<AnalysisResult>
}

/**
 * Builds the analysis input at the data frontier: the latest quote, the candle
 * history and the holding for this instrument (when held). Portfolio values are
 * forwarded as-is in decimal Money; no float conversion happens here.
 */
export function analysisInputFrom(params: {
  instrument: Instrument
  quote: Quote
  candles: readonly Candle[]
  holdings?: readonly Holding[]
}): AnalysisInput {
  const { instrument, quote, candles, holdings = [] } = params
  const match = holdings.find(
    (holding) => holding.instrumentId === instrument.id,
  )
  return {
    instrumentId: instrument.id,
    symbol: instrument.symbol,
    assetClass: instrument.assetClass,
    currency: instrument.currency,
    quote,
    candles,
    holding:
      match === undefined
        ? null
        : { quantity: match.quantity, averageCost: match.averageCost },
  }
}
