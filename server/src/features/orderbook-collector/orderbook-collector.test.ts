import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BookReconstructor } from './book.ts'
import { OrderBookCollector, type BookSocket } from './collector.ts'
import { BookStore } from './store.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

const snapshot = (seq: number, product = 'PF_XBTUSD') => ({
  feed: 'book_snapshot',
  product_id: product,
  seq,
  bids: [
    { price: 99.9, qty: 2 },
    { price: 99.5, qty: 5 },
  ],
  asks: [
    { price: 100.1, qty: 3 },
    { price: 100.6, qty: 4 },
  ],
})
const delta = (
  seq: number,
  side: string,
  price: number,
  qty: number,
  product = 'PF_XBTUSD',
) => ({
  feed: 'book',
  product_id: product,
  seq,
  side,
  price,
  qty,
})

describe('BookReconstructor', () => {
  it('rebuilds the book and computes depth around the mid', () => {
    const book = new BookReconstructor('PF_XBTUSD')
    expect(book.apply(snapshot(10)).kind).toBe('snapshot')
    expect(book.apply(delta(11, 'buy', 99.95, 1)).kind).toBe('delta')
    expect(book.apply(delta(12, 'sell', 100.6, 0)).kind).toBe('delta')
    const row = book.depth(1000)!
    expect(row.bestBid).toBe(99.95)
    expect(row.bestAsk).toBe(100.1)
    expect(row.levels).toEqual({ bids: 3, asks: 1 })
    expect(row.bidDepth['100']).toBe(8)
    expect(row.askDepth['100']).toBe(3)
  })

  it('reports a sequence gap and refuses to guess until a new snapshot', () => {
    const book = new BookReconstructor('PF_XBTUSD')
    book.apply(snapshot(10))
    expect(book.apply(delta(12, 'buy', 99.95, 1))).toEqual({
      kind: 'gap',
      expected: 11,
      actual: 12,
    })
    expect(book.depth(1)).toBeNull()
    expect(book.apply(delta(13, 'buy', 99.95, 1)).kind).toBe('ignored')
    expect(book.apply(snapshot(20)).kind).toBe('snapshot')
    expect(book.depth(1)).not.toBeNull()
  })

  it('returns no depth for a crossed book and ignores other products', () => {
    const book = new BookReconstructor('PF_XBTUSD')
    book.apply(snapshot(1))
    book.apply(delta(2, 'buy', 101, 1))
    expect(book.depth(1)).toBeNull()
    expect(book.apply(snapshot(1, 'PF_ETHUSD')).kind).toBe('ignored')
  })
})

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'book-collector-'))
  dirs.push(dir)
  const store = new BookStore(join(dir, 'book.sqlite'))
  const sent: string[] = []
  const socket: BookSocket = {
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    send: (m) => void sent.push(m),
    close: () => {},
  }
  let clock = 1_800_000_000_000
  const collector = new OrderBookCollector({
    store,
    products: ['PF_XBTUSD', 'PF_ETHUSD'],
    makeSocket: () => socket,
    now: () => clock,
    log: () => {},
    minFreeBytes: 0,
  })
  return {
    store,
    socket,
    sent,
    collector,
    advance: (ms: number) => (clock += ms),
    clock: () => clock,
  }
}
const gaps = (store: BookStore) =>
  store.db
    .prepare(
      'SELECT product_id, from_ms, to_ms, reason FROM book_gap ORDER BY gap_id',
    )
    .all() as {
    product_id: string | null
    from_ms: number
    to_ms: number
    reason: string
  }[]

describe('OrderBookCollector', () => {
  it('subscribes to the book of both products, stores depth and logs a sequence gap with a resubscribe', () => {
    const t = setup()
    t.collector.start()
    t.socket.onopen?.()
    expect(JSON.parse(t.sent[0]!)).toMatchObject({
      event: 'subscribe',
      feed: 'book',
      product_ids: ['PF_XBTUSD', 'PF_ETHUSD'],
    })
    t.collector.handle(snapshot(1))
    t.collector.handle(snapshot(1, 'PF_ETHUSD'))
    t.collector.snapshotNow()
    expect(
      (
        t.store.db.prepare('SELECT COUNT(*) AS n FROM book_depth').get() as {
          n: number
        }
      ).n,
    ).toBe(2)
    t.advance(1000)
    t.collector.handle(delta(5, 'buy', 99.95, 1))
    expect(gaps(t.store)[0]).toMatchObject({ product_id: 'PF_XBTUSD' })
    expect(gaps(t.store)[0]!.reason).toContain('sequence gap')
    expect(t.sent.some((m) => JSON.parse(m).event === 'unsubscribe')).toBe(true)
    t.collector.stop('test')
  })

  it('logs the silence when the socket drops', () => {
    const t = setup()
    t.collector.start()
    t.socket.onopen?.()
    t.collector.handle(snapshot(1))
    t.collector.snapshotNow()
    t.advance(60_000)
    t.socket.onclose?.()
    const row = gaps(t.store).find((g) => g.product_id === 'PF_XBTUSD')!
    expect(row.to_ms - row.from_ms).toBe(60_000)
    expect(row.reason).toContain('socket')
    t.collector.stop('test')
  })

  it('records a gap for a run that died without a clean stop', () => {
    const t = setup()
    t.collector.start()
    t.socket.onopen?.()
    t.collector.handle(snapshot(1))
    t.collector.snapshotNow()
    // Simulated crash: no stop(). A new run opens on the same database a minute later.
    t.store.startRun(t.clock() + 120_000)
    const down = gaps(t.store).find((g) => g.product_id === null)!
    expect(down.reason).toContain('no clean stop')
    expect(down.to_ms - down.from_ms).toBe(120_000)
    t.collector.stop('test')
  })

  it('keeps the file within its age and size limits', () => {
    const t = setup()
    const base = 1_800_000_000_000
    for (let i = 0; i < 50; i += 1) {
      t.store.depth({
        productId: 'PF_XBTUSD',
        receivedAt: base - 20 * 86_400_000 + i,
        bestBid: 1,
        bestAsk: 2,
        mid: 1.5,
        spreadBp: 1,
        bidDepth: {},
        askDepth: {},
        topBids: [],
        topAsks: [],
        levels: { bids: 1, asks: 1 },
        seq: i,
      })
    }
    expect(t.store.enforceLimits(base, 14, 1e9)).toBe(50)
    t.collector.stop('test')
  })
})
