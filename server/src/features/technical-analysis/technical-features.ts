import type {
  TechnicalFeatureSnapshot,
  TimestampMs,
} from '../../domain/contracts.ts'
import type {
  CandleInterval,
  IntradayCandle,
} from '../market-data/intraday-candles.ts'

export const TECHNICAL_FEATURE_VERSION = 'technical-features.v1'
export const MICRO_TECHNICAL_FEATURE_VERSION = 'technical-features.micro.v1'
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
  readonly rolling: RollingMarketFeatures
  readonly micro: MicroTechnicalFeatures
  readonly values: Readonly<Record<string, number>>
  readonly signalPolicy: 'descriptive_indicators_not_combined'
}

export interface RollingMarketFeatures {
  readonly bollingerMid: number | null
  readonly bollingerUpper: number | null
  readonly bollingerLower: number | null
  /** Donchian window excludes the current closed bar. */
  readonly donchianHigh: number | null
  readonly donchianLow: number | null
  readonly donchianMid: number | null
  /** Volume mean excludes the current closed bar. */
  readonly volumeSma: number | null
  readonly atrPercentile: number | null
  readonly priorAtrSma20: number | null
}

export interface MicroTechnicalFeatures {
  readonly ema9: number | null
  readonly ema21: number | null
  readonly sma50: number | null
  readonly rsi14: number | null
  readonly ready: boolean
}

export interface TechnicalFeatureInput {
  readonly candles: readonly TechnicalCandle[]
  readonly asOfTimestamp: TimestampMs
  readonly params?: TechnicalFeatureParams
  /** Opt-in so the frozen legacy feature/snapshot path stays byte-identical. */
  readonly includeMicroFeatures?: boolean
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
  const rolling = input.includeMicroFeatures
    ? rollingMarketFeatures(closed, params.atrPeriod)
    : EMPTY_ROLLING_FEATURES
  const micro: MicroTechnicalFeatures = {
    ema9: input.includeMicroFeatures ? ema(closes, 9) : null,
    ema21: input.includeMicroFeatures ? ema(closes, 21) : null,
    sma50: input.includeMicroFeatures ? sma(closes, 50) : null,
    rsi14: input.includeMicroFeatures ? rsi(closes, 14) : null,
    ready: false,
  }
  const microReady =
    micro.ema9 !== null &&
    micro.ema21 !== null &&
    micro.sma50 !== null &&
    micro.rsi14 !== null &&
    rolling.bollingerLower !== null &&
    rolling.bollingerMid !== null &&
    rolling.donchianHigh !== null &&
    rolling.donchianMid !== null &&
    rolling.volumeSma !== null &&
    rolling.atrPercentile !== null &&
    rolling.priorAtrSma20 !== null &&
    indicators.atr !== null
  const readyMicro: MicroTechnicalFeatures = { ...micro, ready: microReady }

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
    rolling,
    micro: readyMicro,
    values,
    signalPolicy: 'descriptive_indicators_not_combined',
  }
}

function rollingMarketFeatures(
  candles: readonly TechnicalCandle[],
  atrPeriod: number,
): RollingMarketFeatures {
  const closes = candles.map(({ close }) => close)
  const bollingerValues = closes.slice(-20)
  const bollingerReady = bollingerValues.length === 20
  const bollingerMid = bollingerReady
    ? bollingerValues.reduce((sum, value) => sum + value, 0) / 20
    : null
  const variance =
    bollingerValues.reduce(
      (sum, value) => sum + (value - (bollingerMid ?? 0)) ** 2,
      0,
    ) / (bollingerReady ? 20 : 1)
  const deviation = Math.sqrt(variance)
  const previous = candles.slice(-21, -1)
  const highs = previous.map(({ high }) => high)
  const lows = previous.map(({ low }) => low)
  const volumes = candles.slice(-21, -1).map(({ volume }) => volume)
  const atrSeries = averageTrueRangeSeries(candles, atrPeriod)
  const atrStart = Math.max(0, candles.length - 50)
  const atrValues = atrSeries
    .slice(atrStart)
    .filter((value): value is number => value !== null)
  const currentAtr = atrSeries.at(-1) ?? null
  const atrPercentile =
    currentAtr === null
      ? null
      : (100 * atrValues.filter((value) => value <= currentAtr).length) /
        atrValues.length
  const priorAtrWindow = atrSeries
    .slice(0, -1)
    .filter((value): value is number => value !== null)
    .slice(-20)
  return {
    bollingerMid:
      bollingerMid === null ? null : finite(bollingerMid, 'bollingerMid'),
    bollingerUpper:
      bollingerMid === null
        ? null
        : finite(bollingerMid + 2 * deviation, 'bollingerUpper'),
    bollingerLower:
      bollingerMid === null
        ? null
        : finite(bollingerMid - 2 * deviation, 'bollingerLower'),
    donchianHigh:
      highs.length < 20 ? null : finite(Math.max(...highs), 'donchianHigh'),
    donchianLow:
      lows.length < 20 ? null : finite(Math.min(...lows), 'donchianLow'),
    donchianMid:
      highs.length < 20 || lows.length < 20
        ? null
        : finite((Math.max(...highs) + Math.min(...lows)) / 2, 'donchianMid'),
    volumeSma:
      volumes.length < 20
        ? null
        : finite(
            volumes.reduce((sum, value) => sum + value, 0) / 20,
            'volumeSma',
          ),
    atrPercentile:
      atrPercentile === null ? null : finite(atrPercentile, 'atrPercentile'),
    priorAtrSma20:
      priorAtrWindow.length < 20
        ? null
        : finite(
            priorAtrWindow.reduce((sum, value) => sum + value, 0) / 20,
            'priorAtrSma20',
          ),
  }
}

const EMPTY_ROLLING_FEATURES: RollingMarketFeatures = {
  bollingerMid: null,
  bollingerUpper: null,
  bollingerLower: null,
  donchianHigh: null,
  donchianLow: null,
  donchianMid: null,
  volumeSma: null,
  atrPercentile: null,
  priorAtrSma20: null,
}

function averageTrueRangeSeries(
  candles: readonly TechnicalCandle[],
  period: number,
): readonly (number | null)[] {
  const result: (number | null)[] = Array(candles.length).fill(null)
  if (candles.length < period + 1) return result
  const trueRanges: number[] = []
  for (let index = 1; index < candles.length; index += 1) {
    const current = candles[index]!
    const previous = candles[index - 1]!
    trueRanges.push(
      Math.max(
        current.high - current.low,
        Math.abs(current.high - previous.close),
        Math.abs(current.low - previous.close),
      ),
    )
  }
  let current =
    trueRanges.slice(0, period).reduce((sum, value) => sum + value, 0) / period
  result[period] = finite(current, 'atr')
  for (let index = period; index < trueRanges.length; index += 1) {
    current = (current * (period - 1) + trueRanges[index]!) / period
    result[index + 1] = finite(current, 'atr')
  }
  return result
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
