import { FUTURES_PRODUCT } from '../kraken-futures/futures-market.ts'
import type {
  FuturesMarketStore,
  OfficialStoredCandle,
} from '../kraken-futures/futures-market-store.ts'

const HISTORY_INTERVAL_MS = 60_000
const HISTORY_LIMIT = 500

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
 * Closed 1m history: official Kraken candles (first-known revision) win for
 * every bucket that has one; an observed closed candle fills only buckets
 * without an official candle (the newest ones, since official candles land a
 * few seconds after close, or all of them on a schema-3 store). One candle per
 * bucket, ascending, newest `limit` kept. Rows use the observed-row shape.
 */
export function mergeClosedHistory(
  official: readonly OfficialStoredCandle[],
  observed: readonly Record<string, unknown>[],
  limit = HISTORY_LIMIT,
): Record<string, unknown>[] {
  const byBucket = new Map<number, Record<string, unknown>>()
  for (const row of observed)
    if (Number(row.interval_ms) === HISTORY_INTERVAL_MS)
      byBucket.set(Number(row.bucket_start), row)
  for (const candle of official)
    byBucket.set(candle.bucketStart, {
      interval_ms: candle.intervalMs,
      bucket_start: candle.bucketStart,
      open_price: candle.open,
      high_price: candle.high,
      low_price: candle.low,
      close_price: candle.close,
      volume_btc: candle.volumeBtc,
    })
  return [...byBucket.entries()]
    .sort(([left], [right]) => left - right)
    .slice(-limit)
    .map(([, row]) => row)
}

/** Closed 1m PF_XBTUSD history of a store: official candles merged with observed ones. */
export function closedHistoryRows(
  store: FuturesMarketStore,
): Record<string, unknown>[] {
  return mergeClosedHistory(
    store.officialCandlesAsOf(
      FUTURES_PRODUCT,
      HISTORY_INTERVAL_MS,
      Number.MAX_SAFE_INTEGER,
      HISTORY_LIMIT,
    ),
    store.closedCandlesTail(HISTORY_INTERVAL_MS, HISTORY_LIMIT) as Record<
      string,
      unknown
    >[],
  )
}

/**
 * Terminal market history for paper_live: the most recent closed 60 s candles
 * (official candle per bucket when known, else the latest closed observed
 * revision; max 500, ascending) from the store.
 */
export function createLiveTerminalMarket(source: FuturesMarketStore) {
  return toTerminalMarket(closedHistoryRows(source))
}
