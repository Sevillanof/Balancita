import type { UTCTimestamp } from 'lightweight-charts'
import type { CandlestickData } from 'lightweight-charts'
import type { Candle } from '../../domain/market-data'

export function toCandlestickData(candle: Candle): CandlestickData {
  const milliseconds = Date.parse(candle.time)
  if (Number.isNaN(milliseconds)) {
    throw new Error(`Invalid candle time: ${candle.time}`)
  }
  return {
    time: Math.floor(milliseconds / 1000) as UTCTimestamp,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
  }
}

export function toCandlestickDataset(
  candles: readonly Candle[],
): CandlestickData[] {
  return candles.map(toCandlestickData)
}
