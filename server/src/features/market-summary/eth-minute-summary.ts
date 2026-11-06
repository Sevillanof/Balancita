import { DatabaseSync } from 'node:sqlite'

/**
 * Per-minute summary of PF_ETHUSD (datos-utiles S4), derived from the market
 * events the capture already stored in `paper_futures_market_events`.
 *
 * It only READS that table and only writes its own table, so retention, the
 * `_no_delete` triggers and the capture itself are untouched. One row per
 * CLOSED minute (closed + a small margin), keyed by `minute_start_ms`, so a
 * restart never duplicates a minute. A column the stored events cannot
 * support stays NULL: it is never invented or filled with zero.
 *
 * What fills each column: ETH trades (every trade, WebSocket) give the trade
 * columns; REST tickers give spread, top-of-book sizes and last price; the
 * capture stores a trimmed book snapshot every 30 s (levels within the depth
 * band of the mid, never the deltas) that gives `depth_*`. A column whose
 * events are missing in a minute stays NULL.
 */
export const ETH_PRODUCT = 'PF_ETHUSD'
export const SUMMARY_TABLE = 'paper_futures_eth_minute_summary'
export const MINUTE_MS = 60_000
/** A minute counts as closed this long after it ends, so late-persisted events still land in it. */
export const DEFAULT_CLOSE_MARGIN_MS = 5_000
/** Minutes read per step: keeps each synchronous query small. */
export const DEFAULT_MAX_MINUTES_PER_RUN = 60
/** Book depth is the quantity resting within this fraction of the mid price. */
export const DEPTH_BAND = 0.001

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ${SUMMARY_TABLE}(
  minute_start_ms INTEGER PRIMARY KEY,
  product_id TEXT NOT NULL,
  trade_count INTEGER,
  buy_volume REAL,
  sell_volume REAL,
  vwap REAL,
  last_price REAL,
  spread_bp REAL,
  top_bid_size REAL,
  top_ask_size REAL,
  depth_bid REAL,
  depth_ask REAL,
  events_seen INTEGER NOT NULL,
  written_at_ms INTEGER NOT NULL
) STRICT;
`

export interface MinuteSummary {
  readonly minuteStartMs: number
  readonly productId: string
  /** NULL when no trade event was stored for the minute. */
  readonly tradeCount: number | null
  readonly buyVolume: number | null
  readonly sellVolume: number | null
  readonly vwap: number | null
  /** Last trade price of the minute; without trades, the last ticker `last`. */
  readonly lastPrice: number | null
  /** Average of (ask - bid) / mid in basis points over the minute's tickers. */
  readonly spreadBp: number | null
  /** Average best-bid / best-ask size reported by the tickers (top of book only). */
  readonly topBidSize: number | null
  readonly topAskSize: number | null
  /** Average quantity within +-0.1 % of the mid, from stored book snapshots. */
  readonly depthBid: number | null
  readonly depthAsk: number | null
  readonly eventsSeen: number
}

export interface EthMinuteSummaryOptions {
  /** Path of the capture database (`futures-market.sqlite`). */
  readonly dbPath: string
  readonly clock?: () => number
  readonly closeMarginMs?: number
  readonly maxMinutesPerRun?: number
  readonly onError?: (error: unknown) => void
  /** Return false to skip a run (e.g. the database is known damaged or a backup is running). */
  readonly canRun?: () => boolean
}

export interface RunResult {
  /** Rows inserted by this step. */
  readonly written: number
  /** True when closed minutes remain to be read (call again soon). */
  readonly pending: boolean
}

type EventRow = { feed: string; received_at: number; normalized_json: string }
type Json = Record<string, unknown>

const positive = (value: unknown): number | null => {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : null
}
const nonNegative = (value: unknown): number | null => {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : null
}
const mean = (sum: number, count: number): number | null =>
  count === 0 ? null : sum / count

function levels(value: unknown): { price: number; quantity: number }[] {
  if (!Array.isArray(value)) return []
  const out: { price: number; quantity: number }[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue
    const price = positive((item as Json).price)
    const quantity = nonNegative((item as Json).quantity)
    if (price !== null && quantity !== null) out.push({ price, quantity })
  }
  return out
}

/** Pure aggregation of the events of one minute (exported for direct reasoning, tested through `runOnce`). */
export function summarizeMinute(
  minuteStartMs: number,
  rows: readonly EventRow[],
): MinuteSummary {
  let trades = 0
  let buy = 0
  let sell = 0
  let notional = 0
  let lastTradePrice: number | null = null
  let lastTickerPrice: number | null = null
  let spreadSum = 0
  let spreads = 0
  let bidSizeSum = 0
  let bidSizes = 0
  let askSizeSum = 0
  let askSizes = 0
  let depthBidSum = 0
  let depthAskSum = 0
  let books = 0
  for (const row of rows) {
    let event: Json
    try {
      const parsed: unknown = JSON.parse(row.normalized_json)
      if (typeof parsed !== 'object' || parsed === null) continue
      event = parsed as Json
    } catch {
      continue
    }
    if (row.feed === 'trade') {
      const quantity = positive(event.quantityBtc)
      const price = positive(event.priceUsd)
      if (
        quantity === null ||
        price === null ||
        (event.side !== 'buy' && event.side !== 'sell')
      )
        continue
      trades += 1
      if (event.side === 'buy') buy += quantity
      else sell += quantity
      notional += quantity * price
      lastTradePrice = price
    } else if (row.feed === 'ticker') {
      const last = positive(event.last)
      if (last !== null) lastTickerPrice = last
      const bid = positive(event.bid)
      const ask = positive(event.ask)
      if (bid !== null && ask !== null && ask >= bid) {
        spreadSum += ((ask - bid) / ((ask + bid) / 2)) * 10_000
        spreads += 1
      }
      const raw =
        typeof event.raw === 'object' && event.raw !== null
          ? (event.raw as Json)
          : {}
      const bidSize = nonNegative(raw.bid_size)
      const askSize = nonNegative(raw.ask_size)
      if (bidSize !== null) {
        bidSizeSum += bidSize
        bidSizes += 1
      }
      if (askSize !== null) {
        askSizeSum += askSize
        askSizes += 1
      }
    } else if (row.feed === 'book' && event.snapshot === true) {
      const bids = levels(event.bids)
      const asks = levels(event.asks)
      if (bids.length === 0 || asks.length === 0) continue
      const bestBid = Math.max(...bids.map((item) => item.price))
      const bestAsk = Math.min(...asks.map((item) => item.price))
      const mid = (bestBid + bestAsk) / 2
      depthBidSum += bids
        .filter((item) => item.price >= mid * (1 - DEPTH_BAND))
        .reduce((total, item) => total + item.quantity, 0)
      depthAskSum += asks
        .filter((item) => item.price <= mid * (1 + DEPTH_BAND))
        .reduce((total, item) => total + item.quantity, 0)
      books += 1
    }
  }
  const volume = buy + sell
  return {
    minuteStartMs,
    productId: ETH_PRODUCT,
    tradeCount: trades === 0 ? null : trades,
    buyVolume: trades === 0 ? null : buy,
    sellVolume: trades === 0 ? null : sell,
    vwap: trades === 0 || volume === 0 ? null : notional / volume,
    lastPrice: lastTradePrice ?? lastTickerPrice,
    spreadBp: mean(spreadSum, spreads),
    topBidSize: mean(bidSizeSum, bidSizes),
    topAskSize: mean(askSizeSum, askSizes),
    depthBid: mean(depthBidSum, books),
    depthAsk: mean(depthAskSum, books),
    eventsSeen: rows.length,
  }
}

export function createEthMinuteSummary(options: EthMinuteSummaryOptions) {
  const clock = options.clock ?? Date.now
  const marginMs = options.closeMarginMs ?? DEFAULT_CLOSE_MARGIN_MS
  const maxMinutes = Math.max(
    1,
    Math.floor(options.maxMinutesPerRun ?? DEFAULT_MAX_MINUTES_PER_RUN),
  )
  const db = new DatabaseSync(options.dbPath)
  db.exec('PRAGMA busy_timeout=5000;')
  db.exec(SCHEMA)
  // Next minute to read. Unset until the first run finds where to start.
  let cursor: number | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false

  const startCursor = (): number | undefined => {
    const last = db
      .prepare(`SELECT MAX(minute_start_ms) AS m FROM ${SUMMARY_TABLE}`)
      .get() as { m: number | null }
    if (last.m !== null) return Number(last.m) + MINUTE_MS
    const first = db
      .prepare(
        `SELECT MIN(received_at) AS t FROM paper_futures_market_events WHERE product_id=?`,
      )
      .get(ETH_PRODUCT) as { t: number | null }
    return first.t === null
      ? undefined
      : Math.floor(Number(first.t) / MINUTE_MS) * MINUTE_MS
  }

  function runOnce(): RunResult {
    if (options.canRun?.() === false) return { written: 0, pending: false }
    const now = clock()
    // Minute [m, m + 60 s) is closed once now >= m + 60 s + margin.
    const closedEnd = Math.floor((now - marginMs) / MINUTE_MS) * MINUTE_MS
    cursor ??= startCursor()
    if (cursor === undefined || cursor >= closedEnd)
      return { written: 0, pending: false }
    const from = cursor
    const to = Math.min(from + maxMinutes * MINUTE_MS, closedEnd)
    const rows = db
      .prepare(
        `SELECT feed, received_at, normalized_json FROM paper_futures_market_events
         WHERE product_id=? AND received_at>=? AND received_at<?
         ORDER BY received_at, rowid`,
      )
      .all(ETH_PRODUCT, from, to) as EventRow[]
    const byMinute = new Map<number, EventRow[]>()
    for (const row of rows) {
      const minute = Math.floor(row.received_at / MINUTE_MS) * MINUTE_MS
      const bucket = byMinute.get(minute)
      if (bucket) bucket.push(row)
      else byMinute.set(minute, [row])
    }
    const insert = db.prepare(
      `INSERT OR IGNORE INTO ${SUMMARY_TABLE}
       (minute_start_ms,product_id,trade_count,buy_volume,sell_volume,vwap,last_price,spread_bp,
        top_bid_size,top_ask_size,depth_bid,depth_ask,events_seen,written_at_ms)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    let written = 0
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const [minute, bucket] of [...byMinute].sort(
        (a, b) => a[0] - b[0],
      )) {
        const s = summarizeMinute(minute, bucket)
        written += Number(
          insert.run(
            s.minuteStartMs,
            s.productId,
            s.tradeCount,
            s.buyVolume,
            s.sellVolume,
            s.vwap,
            s.lastPrice,
            s.spreadBp,
            s.topBidSize,
            s.topAskSize,
            s.depthBid,
            s.depthAsk,
            s.eventsSeen,
            now,
          ).changes,
        )
      }
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    cursor = to
    return { written, pending: to < closedEnd }
  }

  function schedule(delayMs: number, intervalMs: number): void {
    timer = setTimeout(() => {
      let pending = false
      try {
        pending = runOnce().pending
      } catch (error) {
        options.onError?.(error)
      }
      if (!stopped) schedule(pending ? 250 : intervalMs, intervalMs)
    }, delayMs)
    timer.unref()
  }

  return {
    runOnce,
    /** Runs now and then every `intervalMs` (default 30 s); catches up quickly while minutes are pending. */
    start(intervalMs = 30_000): void {
      if (timer !== undefined || stopped) return
      schedule(0, intervalMs)
    },
    stop(): void {
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      db.close()
    },
  }
}
