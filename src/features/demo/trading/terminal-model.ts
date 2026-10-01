import type { DemoCandle } from './types.ts'

export const TERMINAL_INTERVALS = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1h': 3600,
} as const

export type TerminalInterval = keyof typeof TERMINAL_INTERVALS

export function bucketForEvent(time: number, intervalSeconds: number): number {
  return Math.floor(time / intervalSeconds) * intervalSeconds
}

export function resampleCandles(
  candles: readonly DemoCandle[],
  intervalSeconds: number,
): DemoCandle[] {
  if (intervalSeconds === 60) return [...candles]
  const buckets = new Map<number, DemoCandle[]>()
  for (const candle of candles) {
    const start = bucketForEvent(candle.time, intervalSeconds)
    const group = buckets.get(start) ?? []
    group.push(candle)
    buckets.set(start, group)
  }
  const latestBucket = bucketForEvent(
    candles.at(-1)?.time ?? 0,
    intervalSeconds,
  )
  return [...buckets].flatMap(([time, rows]) => {
    if (
      (rows.length !== intervalSeconds / 60 && time !== latestBucket) ||
      rows.some((row, index) => row.time !== time + index * 60)
    )
      return []
    return [
      {
        time,
        open: rows[0]!.open,
        high: Math.max(...rows.map((row) => row.high)),
        low: Math.min(...rows.map((row) => row.low)),
        close: rows.at(-1)!.close,
        volume: rows.reduce((sum, row) => sum + row.volume, 0),
      },
    ]
  })
}
