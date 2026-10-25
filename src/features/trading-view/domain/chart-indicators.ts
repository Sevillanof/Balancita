/**
 * Display indicators for the terminal chart, computed from the candles the
 * chart already draws. Same definitions as the engine's features (EMA seeded
 * with the SMA of the first `period` closes, population standard deviation for
 * Bollinger, Wilder smoothing for RSI), but for reading the chart only: the
 * engine's own values decide trades.
 */
export type IndicatorCandle = {
  time: number
  high: number
  low: number
  close: number
  volume: number
}

export type LinePoint = { time: number; value: number }

export function ema(
  candles: readonly IndicatorCandle[],
  period: number,
): LinePoint[] {
  if (candles.length < period) return []
  const alpha = 2 / (period + 1)
  let value =
    candles.slice(0, period).reduce((sum, candle) => sum + candle.close, 0) /
    period
  const out: LinePoint[] = [{ time: candles[period - 1]!.time, value }]
  for (const candle of candles.slice(period)) {
    value = candle.close * alpha + value * (1 - alpha)
    out.push({ time: candle.time, value })
  }
  return out
}

export function bollinger(
  candles: readonly IndicatorCandle[],
  period = 20,
  width = 2,
): { upper: LinePoint[]; middle: LinePoint[]; lower: LinePoint[] } {
  const upper: LinePoint[] = []
  const middle: LinePoint[] = []
  const lower: LinePoint[] = []
  for (let index = period - 1; index < candles.length; index += 1) {
    const window = candles.slice(index - period + 1, index + 1)
    const mean = window.reduce((sum, candle) => sum + candle.close, 0) / period
    const deviation = Math.sqrt(
      window.reduce((sum, candle) => sum + (candle.close - mean) ** 2, 0) /
        period,
    )
    const time = candles[index]!.time
    upper.push({ time, value: mean + width * deviation })
    middle.push({ time, value: mean })
    lower.push({ time, value: mean - width * deviation })
  }
  return { upper, middle, lower }
}

/** Highest high / lowest low of the previous `period` candles (current excluded). */
export function donchian(
  candles: readonly IndicatorCandle[],
  period = 20,
): { upper: LinePoint[]; lower: LinePoint[] } {
  const upper: LinePoint[] = []
  const lower: LinePoint[] = []
  for (let index = period; index < candles.length; index += 1) {
    const window = candles.slice(index - period, index)
    const time = candles[index]!.time
    upper.push({ time, value: Math.max(...window.map((item) => item.high)) })
    lower.push({ time, value: Math.min(...window.map((item) => item.low)) })
  }
  return { upper, lower }
}

/** Volume-weighted average price, restarting at each UTC day. */
export function vwap(candles: readonly IndicatorCandle[]): LinePoint[] {
  const out: LinePoint[] = []
  let day = -1
  let priceVolume = 0
  let volume = 0
  for (const candle of candles) {
    const candleDay = Math.floor(candle.time / 86_400)
    if (candleDay !== day) {
      day = candleDay
      priceVolume = 0
      volume = 0
    }
    const typical = (candle.high + candle.low + candle.close) / 3
    priceVolume += typical * candle.volume
    volume += candle.volume
    if (volume > 0) out.push({ time: candle.time, value: priceVolume / volume })
  }
  return out
}

export function rsi(
  candles: readonly IndicatorCandle[],
  period = 14,
): LinePoint[] {
  if (candles.length <= period) return []
  let gain = 0
  let loss = 0
  for (let index = 1; index <= period; index += 1) {
    const change = candles[index]!.close - candles[index - 1]!.close
    gain += Math.max(change, 0)
    loss += Math.max(-change, 0)
  }
  gain /= period
  loss /= period
  const value = () =>
    loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss)
  const out: LinePoint[] = [{ time: candles[period]!.time, value: value() }]
  for (let index = period + 1; index < candles.length; index += 1) {
    const change = candles[index]!.close - candles[index - 1]!.close
    gain = (gain * (period - 1) + Math.max(change, 0)) / period
    loss = (loss * (period - 1) + Math.max(-change, 0)) / period
    out.push({ time: candles[index]!.time, value: value() })
  }
  return out
}

/** Folds candles into a coarser timeframe (seconds); the last bucket may be partial. */
export function aggregate<T extends IndicatorCandle & { open: number }>(
  candles: readonly T[],
  intervalSeconds: number,
): Array<IndicatorCandle & { open: number }> {
  const out: Array<IndicatorCandle & { open: number }> = []
  for (const candle of candles) {
    const time = Math.floor(candle.time / intervalSeconds) * intervalSeconds
    const last = out.at(-1)
    if (last && last.time === time) {
      last.high = Math.max(last.high, candle.high)
      last.low = Math.min(last.low, candle.low)
      last.close = candle.close
      last.volume += candle.volume
    } else
      out.push({
        time,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
      })
  }
  return out
}

export type ValueArea = { poc: number; vah: number; val: number }

/**
 * Volume profile of `candles`: each candle's volume is spread evenly over the
 * price bins its high-low range touches. Returns the point of control (most
 * traded bin) and the value area (smallest run of bins around it holding
 * `share` of the volume, grown toward the heavier neighbour).
 */
export function valueArea(
  candles: readonly IndicatorCandle[],
  bins = 48,
  share = 0.7,
): ValueArea | null {
  let low = Infinity
  let high = -Infinity
  for (const candle of candles) {
    low = Math.min(low, candle.low)
    high = Math.max(high, candle.high)
  }
  if (!(high > low)) return null
  const step = (high - low) / bins
  const volume = new Array<number>(bins).fill(0)
  const bin = (price: number) =>
    Math.min(bins - 1, Math.max(0, Math.floor((price - low) / step)))
  for (const candle of candles) {
    if (!(candle.volume > 0)) continue
    const first = bin(candle.low)
    const last = bin(candle.high)
    for (let index = first; index <= last; index += 1)
      volume[index]! += candle.volume / (last - first + 1)
  }
  const total = volume.reduce((sum, value) => sum + value, 0)
  if (total <= 0) return null
  let poc = 0
  for (let index = 1; index < bins; index += 1)
    if (volume[index]! > volume[poc]!) poc = index
  let lo = poc
  let hi = poc
  let held = volume[poc]!
  while (held < total * share && (lo > 0 || hi < bins - 1)) {
    const below = lo > 0 ? volume[lo - 1]! : -1
    const above = hi < bins - 1 ? volume[hi + 1]! : -1
    if (above >= below) {
      hi += 1
      held += volume[hi]!
    } else {
      lo -= 1
      held += volume[lo]!
    }
  }
  return {
    poc: low + (poc + 0.5) * step,
    vah: low + (hi + 1) * step,
    val: low + lo * step,
  }
}

/**
 * Previous-session value area held flat through each UTC day: the levels of a
 * day come only from the day before, so no line uses a candle not yet closed.
 */
export function priorDayValueArea(candles: readonly IndicatorCandle[]): {
  poc: LinePoint[]
  vah: LinePoint[]
  val: LinePoint[]
} {
  const out = {
    poc: [] as LinePoint[],
    vah: [] as LinePoint[],
    val: [] as LinePoint[],
  }
  const byDay = new Map<number, IndicatorCandle[]>()
  for (const candle of candles) {
    const day = Math.floor(candle.time / 86_400)
    const list = byDay.get(day)
    if (list) list.push(candle)
    else byDay.set(day, [candle])
  }
  const levels = new Map<number, ValueArea | null>()
  for (const [day, list] of byDay) levels.set(day, valueArea(list))
  for (const candle of candles) {
    const area = levels.get(Math.floor(candle.time / 86_400) - 1)
    if (!area) continue
    out.poc.push({ time: candle.time, value: area.poc })
    out.vah.push({ time: candle.time, value: area.vah })
    out.val.push({ time: candle.time, value: area.val })
  }
  return out
}
