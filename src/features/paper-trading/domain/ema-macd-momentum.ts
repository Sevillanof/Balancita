import type { Candle } from '../../market-data/domain/market-data.ts'
import {
  moneyAdd,
  moneyCompare,
  moneyFromNumber,
  moneyFromString,
  moneyIsPositive,
  moneyMul,
  type Money,
} from '../../../shared/finance/money.ts'

export const MOMENTUM_STRATEGY_VERSION = 'ema-macd-momentum.v1'
export const MOMENTUM_CANDLE_MS = 15 * 60 * 1000
export const SIMULATED_BTC_EUR_FEE_POLICY = {
  id: 'simulated-btc-eur-0.075-percent',
  percentage: moneyFromString('0.00075'),
  minimum: moneyFromString('0'),
  currency: 'EUR',
  label: 'Comisión simulada estimada (0,075 % por orden)',
} as const

/** Largest fixed-scale BTC amount whose notional plus percentage fee fits cash. */
export function largestAffordableQuantity(
  cash: Money,
  price: Money,
  feeRate: Money,
): Money {
  const unitCost = moneyMul(price, moneyAdd(moneyFromNumber(1), feeRate))
  if (!moneyIsPositive(cash) || !moneyIsPositive(unitCost))
    return moneyFromNumber(0)
  let quantity: Money = { units: (cash.units * 10n ** 8n) / unitCost.units }
  const subtotal = moneyMul(quantity, price)
  const total = moneyAdd(subtotal, moneyMul(subtotal, feeRate))
  if (moneyCompare(total, cash) > 0) quantity = { units: quantity.units - 1n }
  return moneyIsPositive(quantity) ? quantity : moneyFromNumber(0)
}

export type Exposure = 'flat' | 'long'
export type MomentumMacd = { line: number; signal: number; histogram: number }
export type MomentumIndicators = {
  ready: boolean
  ema8: number | null
  ema21: number | null
  macd: MomentumMacd | null
  volumeSma20: number | null
  previous?: MomentumIndicators
}

/** EMA starts with the simple average of the first complete period. */
function ema(values: readonly number[], period: number): (number | null)[] {
  const result: (number | null)[] = Array(values.length).fill(null)
  if (values.length < period) return result
  let current =
    values.slice(0, period).reduce((sum, value) => sum + value, 0) / period
  result[period - 1] = current
  const alpha = 2 / (period + 1)
  for (let index = period; index < values.length; index += 1) {
    current = alpha * values[index]! + (1 - alpha) * current
    result[index] = current
  }
  return result
}

export function calculateMomentumIndicators(
  candles: readonly Candle[],
): MomentumIndicators {
  const closed = candles.filter((candle) => candle.isClosed !== false)
  if (
    closed.length === 0 ||
    closed.some(
      (candle) => ![candle.close, candle.volume].every(Number.isFinite),
    )
  ) {
    return {
      ready: false,
      ema8: null,
      ema21: null,
      macd: null,
      volumeSma20: null,
    }
  }
  const closes = closed.map(({ close }) => close)
  const volumes = closed.map(({ volume }) => volume)
  const ema8 = ema(closes, 8)
  const ema21 = ema(closes, 21)
  const macdFast = ema(closes, 12)
  const macdSlow = ema(closes, 26)
  const lines = closes.map((_, index) =>
    macdFast[index] === null || macdSlow[index] === null
      ? null
      : macdFast[index]! - macdSlow[index]!,
  )
  const validLines = lines.filter((value): value is number => value !== null)
  const signalValues = ema(validLines, 9)
  const signal = signalValues.at(-1) ?? null
  const line = lines.at(-1) ?? null
  const volumeSma20 =
    volumes.length < 20
      ? null
      : volumes.slice(-20).reduce((sum, value) => sum + value, 0) / 20
  const ready =
    line !== null &&
    signal !== null &&
    volumeSma20 !== null &&
    ema8.at(-1) !== null &&
    ema21.at(-1) !== null
  return {
    ready,
    ema8: ema8.at(-1) ?? null,
    ema21: ema21.at(-1) ?? null,
    macd:
      line === null || signal === null
        ? null
        : { line, signal, histogram: line - signal },
    volumeSma20,
  }
}

export function evaluateMomentumSignal(
  candles: readonly Candle[],
  indicators: MomentumIndicators,
  exposure: Exposure,
): 'buy' | 'sell' | null {
  if (
    !indicators.ready ||
    indicators.ema8 === null ||
    indicators.ema21 === null ||
    indicators.macd === null
  )
    return null
  const current = candles.at(-1)
  if (current === undefined || current.isClosed === false) return null
  const previous = indicators.previous
  if (
    exposure === 'long' &&
    previous !== undefined &&
    previous.ema8 !== null &&
    previous.ema21 !== null &&
    previous.macd !== null
  ) {
    const emaCross =
      previous.ema8 >= previous.ema21 && indicators.ema8 < indicators.ema21
    const macdCross =
      previous.macd.line >= previous.macd.signal &&
      indicators.macd.line < indicators.macd.signal
    return emaCross || macdCross ? 'sell' : null
  }
  const precedingVolumes = candles.slice(-21, -1)
  if (
    exposure !== 'flat' ||
    precedingVolumes.length !== 20 ||
    indicators.ema8 === null ||
    indicators.ema21 === null
  )
    return null
  const baseline =
    precedingVolumes.reduce((sum, candle) => sum + candle.volume, 0) / 20
  return current.close > indicators.ema8 &&
    indicators.ema8 > indicators.ema21 &&
    indicators.macd.line > indicators.macd.signal &&
    indicators.macd.histogram > 0 &&
    current.volume > baseline * 1.15
    ? 'buy'
    : null
}

/** Produces only complete 15m intervals made from all fifteen closed 1m bars. */
export function aggregateClosed15mCandles(
  oneMinute: readonly Candle[],
): Candle[] {
  const byTime = new Map<number, Candle>()
  for (const candle of oneMinute) {
    const start = Date.parse(candle.time)
    if (!Number.isFinite(start) || candle.isClosed === false) continue
    byTime.set(start, candle)
  }
  const buckets = new Map<number, Candle[]>()
  for (const [time, candle] of byTime) {
    const bucket = Math.floor(time / MOMENTUM_CANDLE_MS) * MOMENTUM_CANDLE_MS
    const rows = buckets.get(bucket) ?? []
    rows.push(candle)
    buckets.set(bucket, rows)
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .flatMap(([start, rows]) => {
      rows.sort((a, b) => Date.parse(a.time) - Date.parse(b.time))
      if (
        rows.length !== 15 ||
        rows.some(
          (row, index) => Date.parse(row.time) !== start + index * 60_000,
        )
      )
        return []
      return [
        {
          time: new Date(start).toISOString(),
          open: rows[0]!.open,
          high: Math.max(...rows.map((row) => row.high)),
          low: Math.min(...rows.map((row) => row.low)),
          close: rows.at(-1)!.close,
          volume: rows.reduce((sum, row) => sum + row.volume, 0),
          isClosed: true,
        },
      ]
    })
}
