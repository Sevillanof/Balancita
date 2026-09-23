import type {
  AnalysisClassification,
  AnalysisInput,
  AnalysisProvider,
  AnalysisResult,
  AnalysisVolatility,
} from '../../../domain/analysis.ts'
import {
  EDUCATIONAL_RECOMMENDATION_DISCLAIMER,
  type EducationalRecommendation,
} from '../../../domain/analysis.ts'
import type { Candle } from '../../market-data/domain/market-data.ts'
import {
  moneyAbs,
  moneyFromNumber,
  moneyFromString,
  moneyGte,
  moneyToDecimalString,
  type Money,
} from '../../../shared/finance/money.ts'
import { profitLossPercentOf } from '../../portfolio/domain/valuation'

/**
 * Deterministic local analysis. Same inputs always produce the same
 * classification, reasons and warnings — no PRNG, no wall clock, no network.
 *
 * The output keeps surveillance (`watch | neutral | review`) separate from an
 * educational recommendation. The recommendation is informational only and
 * never reaches the order simulator.
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
 * 1; otherwise neutral. Recommendation rules: contradictory trend signals or
 * high volatility always produce hold; a positive trend produces buy; a
 * negative trend produces sell only when a position exists; weak signals hold.
 * Reasons explain trend, volatility and portfolio context in Spanish.
 */
export class MockAnalysisProvider implements AnalysisProvider {
  async analyze(input: AnalysisInput): Promise<AnalysisResult> {
    const variation = variationSignal(input.quote.changePercent)
    const volatility = volatilityFromCandles(input.candles)
    const volatilitySeverity = severityFromVolatility(volatility)
    const position = positionSignal(input.holding, input.quote.price)
    const trend = trendSignal(input.quote.changePercent, input.candles)

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

    const recommendation = recommendationFor(trend, volatility, input.holding)
    const reasons = buildReasons(
      trend,
      volatility,
      volatilitySeverity,
      position,
    )
    const warnings = buildWarnings(
      input,
      variation,
      volatility,
      trend,
      recommendation,
    )

    return {
      instrumentId: input.instrumentId,
      classification,
      recommendation,
      reasons,
      warnings,
      volatility: {
        ...volatility,
        level: volatilityLevel(volatility.averageTrueRangePercent),
      },
      disclaimer: EDUCATIONAL_RECOMMENDATION_DISCLAIMER,
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

type TrendSignal = {
  direction: 'up' | 'down' | 'flat'
  quotePercent: number
  candlePercent: number | null
  contradictory: boolean
}

function trendSignal(
  quotePercent: number,
  candles: readonly Candle[],
): TrendSignal {
  const first = candles[0]
  const last = candles[candles.length - 1]
  const candlePercent =
    first === undefined || last === undefined || first.open === 0
      ? null
      : ((last.close - first.open) / first.open) * 100
  const quoteDirection = directionAtThreshold(quotePercent)
  const candleDirection =
    candlePercent === null ? null : directionAtThreshold(candlePercent)
  const contradictory =
    quoteDirection !== 'flat' &&
    candleDirection !== null &&
    candleDirection !== 'flat' &&
    quoteDirection !== candleDirection
  return {
    direction: contradictory
      ? 'flat'
      : quoteDirection !== 'flat'
        ? quoteDirection
        : (candleDirection ?? 'flat'),
    quotePercent,
    candlePercent,
    contradictory,
  }
}

function directionAtThreshold(percent: number): 'up' | 'down' | 'flat' {
  if (percent >= VARIATION_WATCH_PERCENT) return 'up'
  if (percent <= -VARIATION_WATCH_PERCENT) return 'down'
  return 'flat'
}

function recommendationFor(
  trend: TrendSignal,
  volatility: AnalysisVolatility,
  holding: AnalysisInput['holding'],
): EducationalRecommendation {
  if (trend.contradictory || volatility.level === 'high') return 'hold'
  if (trend.direction === 'up') return 'buy'
  if (trend.direction === 'down' && holding !== null) return 'sell'
  return 'hold'
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
  trend: TrendSignal,
  volatility: AnalysisVolatility,
  volatilitySeverity: SignalSeverity,
  position: PositionSignal,
): readonly string[] {
  const reasons: string[] = []
  if (trend.contradictory) {
    reasons.push(
      `La tendencia muestra señales contradictorias: la cotización varió ${trend.quotePercent.toFixed(2)}% y las velas ${trend.candlePercent?.toFixed(2)}%.`,
    )
  } else if (trend.direction === 'up') {
    reasons.push(
      `La tendencia positiva se apoya en una variación de cotización de ${trend.quotePercent.toFixed(2)}%${trend.candlePercent === null ? '' : ` y una variación de velas de ${trend.candlePercent.toFixed(2)}%`}.`,
    )
  } else if (trend.direction === 'down') {
    reasons.push(
      `La tendencia negativa se apoya en una variación de cotización de ${trend.quotePercent.toFixed(2)}%${trend.candlePercent === null ? '' : ` y una variación de velas de ${trend.candlePercent.toFixed(2)}%`}.`,
    )
  } else {
    reasons.push(
      'La tendencia actual es débil y no confirma una dirección clara.',
    )
  }
  if (volatilitySeverity === 1) {
    reasons.push(
      `La volatilidad es moderada: el rango verdadero promedio representa ${volatility.averageTrueRangePercent.toFixed(2)}% del precio.`,
    )
  } else if (volatilitySeverity === 2) {
    reasons.push(
      `La volatilidad es alta: el rango verdadero promedio representa ${volatility.averageTrueRangePercent.toFixed(2)}% del precio.`,
    )
  } else {
    reasons.push(
      `La volatilidad es baja: el rango verdadero promedio representa ${volatility.averageTrueRangePercent.toFixed(2)}% del precio.`,
    )
  }
  if (position.absPercent === null) {
    reasons.push(
      'La cartera no tiene una posición en este instrumento; no hay exposición que proteger.',
    )
  } else if (position.severity === 1) {
    reasons.push(
      `La posición registra una variación ${position.direction === 'up' ? 'positiva' : 'negativa'} de ${moneyToDecimalString(position.absPercent)}% sobre el costo promedio (no realizada).`,
    )
  } else if (position.severity === 2) {
    reasons.push(
      `La posición registra una variación ${position.direction === 'up' ? 'positiva' : 'negativa'} de ${moneyToDecimalString(position.absPercent)}%; revise el riesgo de la cartera.`,
    )
  } else if (position.absPercent !== null) {
    reasons.push(
      `La posición tiene una variación ${position.direction === 'up' ? 'positiva' : 'negativa'} de ${moneyToDecimalString(position.absPercent)}% sobre el costo promedio.`,
    )
  }
  return reasons
}

function buildWarnings(
  input: AnalysisInput,
  variation: VariationSignal,
  volatility: AnalysisVolatility,
  trend: TrendSignal,
  recommendation: EducationalRecommendation,
): readonly string[] {
  const warnings: string[] = []
  if (volatility.level === 'high') {
    warnings.push(
      'La volatilidad alta puede producir oscilaciones amplias; por prudencia, la recomendación educativa es Mantener.',
    )
  }
  if (variation.severity === 2) {
    warnings.push(
      'Una variación puntual de la cotización puede no sostenerse; verifique las próximas cotizaciones.',
    )
  }
  if (volatility.lookbackCandles === 0) {
    warnings.push('No hay historial de velas; no se pudo medir la volatilidad.')
  }
  if (input.assetClass === 'unknown') {
    warnings.push(
      'La identidad del instrumento no está confirmada (clase desconocida).',
    )
  }
  if (input.quote.status === 'stale') {
    warnings.push(
      'La cotización está marcada como desactualizada; el análisis puede haber perdido vigencia.',
    )
  }
  if (
    input.holding === null &&
    (variation.severity > 0 || volatility.level !== 'low')
  ) {
    warnings.push(
      'No hay una posición; el análisis describe vigilancia del instrumento y no exposición de cartera.',
    )
  }
  if (trend.contradictory) {
    warnings.push(
      'Hay señales contradictorias entre la cotización y las velas; por eso se recomienda Mantener.',
    )
  }
  if (recommendation === 'sell' && input.holding === null) {
    warnings.push(
      'No existe una posición; nunca se genera una recomendación de Vender.',
    )
  }
  return warnings
}
