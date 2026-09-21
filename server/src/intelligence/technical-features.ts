import type { TechnicalFeatureSnapshot, TimestampMs } from './contracts.ts'
import type {
  CandleInterval,
  IntradayCandle,
} from './market/intraday-candles.ts'

export const TECHNICAL_FEATURE_VERSION = 'technical-features.v1'
export const DEFAULT_PARAM_SET_VERSION = 'technical-defaults.v1'

export type StructuralTrend = 'up' | 'down' | 'flat'

export interface TechnicalCandle extends IntradayCandle {
  readonly interval: CandleInterval
}

export interface TechnicalIndicatorValues {
  readonly sma: number | null
  readonly ema: number | null
  readonly rsi: number | null
  readonly macdLine: number | null
  readonly macdSignal: number | null
  readonly macdHistogram: number | null
  readonly atr: number | null
  readonly structuralSlope: number | null
  readonly structuralTrend: StructuralTrend | null
}

export interface TechnicalFeatureParams {
  readonly smaPeriod: number
  readonly emaPeriod: number
  readonly rsiPeriod: number
  readonly macdFastPeriod: number
  readonly macdSlowPeriod: number
  readonly macdSignalPeriod: number
  readonly atrPeriod: number
  readonly slopePeriod: number
  readonly trendFlatThreshold?: number
  readonly paramSetVersion?: string
}

export const DEFAULT_TECHNICAL_PARAMS: TechnicalFeatureParams = {
  smaPeriod: 20,
  emaPeriod: 20,
  rsiPeriod: 14,
  macdFastPeriod: 12,
  macdSlowPeriod: 26,
  macdSignalPeriod: 9,
  atrPeriod: 14,
  slopePeriod: 20,
  trendFlatThreshold: 0,
  paramSetVersion: DEFAULT_PARAM_SET_VERSION,
}

export interface TechnicalFeatureResult {
  readonly technicalFeatureVersion: string
  readonly paramSetVersion: string
  readonly version: string
  readonly asOfTimestamp: TimestampMs
  readonly isClosed: true
  readonly ready: boolean
  readonly candlesUsed: number
  readonly ignoredOpenCandleCount: number
  readonly warmUp: {
    readonly requiredCandles: number
    readonly availableCandles: number
    readonly missingCandles: number
  }
  readonly readiness: Readonly<Record<keyof TechnicalIndicatorValues, boolean>>
  readonly indicators: TechnicalIndicatorValues
  readonly values: Readonly<Record<string, number>>
  readonly signalPolicy: 'descriptive_indicators_not_combined'
}

export interface TechnicalFeatureInput {
  readonly candles: readonly TechnicalCandle[]
  readonly asOfTimestamp: TimestampMs
  readonly params?: TechnicalFeatureParams
}

export class TechnicalFeatureValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TechnicalFeatureValidationError'
  }
}

export function computeTechnicalFeatures(
  input: TechnicalFeatureInput,
): TechnicalFeatureResult {
  if (!validTimestamp(input.asOfTimestamp))
    throw new TechnicalFeatureValidationError(
      'Feature cutoff must be a non-negative epoch millisecond.',
    )
  const params = { ...DEFAULT_TECHNICAL_PARAMS, ...input.params }
  validateParams(params)
  input.candles.forEach(validateCandle)
  const sorted = [...input.candles].sort(
    (left, right) => left.bucketStart - right.bucketStart,
  )
  const closed = sorted.filter(
    (candle) => candle.isClosed && candle.bucketEnd <= input.asOfTimestamp,
  )
  const ignoredOpenCandleCount = sorted.length - closed.length
  const closes = closed.map((candle) => candle.close)
  const requiredCandles = Math.max(
    params.smaPeriod,
    params.emaPeriod,
    params.rsiPeriod + 1,
    params.macdSlowPeriod + params.macdSignalPeriod - 1,
    params.atrPeriod + 1,
    params.slopePeriod,
  )
  const structuralSlope = linearSlope(closes, params.slopePeriod)
  const structuralTrend =
    structuralSlope === null
      ? null
      : Math.abs(structuralSlope) <= (params.trendFlatThreshold ?? 0)
        ? 'flat'
        : structuralSlope > 0
          ? 'up'
          : 'down'
  const indicators: TechnicalIndicatorValues = {
    sma: sma(closes, params.smaPeriod),
    ema: ema(closes, params.emaPeriod),
    rsi: rsi(closes, params.rsiPeriod),
    ...macd(
      closes,
      params.macdFastPeriod,
      params.macdSlowPeriod,
      params.macdSignalPeriod,
    ),
    atr: averageTrueRange(closed, params.atrPeriod),
    structuralSlope,
    structuralTrend,
  }

  const readiness = {
    sma: indicators.sma !== null,
    ema: indicators.ema !== null,
    rsi: indicators.rsi !== null,
    macdLine: indicators.macdLine !== null,
    macdSignal: indicators.macdSignal !== null,
    macdHistogram: indicators.macdHistogram !== null,
    atr: indicators.atr !== null,
    structuralSlope: indicators.structuralSlope !== null,
    structuralTrend: indicators.structuralTrend !== null,
  }
  const values: Record<string, number> = {}
  for (const [key, value] of Object.entries(indicators)) {
    if (typeof value === 'number') values[key] = finite(value, key)
  }
  const ready = Object.values(readiness).every(Boolean)
  return {
    technicalFeatureVersion: TECHNICAL_FEATURE_VERSION,
    paramSetVersion: params.paramSetVersion ?? DEFAULT_PARAM_SET_VERSION,
    version: TECHNICAL_FEATURE_VERSION,
    asOfTimestamp: input.asOfTimestamp,
    isClosed: true,
    ready,
    candlesUsed: closed.length,
    ignoredOpenCandleCount,
    warmUp: {
      requiredCandles,
      availableCandles: closed.length,
      missingCandles: Math.max(0, requiredCandles - closed.length),
    },
    readiness,
    indicators,
    values,
    signalPolicy: 'descriptive_indicators_not_combined',
  }
}

export function toTechnicalFeatureSnapshot(
  result: TechnicalFeatureResult,
): TechnicalFeatureSnapshot {
  if (!result.ready)
    throw new TechnicalFeatureValidationError(
      'Technical features are not ready for forecast evidence.',
    )
  return {
    version: result.technicalFeatureVersion,
    asOfTimestamp: result.asOfTimestamp,
    isClosed: true,
    ready: true,
    warmUp: result.warmUp,
    values: result.values,
  }
}

function validateParams(params: TechnicalFeatureParams): void {
  const periods = [
    ['smaPeriod', params.smaPeriod],
    ['emaPeriod', params.emaPeriod],
    ['rsiPeriod', params.rsiPeriod],
    ['macdFastPeriod', params.macdFastPeriod],
    ['macdSlowPeriod', params.macdSlowPeriod],
    ['macdSignalPeriod', params.macdSignalPeriod],
    ['atrPeriod', params.atrPeriod],
    ['slopePeriod', params.slopePeriod],
  ] as const
  for (const [name, period] of periods) {
    if (!Number.isSafeInteger(period) || period < 1)
      throw new TechnicalFeatureValidationError(
        `${name} must be a positive integer.`,
      )
  }
  if (params.macdFastPeriod >= params.macdSlowPeriod)
    throw new TechnicalFeatureValidationError(
      'macdFastPeriod must be lower than macdSlowPeriod.',
    )
  const threshold = params.trendFlatThreshold ?? 0
  if (!Number.isFinite(threshold) || threshold < 0)
    throw new TechnicalFeatureValidationError(
      'trendFlatThreshold must be finite and non-negative.',
    )
  if (
    params.paramSetVersion !== undefined &&
    params.paramSetVersion.trim().length === 0
  )
    throw new TechnicalFeatureValidationError('paramSetVersion is required.')
}

function validateCandle(candle: TechnicalCandle): void {
  if (
    !validTimestamp(candle.bucketStart) ||
    !validTimestamp(candle.bucketEnd) ||
    candle.bucketEnd <= candle.bucketStart ||
    !validTimestamp(candle.eventTimeStart) ||
    !validTimestamp(candle.eventTimeEnd) ||
    !validTimestamp(candle.receivedTimeStart) ||
    !validTimestamp(candle.receivedTimeEnd) ||
    !validTimestamp(candle.displayTimeStart) ||
    !validTimestamp(candle.displayTimeEnd) ||
    !Number.isFinite(candle.open) ||
    !Number.isFinite(candle.high) ||
    !Number.isFinite(candle.low) ||
    !Number.isFinite(candle.close) ||
    !Number.isFinite(candle.volume) ||
    candle.open <= 0 ||
    candle.high <= 0 ||
    candle.low <= 0 ||
    candle.close <= 0 ||
    candle.volume < 0 ||
    candle.high < Math.max(candle.open, candle.close) ||
    candle.low > Math.min(candle.open, candle.close)
  )
    throw new TechnicalFeatureValidationError(
      'Candle values or timestamps are invalid.',
    )
}

function sma(values: readonly number[], period: number): number | null {
  if (values.length < period) return null
  return finite(
    values
      .slice(values.length - period)
      .reduce((sum, value) => sum + value, 0) / period,
    'sma',
  )
}

function ema(values: readonly number[], period: number): number | null {
  const series = emaSeries(values, period)
  return series[series.length - 1] ?? null
}

function emaSeries(
  values: readonly number[],
  period: number,
): readonly number[] {
  if (values.length < period) return []
  const alpha = 2 / (period + 1)
  let current =
    values.slice(0, period).reduce((sum, value) => sum + value, 0) / period
  const result = [finite(current, 'ema')]
  for (let index = period; index < values.length; index += 1) {
    current = values[index] * alpha + current * (1 - alpha)
    result.push(finite(current, 'ema'))
  }
  return result
}

function rsi(values: readonly number[], period: number): number | null {
  if (values.length < period + 1) return null
  let gain = 0
  let loss = 0
  for (let index = 1; index <= period; index += 1) {
    const delta = values[index] - values[index - 1]
    gain += Math.max(delta, 0)
    loss += Math.max(-delta, 0)
  }
  gain /= period
  loss /= period
  for (let index = period + 1; index < values.length; index += 1) {
    const delta = values[index] - values[index - 1]
    gain = (gain * (period - 1) + Math.max(delta, 0)) / period
    loss = (loss * (period - 1) + Math.max(-delta, 0)) / period
  }
  return finite(relativeStrengthIndex(gain, loss), 'rsi')
}

function relativeStrengthIndex(gain: number, loss: number): number {
  if (loss === 0) return gain === 0 ? 50 : 100
  if (gain === 0) return 0
  return 100 - 100 / (1 + gain / loss)
}

function macd(
  values: readonly number[],
  fastPeriod: number,
  slowPeriod: number,
  signalPeriod: number,
): Pick<TechnicalIndicatorValues, 'macdLine' | 'macdSignal' | 'macdHistogram'> {
  const fast = emaSeries(values, fastPeriod)
  const slow = emaSeries(values, slowPeriod)
  if (slow.length === 0)
    return { macdLine: null, macdSignal: null, macdHistogram: null }
  const macdValues: number[] = []
  const fastOffset = slowPeriod - fastPeriod
  for (let index = 0; index < slow.length; index += 1) {
    const fastValue = fast[index + fastOffset]
    const slowValue = slow[index]
    if (fastValue === undefined || slowValue === undefined) continue
    macdValues.push(finite(fastValue - slowValue, 'macdLine'))
  }
  const line = macdValues[macdValues.length - 1] ?? null
  const signalSeries = emaSeries(macdValues, signalPeriod)
  const signal = signalSeries[signalSeries.length - 1] ?? null
  return {
    macdLine: line,
    macdSignal: signal,
    macdHistogram:
      line !== null && signal !== null
        ? finite(line - signal, 'macdHistogram')
        : null,
  }
}

function averageTrueRange(
  candles: readonly TechnicalCandle[],
  period: number,
): number | null {
  if (candles.length < period + 1) return null
  const trueRanges: number[] = []
  for (let index = 1; index < candles.length; index += 1) {
    const current = candles[index]
    const previous = candles[index - 1]
    trueRanges.push(
      finite(
        Math.max(
          current.high - current.low,
          Math.abs(current.high - previous.close),
          Math.abs(current.low - previous.close),
        ),
        'atr',
      ),
    )
  }
  let current =
    trueRanges.slice(0, period).reduce((sum, value) => sum + value, 0) / period
  for (let index = period; index < trueRanges.length; index += 1)
    current = (current * (period - 1) + trueRanges[index]) / period
  return finite(current, 'atr')
}

function linearSlope(values: readonly number[], period: number): number | null {
  if (values.length < period) return null
  const sample = values.slice(values.length - period)
  const meanX = (period - 1) / 2
  const meanY = sample.reduce((sum, value) => sum + value, 0) / period
  let numerator = 0
  let denominator = 0
  sample.forEach((value, index) => {
    numerator += (index - meanX) * (value - meanY)
    denominator += (index - meanX) ** 2
  })
  return finite(numerator / denominator, 'structuralSlope')
}

function finite(value: number, name: string): number {
  if (!Number.isFinite(value))
    throw new TechnicalFeatureValidationError(
      `${name} produced a non-finite value.`,
    )
  return value
}

function validTimestamp(value: unknown): value is TimestampMs {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
