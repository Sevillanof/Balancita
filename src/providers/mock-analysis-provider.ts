import type {
  AnalysisClassification,
  AnalysisInput,
  AnalysisProvider,
  AnalysisResult,
  AnalysisVolatility,
} from '../domain/analysis'
import type { Candle } from '../domain/market-data'
import {
  moneyAbs,
  moneyFromNumber,
  moneyFromString,
  moneyGte,
  moneyToDecimalString,
  type Money,
} from '../domain/money'
import { profitLossPercentOf } from '../portfolio/valuation'

/**
 * Deterministic local analysis. Same inputs always produce the same
 * classification, reasons and warnings — no PRNG, no wall clock, no network.
 *
 * The output is a SURVEILLANCE judgment (how much attention the instrument
 * warrants), never a trading recommendation: only watch | neutral | review.
 *
 * Rules (explicit thresholds, all inclusive at the crossing):
 * - Variation, from the latest quote's `changePercent` v:
 *   severity 0 |v| < 2 | severity 1 |v| >= 2 | severity 2 |v| >= 5.
 * - Volatility, from a simple average true range (ATR) over the candles as a
 *   percentage of the latest close p:
 *   severity 0 p < 3 | severity 1 p >= 3 | severity 2 p >= 8.
 * - Portfolio position, from quantity x price vs average cost (decimal Money):
 *   severity 0 |P/L%| < 10 | severity 1 |P/L%| >= 10 | severity 2 |P/L%| >= 30.
 * Aggregation: review if any signal reaches severity 2 OR the three signals
 * sum to at least 3 (three watch-level signals); watch if the sum is at least
 * 1; otherwise neutral. Reasons list every contributing signal; warnings flag
 * data-quality and context caveats.
 */
export class MockAnalysisProvider implements AnalysisProvider {
  async analyze(input: AnalysisInput): Promise<AnalysisResult> {
    const variation = variationSignal(input.quote.changePercent)
    const volatility = volatilityFromCandles(input.candles)
    const volatilitySeverity = severityFromVolatility(volatility)
    const position = positionSignal(input.holding, input.quote.price)

    const score = variation.severity + volatilitySeverity + position.severity
    const classification: AnalysisClassification =
      variation.severity === 2 ||
      volatilitySeverity === 2 ||
      position.severity === 2 ||
      score >= 3
        ? 'review'
        : score >= 1
          ? 'watch'
          : 'neutral'

    const reasons = buildReasons(
      variation,
      volatility,
      volatilitySeverity,
      position,
    )
    const warnings = buildWarnings(input, variation, volatility)

    return {
      instrumentId: input.instrumentId,
      classification,
      reasons,
      warnings,
      volatility: {
        ...volatility,
        level: volatilityLevel(volatility.averageTrueRangePercent),
      },
    }
  }
}

type SignalSeverity = 0 | 1 | 2

const VARIATION_WATCH_PERCENT = 2
const VARIATION_REVIEW_PERCENT = 5
const VOLATILITY_MODERATE_PERCENT = 3
const VOLATILITY_HIGH_PERCENT = 8
const POSITION_WATCH_PERCENT = moneyFromString('10')
const POSITION_REVIEW_PERCENT = moneyFromString('30')

type VariationSignal = {
  severity: SignalSeverity
  direction: 'up' | 'down'
  absPercent: number
}

function variationSignal(changePercent: number): VariationSignal {
  const direction: 'up' | 'down' = changePercent >= 0 ? 'up' : 'down'
  const abs = Math.abs(changePercent)
  const severity: SignalSeverity =
    abs >= VARIATION_REVIEW_PERCENT ? 2 : abs >= VARIATION_WATCH_PERCENT ? 1 : 0
  return { severity, direction, absPercent: abs }
}

type PositionSignal = {
  severity: SignalSeverity
  direction: 'up' | 'down'
  absPercent: Money | null
}

function positionSignal(
  holding: AnalysisInput['holding'],
  price: number,
): PositionSignal {
  if (holding === null) {
    return { severity: 0, direction: 'up', absPercent: null }
  }
  const plPercent = profitLossPercentOf(
    {
      instrumentId: 'analysis',
      quantity: holding.quantity,
      averageCost: holding.averageCost,
    },
    moneyFromNumber(price),
  )
  const abs = moneyAbs(plPercent)
  const severity: SignalSeverity = moneyGte(abs, POSITION_REVIEW_PERCENT)
    ? 2
    : moneyGte(abs, POSITION_WATCH_PERCENT)
      ? 1
      : 0
  return {
    severity,
    direction: plPercent.units < 0n ? 'down' : 'up',
    absPercent: abs,
  }
}

/**
 * Simple ATR: each candle's true range is max(high-low, |high-prevClose|,
 * |low-prevClose|); the first candle uses its plain range. Reported as a
 * percentage of the latest close so it is scale independent.
 */
function volatilityFromCandles(candles: readonly Candle[]): AnalysisVolatility {
  if (candles.length === 0) {
    return { lookbackCandles: 0, averageTrueRangePercent: 0, level: 'low' }
  }
  let sum = 0
  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index]!
    const range = candle.high - candle.low
    if (index === 0) {
      sum += range
      continue
    }
    const previousClose = candles[index - 1]!.close
    sum += Math.max(
      range,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose),
    )
  }
  const latestClose = candles[candles.length - 1]!.close
  const percent =
    latestClose === 0 ? 0 : (sum / candles.length / latestClose) * 100
  return {
    lookbackCandles: candles.length,
    averageTrueRangePercent: percent,
    level: volatilityLevel(percent),
  }
}

function volatilityLevel(percent: number): AnalysisVolatility['level'] {
  return percent >= VOLATILITY_HIGH_PERCENT
    ? 'high'
    : percent >= VOLATILITY_MODERATE_PERCENT
      ? 'moderate'
      : 'low'
}

function severityFromVolatility(
  volatility: AnalysisVolatility,
): SignalSeverity {
  const percent = volatility.averageTrueRangePercent
  return percent >= VOLATILITY_HIGH_PERCENT
    ? 2
    : percent >= VOLATILITY_MODERATE_PERCENT
      ? 1
      : 0
}

function buildReasons(
  variation: VariationSignal,
  volatility: AnalysisVolatility,
  volatilitySeverity: SignalSeverity,
  position: PositionSignal,
): readonly string[] {
  const reasons: string[] = []
  if (variation.severity === 1) {
    reasons.push(
      `Latest quote moved ${variation.direction} ${variation.absPercent.toFixed(2)}%; noteworthy move.`,
    )
  } else if (variation.severity === 2) {
    reasons.push(
      `Large single-quote move ${variation.direction} ${variation.absPercent.toFixed(2)}%; warrants review.`,
    )
  }
  if (volatilitySeverity === 1) {
    reasons.push(
      `Elevated volatility: average true range ${volatility.averageTrueRangePercent.toFixed(2)}% of price.`,
    )
  } else if (volatilitySeverity === 2) {
    reasons.push(
      `High volatility: average true range ${volatility.averageTrueRangePercent.toFixed(2)}% of price.`,
    )
  }
  if (position.severity === 1 && position.absPercent !== null) {
    reasons.push(
      `Position is ${position.direction} ${moneyToDecimalString(position.absPercent)}% on average cost (unrealized).`,
    )
  } else if (position.severity === 2 && position.absPercent !== null) {
    reasons.push(
      `Unrealized position is ${position.direction} ${moneyToDecimalString(position.absPercent)}%; review position risk.`,
    )
  }
  if (reasons.length === 0) {
    reasons.push(
      'No significant variation, volatility or position risk detected.',
    )
  }
  return reasons
}

function buildWarnings(
  input: AnalysisInput,
  variation: VariationSignal,
  volatility: AnalysisVolatility,
): readonly string[] {
  const warnings: string[] = []
  if (volatility.level === 'high') {
    warnings.push(
      'High volatility can produce wide swings; monitor quotes closely.',
    )
  }
  if (variation.severity === 2) {
    warnings.push(
      'A single quote move may not persist; verify on the next quotes.',
    )
  }
  if (volatility.lookbackCandles === 0) {
    warnings.push(
      'No candle history available; volatility could not be measured.',
    )
  }
  if (input.assetClass === 'unknown') {
    warnings.push('Instrument identity is unconfirmed (unknown asset class).')
  }
  if (input.quote.status === 'stale') {
    warnings.push('Quote is marked stale; the assessment may be outdated.')
  }
  if (
    input.holding === null &&
    (variation.severity > 0 || volatility.level !== 'low')
  ) {
    warnings.push(
      'No position held; this assessment covers instrument surveillance only.',
    )
  }
  return warnings
}
