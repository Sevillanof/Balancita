import type { UTCTimestamp } from 'lightweight-charts'
import type { CandlestickData } from 'lightweight-charts'
import type { Candle, Quote } from '../../market-data/domain/market-data.ts'

const MINUTE_MS = 60_000

export function mergeQuoteIntoCandles(
  candles: readonly Candle[],
  quote: Quote,
): Candle[] {
  const quoteTime = Date.parse(quote.eventTime ?? quote.timestamp)
  if (Number.isNaN(quoteTime)) return [...candles]

  const quoteBucket = minuteBucket(quoteTime)
  const matchingIndex = candles.findIndex(
    (candle) => minuteBucket(Date.parse(candle.time)) === quoteBucket,
  )
  const matchingCandle = candles[matchingIndex]

  if (matchingCandle !== undefined) {
    if (matchingCandle.isClosed === true) return [...candles]
    return candles.map((candle, index) =>
      index === matchingIndex
        ? {
            ...candle,
            high: Math.max(candle.high, quote.price),
            low: Math.min(candle.low, quote.price),
            close: quote.price,
            isClosed: false,
          }
        : candle,
    )
  }

  const latest = candles.at(-1)
  if (
    latest !== undefined &&
    quoteBucket <= minuteBucket(Date.parse(latest.time))
  ) {
    return [...candles]
  }

  return [
    ...candles,
    {
      time: new Date(quoteBucket).toISOString(),
      open: quote.price,
      high: quote.price,
      low: quote.price,
      close: quote.price,
      volume: 0,
      isClosed: false,
    },
  ]
}

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

function minuteBucket(milliseconds: number): number {
  return Math.floor(milliseconds / MINUTE_MS) * MINUTE_MS
}
