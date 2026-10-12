/**
 * In-memory reconstruction of one Kraken Futures order book from the public
 * `book_snapshot` / `book` feed. Prices stay as the provider's decimal
 * strings (map keys); quantities are numbers because this only feeds
 * depth statistics, never an order.
 */
export const MAX_LEVELS_PER_SIDE = 5_000

export type BookMessage = Readonly<Record<string, unknown>>
export type Applied =
  | { kind: 'ignored' }
  | { kind: 'snapshot' }
  | { kind: 'delta' }
  | { kind: 'gap'; expected: number; actual: number }
  | { kind: 'invalid'; reason: string }

export interface DepthRow {
  readonly productId: string
  readonly receivedAt: number
  readonly bestBid: number
  readonly bestAsk: number
  readonly mid: number
  readonly spreadBp: number
  /** Base-currency quantity resting within N bp of the mid, per side. */
  readonly bidDepth: Readonly<Record<string, number>>
  readonly askDepth: Readonly<Record<string, number>>
  readonly topBids: readonly (readonly [number, number])[]
  readonly topAsks: readonly (readonly [number, number])[]
  readonly levels: { readonly bids: number; readonly asks: number }
  readonly seq: number
}

export const DEPTH_BANDS_BP = [5, 10, 25, 50, 100] as const

export class BookReconstructor {
  readonly bids = new Map<string, number>()
  readonly asks = new Map<string, number>()
  lastSeq: number | null = null
  synced = false
  readonly productId: string

  constructor(productId: string) {
    this.productId = productId
  }

  reset() {
    this.bids.clear()
    this.asks.clear()
    this.lastSeq = null
    this.synced = false
  }

  apply(message: BookMessage): Applied {
    const feed = message.feed
    if (feed !== 'book_snapshot' && feed !== 'book') return { kind: 'ignored' }
    if (message.product_id !== this.productId) return { kind: 'ignored' }
    const seq = message.seq
    if (typeof seq !== 'number' || !Number.isSafeInteger(seq))
      return { kind: 'invalid', reason: 'seq is not an integer' }
    if (feed === 'book_snapshot') {
      const bids = message.bids
      const asks = message.asks
      if (!Array.isArray(bids) || !Array.isArray(asks))
        return { kind: 'invalid', reason: 'snapshot without levels' }
      this.bids.clear()
      this.asks.clear()
      for (const [levels, side] of [
        [bids, this.bids],
        [asks, this.asks],
      ] as const)
        for (const item of levels.slice(0, MAX_LEVELS_PER_SIDE)) {
          const price = (item as Record<string, unknown>)?.price
          const qty = Number((item as Record<string, unknown>)?.qty)
          if (price === undefined || !Number.isFinite(qty) || qty < 0)
            return this.fail('snapshot level is invalid')
          if (qty > 0) side.set(String(price), qty)
        }
      this.lastSeq = seq
      this.synced = true
      return { kind: 'snapshot' }
    }
    if (!this.synced || this.lastSeq === null) return { kind: 'ignored' }
    if (seq !== this.lastSeq + 1) {
      const expected = this.lastSeq + 1
      this.synced = false
      return { kind: 'gap', expected, actual: seq }
    }
    const side =
      message.side === 'buy'
        ? this.bids
        : message.side === 'sell'
          ? this.asks
          : null
    const qty = Number(message.qty)
    if (
      side === null ||
      message.price === undefined ||
      !Number.isFinite(qty) ||
      qty < 0
    )
      return this.fail('delta is invalid')
    const price = String(message.price)
    if (qty === 0) side.delete(price)
    else if (side.size < MAX_LEVELS_PER_SIDE || side.has(price))
      side.set(price, qty)
    this.lastSeq = seq
    return { kind: 'delta' }
  }

  private fail(reason: string): Applied {
    this.synced = false
    return { kind: 'invalid', reason }
  }

  /** Depth statistics, or `null` while the book is unsynced, empty or crossed. */
  depth(receivedAt: number, topN = 5): DepthRow | null {
    if (!this.synced || this.lastSeq === null) return null
    const bids = [...this.bids]
      .map(([p, q]) => [Number(p), q] as const)
      .sort((a, b) => b[0] - a[0])
    const asks = [...this.asks]
      .map(([p, q]) => [Number(p), q] as const)
      .sort((a, b) => a[0] - b[0])
    if (bids.length === 0 || asks.length === 0) return null
    const bestBid = bids[0]![0]
    const bestAsk = asks[0]![0]
    if (!(bestBid > 0 && bestBid < bestAsk)) return null
    const mid = (bestBid + bestAsk) / 2
    const bidDepth: Record<string, number> = {}
    const askDepth: Record<string, number> = {}
    for (const band of DEPTH_BANDS_BP) {
      const lo = mid * (1 - band / 10_000)
      const hi = mid * (1 + band / 10_000)
      bidDepth[band] = bids.reduce(
        (sum, [p, q]) => (p >= lo ? sum + q : sum),
        0,
      )
      askDepth[band] = asks.reduce(
        (sum, [p, q]) => (p <= hi ? sum + q : sum),
        0,
      )
    }
    return {
      productId: this.productId,
      receivedAt,
      bestBid,
      bestAsk,
      mid,
      spreadBp: ((bestAsk - bestBid) / mid) * 10_000,
      bidDepth,
      askDepth,
      topBids: bids.slice(0, topN).map(([p, q]) => [p, q] as const),
      topAsks: asks.slice(0, topN).map(([p, q]) => [p, q] as const),
      levels: { bids: bids.length, asks: asks.length },
      seq: this.lastSeq,
    }
  }
}
