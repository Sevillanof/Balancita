import type { FuturesMarketStore } from '../kraken-futures/futures-market-store.ts'

/** Closed-candle projection shared by the terminal bootstrap/snapshot builders. */
export function toTerminalMarket(rows: Record<string, unknown>[]) {
  const candles = rows
    .filter((candle) => Number(candle.interval_ms) === 60_000)
    .slice(-500)
    .map((candle) => ({
      time_ms: candle.bucket_start,
      open: candle.open_price,
      high: candle.high_price,
      low: candle.low_price,
      close: candle.close_price,
      volume_btc: candle.volume_btc,
      closed: true as const,
    }))
  const last = candles.at(-1)
  return {
    schema_version: 'futures-terminal-market.v1' as const,
    as_of_ms: last ? Number(last.time_ms) + 60_000 : 0,
    interval_ms: 60_000,
    candles,
  }
}

/**
 * Terminal market history for paper_live: the most recent closed 60 s candles
 * (latest closed revision per bucket, max 500, ascending) from the store.
 */
export function createLiveTerminalMarket(source: FuturesMarketStore) {
  return toTerminalMarket(
    source.closedCandlesTail(60_000, 500) as Record<string, unknown>[],
  )
}
