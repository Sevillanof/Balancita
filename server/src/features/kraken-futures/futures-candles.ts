import { createHash } from 'node:crypto'
import type { TradeEvent } from './futures-market.ts'
import type { StoredCandleHead } from './futures-market-store.ts'

interface CandleRevisionStore {
  saveCandleRevision(candle: {
    id: string
    intervalMs: number
    bucketStart: number
    revision: number
    knownAt: number
    closeAt?: number
    isClosed: boolean
    coverage: string
    open: string
    high: string
    low: string
    close: string
    volumeBtc: string
    tradeCount: number
    sourceHash: string
  }): void
  candleHeadById?(candleId: string): StoredCandleHead | undefined
  openCandleHeads?(
    intervalMs: number,
    sinceBucketStart: number,
  ): StoredCandleHead[]
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new TypeError(`${label} must be a nonnegative safe integer.`)
  return value as number
}

function compareDecimals(a: string, b: string): number {
  const [aw, af = ''] = a.split('.')
  const [bw, bf = ''] = b.split('.')
  const ai = BigInt(aw!),
    bi = BigInt(bw!)
  if (ai !== bi) return ai < bi ? -1 : 1
  const width = Math.max(af.length, bf.length)
  const av = BigInt(af.padEnd(width, '0') || '0')
  const bv = BigInt(bf.padEnd(width, '0') || '0')
  return av === bv ? 0 : av < bv ? -1 : 1
}

function addDecimals(left: string, right: string): string {
  const scale = Math.max(
    left.split('.')[1]?.length ?? 0,
    right.split('.')[1]?.length ?? 0,
  )
  const factor = 10n ** BigInt(scale)
  const units = (value: string): bigint => {
    const [whole, fraction = ''] = value.split('.')
    return (
      BigInt(whole!) * factor +
      BigInt((fraction + '0'.repeat(scale)).slice(0, scale) || '0')
    )
  }
  const sum = units(left) + units(right)
  const whole = sum / factor
  const fraction = (sum % factor)
    .toString()
    .padStart(scale, '0')
    .replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : String(whole)
}

function isRevisionCollision(error: unknown): boolean {
  return (
    error instanceof Error && /UNIQUE constraint failed/.test(error.message)
  )
}

interface CandleState {
  bucket: number
  interval: number
  open: string
  high: string
  low: string
  close: string
  volume: string
  count: number
  uids: string[]
  /** Source hash of the revisions persisted before a restart, if resumed. */
  baseHash?: string
  revision: number
  closed: boolean
  latestTime: number
  latestSeq: number
}

/** Trade-derived revisions only; no empty-candle or zero-volume inference. */
export class FuturesCandleBuilder {
  private readonly store: CandleRevisionStore
  private readonly intervals: number[]
  private readonly candles = new Map<string, CandleState>()
  private readonly seen = new Set<string>()
  private readonly maxCandles = 50_000
  private readonly onRevision?: (candle: {
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
  }) => void

  constructor(
    store: CandleRevisionStore,
    intervals = [60_000, 300_000, 900_000, 3_600_000],
    onRevision?: (candle: {
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
    }) => void,
  ) {
    this.store = store
    this.intervals = intervals
    this.onRevision = onRevision
  }

  addTrade(trade: TradeEvent, now: number): void {
    if (trade.recovered || this.seen.has(trade.uid)) return
    this.seen.add(trade.uid)
    let failure: unknown
    // One interval failing must not skip the others.
    for (const interval of this.intervals) {
      try {
        this.addToInterval(trade, now, interval)
      } catch (error) {
        failure ??= error
      }
    }
    if (this.seen.size > 250_000)
      this.seen.delete(this.seen.values().next().value!)
    if (failure !== undefined) throw failure
  }

  private addToInterval(trade: TradeEvent, now: number, interval: number) {
    const bucket = Math.floor(trade.eventTime / interval) * interval
    const id = `${trade.productId}:${interval}:${bucket}`
    const closed = now >= bucket + interval
    const apply = (current: CandleState | undefined): CandleState => {
      const candle = current ?? {
        bucket,
        interval,
        open: trade.priceUsd,
        high: trade.priceUsd,
        low: trade.priceUsd,
        close: trade.priceUsd,
        volume: '0',
        count: 0,
        uids: [],
        revision: 0,
        closed,
        latestTime: -1,
        latestSeq: -1,
      }
      if (compareDecimals(trade.priceUsd, candle.high) > 0)
        candle.high = trade.priceUsd
      if (compareDecimals(trade.priceUsd, candle.low) < 0)
        candle.low = trade.priceUsd
      if (
        trade.eventTime > candle.latestTime ||
        (trade.eventTime === candle.latestTime && trade.seq > candle.latestSeq)
      ) {
        candle.close = trade.priceUsd
        candle.latestTime = trade.eventTime
        candle.latestSeq = trade.seq
      }
      candle.volume = addDecimals(candle.volume, trade.quantityBtc)
      candle.count += 1
      candle.uids.push(trade.uid)
      candle.closed ||= closed
      candle.revision += 1
      this.candles.set(id, candle)
      while (this.candles.size > this.maxCandles) {
        const oldest = this.candles.keys().next().value as string | undefined
        if (oldest === undefined) break
        this.candles.delete(oldest)
      }
      return candle
    }
    const candle = apply(
      this.candles.get(id) ?? this.resume(this.store.candleHeadById?.(id)),
    )
    try {
      this.persist(id, candle, trade.receivedAt)
    } catch (error) {
      // Whatever failed, the in-memory state is ahead of the store: forget it
      // so the next trade resumes from the stored head.
      this.candles.delete(id)
      if (!isRevisionCollision(error)) throw error
      // Another writer advanced this candle since we last read it. Each trade
      // is committed by exactly one writer (market events dedupe on uid), so
      // this trade is still ours to add on top of the stored head.
      const head = this.store.candleHeadById?.(id)
      if (head === undefined) throw error
      const rebuilt = apply(this.resume(head))
      try {
        this.persist(id, rebuilt, trade.receivedAt)
      } catch (retry) {
        this.candles.delete(id)
        throw retry
      }
    }
  }

  /**
   * Resumes candles left open by a previous process so a restart continues
   * their revision numbering and aggregates and still closes them on time.
   * Candles older than two intervals stay as stored.
   */
  restoreOpenCandles(now: number): void {
    integer(now, 'candle clock')
    if (!this.store.openCandleHeads) return
    for (const interval of this.intervals) {
      const since = Math.max(
        0,
        Math.floor(now / interval) * interval - 2 * interval,
      )
      for (const head of this.store.openCandleHeads(interval, since))
        if (!this.candles.has(head.id)) this.resume(head)
    }
  }

  /** Rebuilds in-memory candle state from its latest stored revision. */
  private resume(head: StoredCandleHead | undefined): CandleState | undefined {
    if (head === undefined) return undefined
    const candle = {
      bucket: head.bucketStart,
      interval: head.intervalMs,
      open: head.open,
      high: head.high,
      low: head.low,
      close: head.close,
      volume: head.volumeBtc,
      count: head.tradeCount,
      uids: [] as string[],
      baseHash: head.sourceHash,
      revision: head.revision,
      closed: head.closed,
      // Trade time/sequence of the last close are not stored: the last
      // revision's receipt time bounds them for in-order live trades.
      latestTime: head.knownAt,
      latestSeq: -1,
    }
    this.candles.set(head.id, candle)
    return candle
  }

  advanceClock(now: number): void {
    integer(now, 'candle clock')
    let failure: unknown
    for (const [id, candle] of [...this.candles]) {
      if (candle.closed || now < candle.bucket + candle.interval) continue
      try {
        this.closeCandle(id, candle, now)
      } catch (error) {
        failure ??= error
      }
    }
    if (failure !== undefined) throw failure
  }

  private closeCandle(id: string, candle: CandleState, now: number): void {
    candle.closed = true
    candle.revision += 1
    try {
      this.persist(id, candle, now)
    } catch (error) {
      if (!isRevisionCollision(error)) {
        // Retry on the next tick.
        candle.closed = false
        candle.revision -= 1
        throw error
      }
      // Another writer moved this candle on: re-read it and close that.
      this.candles.delete(id)
      const head = this.store.candleHeadById?.(id)
      if (head === undefined) throw error
      const fresh = this.resume(head)!
      if (fresh.closed) return
      fresh.closed = true
      fresh.revision += 1
      try {
        this.persist(id, fresh, now)
      } catch (retry) {
        this.candles.delete(id)
        throw retry
      }
    }
  }

  private persist(id: string, candle: CandleState, knownAt: number): void {
    // A resumed candle chains the hash persisted before the restart.
    const sourceHash = createHash('sha256')
      .update(
        candle.baseHash === undefined
          ? candle.uids.join('\n')
          : [candle.baseHash, ...candle.uids].join('\n'),
      )
      .digest('hex')
    this.store.saveCandleRevision({
      id,
      intervalMs: candle.interval,
      bucketStart: candle.bucket,
      revision: candle.revision,
      knownAt,
      ...(candle.closed ? { closeAt: candle.bucket + candle.interval } : {}),
      isClosed: candle.closed,
      coverage: 'observed_trades_only_no_gap_certification',
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volumeBtc: candle.volume,
      tradeCount: candle.count,
      sourceHash,
    })
    this.onRevision?.({
      id,
      interval_ms: candle.interval,
      bucket_start_ms: candle.bucket,
      known_at_ms: knownAt,
      close_at_ms: candle.closed ? candle.bucket + candle.interval : null,
      closed: candle.closed,
      coverage: 'observed_trades_only_no_gap_certification',
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume_btc: candle.volume,
      trade_count: candle.count,
    })
  }
}
