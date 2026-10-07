/** A closed 1m candle; `time` in seconds, like the terminal chart. */
export type LabCandle = {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export type FeatureRow = Record<string, number | undefined>

function ema(
  values: readonly number[],
  period: number,
): Array<number | undefined> {
  const out: Array<number | undefined> = []
  const k = 2 / (period + 1)
  let current: number | undefined
  let sum = 0
  values.forEach((value, index) => {
    if (index < period) {
      sum += value
      if (index === period - 1) current = sum / period
    } else current = value * k + (current as number) * (1 - k)
    out.push(current)
  })
  return out
}

function sma(
  values: readonly number[],
  period: number,
): Array<number | undefined> {
  return values.map((_, index) => {
    if (index < period - 1) return undefined
    let sum = 0
    for (let j = index - period + 1; j <= index; j += 1) sum += values[j]!
    return sum / period
  })
}

/** Wilder RSI. */
function rsi(
  closes: readonly number[],
  period = 14,
): Array<number | undefined> {
  const out: Array<number | undefined> = [undefined]
  let gain = 0
  let loss = 0
  for (let i = 1; i < closes.length; i += 1) {
    const change = closes[i]! - closes[i - 1]!
    const up = Math.max(change, 0)
    const down = Math.max(-change, 0)
    if (i <= period) {
      gain += up / period
      loss += down / period
      out.push(i === period ? toRsi(gain, loss) : undefined)
    } else {
      gain = (gain * (period - 1) + up) / period
      loss = (loss * (period - 1) + down) / period
      out.push(toRsi(gain, loss))
    }
  }
  return out
}

function toRsi(gain: number, loss: number): number {
  if (loss === 0) return gain === 0 ? 50 : 100
  return 100 - 100 / (1 + gain / loss)
}

/** Wilder ATR. */
function atr(
  candles: readonly LabCandle[],
  period = 14,
): Array<number | undefined> {
  const out: Array<number | undefined> = []
  let current: number | undefined
  let sum = 0
  candles.forEach((candle, index) => {
    const previous = candles[index - 1]
    const range = previous
      ? Math.max(
          candle.high - candle.low,
          Math.abs(candle.high - previous.close),
          Math.abs(candle.low - previous.close),
        )
      : candle.high - candle.low
    if (index < period) {
      sum += range
      if (index === period - 1) current = sum / period
    } else current = ((current as number) * (period - 1) + range) / period
    out.push(current)
  })
  return out
}

/**
 * Per-candle features over the same vocabulary as the spec: `1m.*` for the
 * candle itself, `prev.*` for the one before and `5m.*` for the last closed
 * 5-minute bucket. Donchian and the volume mean use the 20 prior candles, so
 * a breakout above them is possible.
 */
export function computeFeatures(candles: readonly LabCandle[]): FeatureRow[] {
  const closes = candles.map((candle) => candle.close)
  const ema9 = ema(closes, 9)
  const ema21 = ema(closes, 21)
  const sma50 = sma(closes, 50)
  const sma20 = sma(closes, 20)
  const rsi14 = rsi(closes)
  const atr14 = atr(candles)

  const bucketSeconds = 300
  const bucketCloses: number[] = []
  const bucketEnds: number[] = []
  candles.forEach((candle, index) => {
    const bucket = Math.floor(candle.time / bucketSeconds)
    const next = candles[index + 1]
    if (!next || Math.floor(next.time / bucketSeconds) !== bucket) {
      bucketCloses.push(candle.close)
      bucketEnds.push(index)
    }
  })
  const trendEma9 = ema(bucketCloses, 9)
  const trendEma21 = ema(bucketCloses, 21)

  const rows: FeatureRow[] = []
  let bucketCursor = -1
  candles.forEach((candle, index) => {
    while (
      bucketCursor + 1 < bucketEnds.length &&
      bucketEnds[bucketCursor + 1]! <= index
    )
      bucketCursor += 1
    const row: FeatureRow = {
      '1m.candidate_close': candle.close,
      '1m.candidate_open': candle.open,
      '1m.candidate_high': candle.high,
      '1m.candidate_low': candle.low,
      '1m.ema9': ema9[index],
      '1m.ema21': ema21[index],
      '1m.sma50': sma50[index],
      '1m.rsi14': rsi14[index],
      '1m.atr14': atr14[index],
      '1m.volume': candle.volume,
      '5m.ema9': bucketCursor >= 0 ? trendEma9[bucketCursor] : undefined,
      '5m.ema21': bucketCursor >= 0 ? trendEma21[bucketCursor] : undefined,
    }
    const mid = sma20[index]
    if (mid !== undefined) {
      let variance = 0
      for (let j = index - 19; j <= index; j += 1)
        variance += (closes[j]! - mid) ** 2
      const deviation = Math.sqrt(variance / 20)
      row['1m.bollinger_mid20'] = mid
      row['1m.bollinger_upper20'] = mid + 2 * deviation
      row['1m.bollinger_lower20'] = mid - 2 * deviation
    }
    if (index >= 20) {
      let high = -Infinity
      let low = Infinity
      let volume = 0
      for (let j = index - 20; j < index; j += 1) {
        high = Math.max(high, candles[j]!.high)
        low = Math.min(low, candles[j]!.low)
        volume += candles[j]!.volume
      }
      row['1m.donchian_high20'] = high
      row['1m.donchian_low20'] = low
      row['1m.donchian_mid20'] = (high + low) / 2
      row['1m.prior_volume_mean20'] = volume / 20
    }
    const previous = rows[index - 1]
    if (previous)
      for (const key of [
        'candidate_close',
        'candidate_high',
        'candidate_low',
        'ema9',
        'ema21',
        'rsi14',
      ])
        row[`prev.${key}`] = previous[`1m.${key}`]
    rows.push(row)
  })
  return rows
}

/** Trend/range regime with the same hysteresis as futures_strategies.py. */
export function regimes(
  rows: readonly FeatureRow[],
): Array<'trend' | 'range' | 'unknown'> {
  let current: 'trend' | 'range' | 'unknown' = 'unknown'
  return rows.map((row) => {
    const fast = row['1m.ema9']
    const slow = row['1m.ema21']
    const range = row['1m.atr14']
    if (fast === undefined || slow === undefined || !range) return current
    const ratio = Math.abs(fast - slow) / range
    if (ratio > 0.5) current = 'trend'
    else if (ratio < 0.2) current = 'range'
    return current
  })
}
