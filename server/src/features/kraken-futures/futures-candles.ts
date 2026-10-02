import { createHash } from 'node:crypto'
import type { TradeEvent } from './futures-market.ts'

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

/** Trade-derived revisions only; no empty-candle or zero-volume inference. */
export class FuturesCandleBuilder {
  private readonly store: CandleRevisionStore
  private readonly intervals: number[]
  private readonly candles = new Map<
    string,
    {
      bucket: number
      interval: number
      open: string
      high: string
      low: string
      close: string
      volume: string
      count: number
      uids: string[]
      revision: number
      closed: boolean
      latestTime: number
      latestSeq: number
    }
  >()
  private readonly seen = new Set<string>()
  private readonly maxCandles = 50_000

  constructor(
    store: CandleRevisionStore,
    intervals = [60_000, 300_000, 900_000, 3_600_000],
  ) {
    this.store = store
    this.intervals = intervals
  }

  addTrade(trade: TradeEvent, now: number): void {
    if (trade.recovered || this.seen.has(trade.uid)) return
    this.seen.add(trade.uid)
    for (const interval of this.intervals) {
      const bucket = Math.floor(trade.eventTime / interval) * interval
      const id = `${trade.productId}:${interval}:${bucket}`
      const current = this.candles.get(id)
      const closed = now >= bucket + interval
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
      this.persist(id, candle, trade.receivedAt)
    }
    if (this.seen.size > 250_000)
      this.seen.delete(this.seen.values().next().value!)
  }

  advanceClock(now: number): void {
    integer(now, 'candle clock')
    for (const [id, candle] of this.candles) {
      if (!candle.closed && now >= candle.bucket + candle.interval) {
        candle.closed = true
        candle.revision += 1
        this.persist(id, candle, now)
      }
    }
  }

  private persist(
    id: string,
    candle: NonNullable<ReturnType<typeof this.candles.get>>,
    knownAt: number,
  ): void {
    const sourceHash = createHash('sha256')
      .update(candle.uids.join('\n'))
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
  }
}
