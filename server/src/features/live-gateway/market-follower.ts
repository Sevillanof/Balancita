import { existsSync } from 'node:fs'
import {
  FuturesMarketStore,
  type OfficialStoredCandle,
} from '../kraken-futures/futures-market-store.ts'
import { FUTURES_PRODUCT } from '../kraken-futures/futures-market.ts'
import { closedHistoryRows, toTerminalMarket } from './terminal-market.ts'
import {
  chartCandles,
  chartDepth,
  chartFlow,
  tickerStats,
  type ChartCandle,
  type TickerStats,
} from './terminal-chart.ts'

export const CANDLE_INTERVAL_MS = 60_000
const PRICE_LOOKBACK_ROWS = 2_000
const PAGE = 500
const MAX_PAGES = 10
const OFFICIAL_BUCKETS_KEPT = 500

export interface TerminalMarketView {
  readonly schema_version: 'futures-terminal-market.v1'
  readonly as_of_ms: number
  readonly interval_ms: number
  readonly candles: Array<{
    time_ms: unknown
    open: unknown
    high: unknown
    low: unknown
    close: unknown
    volume_btc: unknown
    closed: boolean
  }>
}

export type FollowerStatus = 'live' | 'stale' | 'unavailable'

type Row = Record<string, unknown>

export interface CandleDto {
  readonly id: string
  readonly interval_ms: number
  readonly bucket_start_ms: number
  readonly known_at_ms: number
  readonly close_at_ms: number | null
  readonly closed: boolean
  readonly coverage: string
  readonly open: string
  readonly high: string
  readonly low: string
  readonly close: string
  readonly volume_btc: string
  readonly trade_count: number
}

interface PriceView {
  readonly feed: 'ticker' | 'trade'
  readonly normalized: Row
  readonly event_time: number
  readonly received_at: number
}

function toCandle(row: Row): CandleDto {
  const bucket = Number(row.bucket_start)
  const closed = Number(row.is_closed) === 1
  const knownAt = Number(row.known_at)
  return {
    id: String(row.candle_id),
    interval_ms: Number(row.interval_ms),
    bucket_start_ms: bucket,
    // A closed revision is never reported as known before its bucket ended.
    known_at_ms: closed
      ? Math.max(knownAt, bucket + Number(row.interval_ms))
      : knownAt,
    close_at_ms: row.close_at === null ? null : Number(row.close_at),
    closed,
    coverage: String(row.coverage),
    open: String(row.open_price),
    high: String(row.high_price),
    low: String(row.low_price),
    close: String(row.close_price),
    volume_btc: String(row.volume_btc),
    trade_count: Number(row.trade_count),
  }
}

/** An official candle as the closed-candle update the client already reduces. */
function toOfficialCandle(
  candle: OfficialStoredCandle,
  productId: string,
): CandleDto {
  return {
    id: `${productId}:${candle.intervalMs}:${candle.bucketStart}`,
    interval_ms: candle.intervalMs,
    bucket_start_ms: candle.bucketStart,
    known_at_ms: Math.max(candle.knownAt, candle.closeAt),
    close_at_ms: candle.closeAt,
    closed: true,
    coverage: 'official_kraken_charts',
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume_btc: candle.volumeBtc,
    trade_count: 0,
  }
}

function toPrice(event: Row): PriceView {
  const normalized = { ...event }
  delete normalized.raw
  delete normalized.rawJson
  return {
    feed: event.type === 'trade' ? 'trade' : 'ticker',
    normalized,
    event_time: Number(event.eventTime),
    received_at: Number(event.receivedAt),
  }
}

/**
 * Read-only follower of the capture process's market database. It never
 * creates schema or writes; it tails ticker/trade events and 60 s candle
 * revisions by rowid and reports capture freshness from the newest event.
 */
export class LiveMarketFollower {
  private readonly dbPath: string
  private readonly clock: () => number
  private readonly staleAfterMs: number
  readonly productId: string
  private store: FuturesMarketStore | undefined
  private eventCursor = 0
  private candleCursor = 0
  private officialCursor = 0
  /** Recent buckets whose official candle was served: observed ones lose. */
  private readonly officialBuckets = new Set<number>()
  private latestPrice: PriceView | undefined
  private latestTicker: TickerStats | null = null
  private latestCandle: CandleDto | undefined
  private lastStatusKey = ''
  private lastError: string | undefined

  constructor(options: {
    dbPath: string
    /** Pinned `PF_*` product this view follows (default: the BTC perpetual). */
    productId?: string
    clock?: () => number
    staleAfterMs?: number
  }) {
    this.productId = options.productId ?? FUTURES_PRODUCT
    this.dbPath = options.dbPath
    this.clock = options.clock ?? Date.now
    this.staleAfterMs = options.staleAfterMs ?? 15_000
  }

  /** Only the BTC perpetual has observed (trade-built) candles. */
  private get observed(): boolean {
    return this.productId === FUTURES_PRODUCT
  }

  get lastFailure(): string | undefined {
    return this.lastError
  }

  close(): void {
    this.store?.close()
    this.store = undefined
  }

  /** Opens the read-only handle when the writer's database is ready. */
  private open(): FuturesMarketStore | undefined {
    if (this.store) return this.store
    if (!existsSync(this.dbPath)) return undefined
    let opened: FuturesMarketStore | undefined
    try {
      opened = new FuturesMarketStore(this.dbPath, { readOnly: true })
      this.eventCursor = opened.maxEventRowid()
      // Observed candle revisions are built from the BTC trade feed only.
      this.candleCursor = this.observed ? opened.maxCandleRevisionRowid() : 0
      this.officialCursor = opened.maxOfficialRowid()
      this.officialBuckets.clear()
      for (const candle of opened.officialCandlesAsOf(
        this.productId,
        CANDLE_INTERVAL_MS,
        Number.MAX_SAFE_INTEGER,
        OFFICIAL_BUCKETS_KEPT,
      ))
        this.officialBuckets.add(candle.bucketStart)
      const recent = opened.tickerTradeEventsAfter(
        Math.max(0, this.eventCursor - PRICE_LOOKBACK_ROWS),
        PRICE_LOOKBACK_ROWS,
        this.productId,
      )
      const lastEvent =
        recent.at(-1)?.event ??
        opened.latestTickerAsOf(Number.MAX_SAFE_INTEGER, this.productId)
      this.latestPrice = lastEvent ? toPrice(lastEvent) : undefined
      const lastTicker = [...recent]
        .reverse()
        .find((row) => row.event.type === 'ticker')?.event
      this.latestTicker = tickerStats(
        lastTicker ??
          opened.latestTickerAsOf(Number.MAX_SAFE_INTEGER, this.productId) ??
          {},
      )
      const candle = this.observed
        ? opened.latestCandleRevision(CANDLE_INTERVAL_MS)
        : undefined
      this.latestCandle = candle ? toCandle(candle) : undefined
      this.store = opened
      this.lastError = undefined
      return opened
    } catch (error) {
      // Schema not created yet (writer still starting) or file unreadable.
      opened?.close()
      this.lastError = error instanceof Error ? error.message : String(error)
      return undefined
    }
  }

  status(): {
    status: FollowerStatus
    reason: string | null
    lastReceivedAt: number | null
  } {
    const store = this.open()
    if (!store)
      return {
        status: 'unavailable',
        reason: 'capture_not_started',
        lastReceivedAt: null,
      }
    let lastReceivedAt: number | null
    try {
      lastReceivedAt = store.latestEventReceivedAt()
    } catch (error) {
      this.dropStore(error)
      return {
        status: 'unavailable',
        reason: 'market_db_unreadable',
        lastReceivedAt: null,
      }
    }
    if (lastReceivedAt === null)
      return { status: 'unavailable', reason: 'no_market_data', lastReceivedAt }
    if (this.clock() - lastReceivedAt > this.staleAfterMs)
      return { status: 'stale', reason: 'capture_stale', lastReceivedAt }
    return { status: 'live', reason: null, lastReceivedAt }
  }

  private dropStore(error: unknown): void {
    this.lastError = error instanceof Error ? error.message : String(error)
    this.store?.close()
    this.store = undefined
  }

  /** Market block shared by bootstrap and snapshot. */
  marketView(): Row {
    const status = this.status()
    const price = this.latestPrice
    return {
      status: status.status,
      reason: status.reason,
      last_received_at: status.lastReceivedAt,
      latest_quote: price
        ? {
            last:
              price.feed === 'trade'
                ? (price.normalized.priceUsd ?? null)
                : (price.normalized.last ?? null),
            mark: price.normalized.mark ?? null,
            event_time: price.event_time,
            received_at: price.received_at,
          }
        : null,
      ticker_stats: this.latestTicker,
      book_status: 'not_reported',
      book_quality: 'not_reported',
      source_guarantee: 'undocumented',
      funding: 'unknown',
      funding_known_at: null,
    }
  }

  /** Latest mark price as a decimal string (equity is marked to it). */
  markPrice(): string | null {
    const mark = this.latestPrice?.normalized.mark
    return typeof mark === 'string' && /^-?\d+(?:\.\d+)?$/.test(mark)
      ? mark
      : null
  }

  /** Price block in the shape `market.updated` consumers read. */
  priceFields(): Row {
    const price = this.latestPrice
    return price
      ? {
          feed: price.feed,
          normalized: price.normalized,
          event_time: price.event_time,
          received_at: price.received_at,
        }
      : {}
  }

  terminalMarket(): TerminalMarketView {
    const store = this.open()
    if (!store) return toTerminalMarket([])
    let base: TerminalMarketView
    try {
      base = toTerminalMarket(closedHistoryRows(store, this.productId))
    } catch (error) {
      this.dropStore(error)
      return toTerminalMarket([])
    }
    const forming = this.latestCandle
    const now = this.clock()
    // Show the forming candle only while it is current; a stale open bucket
    // from a stopped capture would otherwise look live.
    if (
      !forming ||
      forming.closed ||
      forming.bucket_start_ms + 2 * CANDLE_INTERVAL_MS < now ||
      (base.candles.at(-1) &&
        Number(base.candles.at(-1)!.time_ms) >= forming.bucket_start_ms)
    )
      return base
    return {
      ...base,
      as_of_ms: Math.max(base.as_of_ms, forming.known_at_ms),
      candles: [
        ...base.candles,
        {
          time_ms: forming.bucket_start_ms,
          open: forming.open,
          high: forming.high,
          low: forming.low,
          close: forming.close,
          volume_btc: forming.volume_btc,
          closed: false,
        },
      ].slice(-500),
    }
  }

  /**
   * Chart series of one timeframe: candles (official, then provisional ones
   * built from finer data), Kraken analytics folded into the same buckets,
   * the latest depth snapshot and the latest ticker stats.
   */
  terminalChart(intervalMs: number): Row {
    const now = this.clock()
    const store = this.open()
    const empty = {
      schema_version: 'futures-terminal-chart.v1',
      product_id: this.productId,
      interval_ms: intervalMs,
      as_of_ms: now,
      candles: [] as ChartCandle[],
      flow: [],
      depth: null,
      ticker: this.latestTicker,
    }
    if (!store) return empty
    try {
      const minutes = this.terminalMarket().candles.map((candle) => ({
        time_ms: Number(candle.time_ms),
        open: String(candle.open),
        high: String(candle.high),
        low: String(candle.low),
        close: String(candle.close),
        volume_btc: String(candle.volume_btc),
        closed: candle.closed,
      }))
      const candles = chartCandles(
        store,
        intervalMs,
        minutes,
        now,
        this.productId,
      )
      return {
        ...empty,
        candles,
        flow: chartFlow(
          store,
          intervalMs,
          candles[0]?.time_ms ?? now,
          this.productId,
        ),
        depth: chartDepth(store, now, this.productId),
      }
    } catch (error) {
      this.dropStore(error)
      return empty
    }
  }

  metadataHash(): string | null {
    const store = this.open()
    try {
      return store?.latestInstrumentMetadataHash() ?? null
    } catch {
      return null
    }
  }

  /**
   * Reads rows appended since the previous call and returns `market.updated`
   * payloads (one per changed candle bucket, newest price on the last one).
   * Also reports capture freshness changes.
   */
  poll(): Row[] {
    const store = this.open()
    const candles = new Map<number, CandleDto>()
    let priced = false
    let tickered = false
    if (store) {
      try {
        for (let page = 0; this.observed && page < MAX_PAGES; page += 1) {
          const rows = store.candleRevisionsAfter(
            this.candleCursor,
            CANDLE_INTERVAL_MS,
            PAGE,
          )
          if (rows.length === 0) break
          for (const row of rows) {
            const candle = toCandle(row.revision)
            // The official candle already won this bucket: an observed
            // revision must not replace it on the client.
            if (
              candle.closed &&
              this.officialBuckets.has(candle.bucket_start_ms)
            )
              continue
            candles.set(candle.bucket_start_ms, candle)
            this.latestCandle = candle
          }
          this.candleCursor = rows.at(-1)!.rowid
          if (rows.length < PAGE) break
        }
        for (let page = 0; page < MAX_PAGES; page += 1) {
          const rows = store.officialCandlesAfter(
            this.productId,
            this.officialCursor,
            CANDLE_INTERVAL_MS,
            PAGE,
          )
          if (rows.length === 0) break
          for (const row of rows) {
            const candle = toOfficialCandle(row.candle, this.productId)
            this.officialBuckets.add(candle.bucket_start_ms)
            candles.set(candle.bucket_start_ms, candle)
          }
          this.officialCursor = rows.at(-1)!.rowid
          if (rows.length < PAGE) break
        }
        for (const bucket of this.officialBuckets)
          if (this.officialBuckets.size <= OFFICIAL_BUCKETS_KEPT) break
          else this.officialBuckets.delete(bucket)
        for (let page = 0; page < MAX_PAGES; page += 1) {
          const rows = store.tickerTradeEventsAfter(
            this.eventCursor,
            PAGE,
            this.productId,
          )
          if (rows.length === 0) break
          this.latestPrice = toPrice(rows.at(-1)!.event)
          priced = true
          const ticker = rows.findLast((row) => row.event.type === 'ticker')
          if (ticker) {
            this.latestTicker = tickerStats(ticker.event)
            tickered = true
          }
          this.eventCursor = rows.at(-1)!.rowid
          if (rows.length < PAGE) break
        }
      } catch (error) {
        this.dropStore(error)
      }
    }
    const status = this.status()
    const statusKey = `${status.status}:${status.reason}`
    const statusChanged = statusKey !== this.lastStatusKey
    this.lastStatusKey = statusKey
    if (candles.size === 0 && !priced && !statusChanged) return []
    const common = {
      last_received_at: status.lastReceivedAt,
      market_status: status.status,
      reason: status.reason,
      ...(tickered ? { ticker_stats: this.latestTicker } : {}),
    }
    const ordered = [...candles.values()].sort(
      (left, right) => left.bucket_start_ms - right.bucket_start_ms,
    )
    if (ordered.length === 0)
      return [{ ...common, ...(priced ? this.priceFields() : {}) }]
    return ordered.map((candle, index) => ({
      candle,
      ...common,
      ...(index === ordered.length - 1 && priced ? this.priceFields() : {}),
    }))
  }
}
