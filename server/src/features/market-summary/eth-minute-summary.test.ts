import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { FuturesMarketStore } from '../kraken-futures/futures-market-store.ts'
import {
  createEthMinuteSummary,
  DEFAULT_CLOSE_MARGIN_MS,
  SUMMARY_TABLE,
} from './eth-minute-summary.ts'

const MIN = 60_000
// A multiple of one minute.
const T0 = 28_333_334 * MIN
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

let counter = 0
function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'balancita-eth-summary-'))
  dirs.push(dir)
  const path = join(dir, 'market.sqlite')
  const store = new FuturesMarketStore(path)
  return { path, store }
}

function ticker(
  product: string,
  receivedAt: number,
  bid: string,
  ask: string,
  extra: { last?: string; bidSize?: string; askSize?: string } = {},
) {
  counter += 1
  return {
    type: 'ticker',
    productId: product,
    seq: counter,
    epoch: 1_000_000,
    eventTime: receivedAt,
    receivedAt,
    persistedAt: receivedAt,
    bid,
    ask,
    mark: bid,
    ...(extra.last === undefined ? {} : { last: extra.last }),
    suspended: false,
    funding: { status: 'unknown' },
    raw: {
      feed: 'ticker',
      bid_size: extra.bidSize ?? null,
      ask_size: extra.askSize ?? null,
    },
  }
}

/** Inserts a raw event row directly, so each test controls every stored field (the capture-to-summary path is in eth-summary-wiring.test.ts). */
function insertRaw(
  path: string,
  feed: 'trade' | 'book',
  receivedAt: number,
  normalized: Record<string, unknown>,
  product = 'PF_ETHUSD',
) {
  counter += 1
  const db = new DatabaseSync(path)
  db.prepare(
    `INSERT INTO paper_futures_market_events
     (event_id,feed,product_id,epoch,seq,event_time,received_at,persisted_at,uid,raw_json,normalized_json,content_hash)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    `${feed}:${product}:${counter}`,
    feed,
    product,
    1,
    counter,
    receivedAt,
    receivedAt,
    receivedAt,
    feed === 'trade' ? `uid-${counter}` : null,
    '{}',
    JSON.stringify(normalized),
    `hash-${counter}`,
  )
  db.close()
}

const trade = (side: 'buy' | 'sell', qty: string, price: string) => ({
  type: 'trade',
  side,
  quantityBtc: qty,
  priceUsd: price,
  tradeType: 'fill',
})

type Summary = Record<string, number | string | null>
function rows(path: string): Summary[] {
  const db = new DatabaseSync(path, { readOnly: true })
  const out = db
    .prepare(`SELECT * FROM ${SUMMARY_TABLE} ORDER BY minute_start_ms`)
    .all() as Summary[]
  db.close()
  return out
}

function make(path: string, now: number, maxMinutesPerRun?: number) {
  return createEthMinuteSummary({
    dbPath: path,
    clock: () => now,
    maxMinutesPerRun,
  })
}
const AFTER_CLOSE = T0 + MIN + DEFAULT_CLOSE_MARGIN_MS

describe('ETH minute summary: aggregation (S4)', () => {
  it('splits buy and sell volume, counts trades and computes vwap and last price', () => {
    const { path, store } = fresh()
    store.append(ticker('PF_ETHUSD', T0 + 1_000, '99', '101')) // makes the minute exist for ETH
    insertRaw(path, 'trade', T0 + 2_000, trade('buy', '2', '100'))
    insertRaw(path, 'trade', T0 + 3_000, trade('buy', '1', '103'))
    insertRaw(path, 'trade', T0 + 4_000, trade('sell', '4', '101'))
    const summary = make(path, AFTER_CLOSE)
    expect(summary.runOnce()).toEqual({ written: 1, pending: false })
    const [row] = rows(path)
    expect(row).toMatchObject({
      minute_start_ms: T0,
      product_id: 'PF_ETHUSD',
      trade_count: 3,
      buy_volume: 3,
      sell_volume: 4,
      vwap: 101, // (2*100 + 1*103 + 4*101) / 7
      last_price: 101,
      events_seen: 4,
      written_at_ms: AFTER_CLOSE,
    })
    summary.stop()
  })

  it('averages the spread in basis points and the top-of-book sizes of the tickers', () => {
    const { path, store } = fresh()
    // mid 100 -> 20 bp; mid 100 -> 10 bp.
    store.append(
      ticker('PF_ETHUSD', T0 + 1_000, '99.9', '100.1', {
        last: '100.02',
        bidSize: '10',
        askSize: '4',
      }),
    )
    store.append(
      ticker('PF_ETHUSD', T0 + 2_000, '99.95', '100.05', {
        last: '100.04',
        bidSize: '20',
        askSize: '8',
      }),
    )
    const summary = make(path, AFTER_CLOSE)
    summary.runOnce()
    const [row] = rows(path)
    expect(row.spread_bp as number).toBeCloseTo(15, 9)
    expect(row).toMatchObject({
      top_bid_size: 15,
      top_ask_size: 6,
      last_price: 100.04, // no trades: last ticker `last`
      events_seen: 2,
    })
    summary.stop()
  })

  it('sums the book depth within +-0.1 % of the mid and averages it over snapshots', () => {
    const { path, store } = fresh()
    store.append(ticker('PF_ETHUSD', T0 + 500, '99', '101'))
    // mid = 100: window 99.9 .. 100.1.
    insertRaw(path, 'book', T0 + 1_000, {
      type: 'book',
      snapshot: true,
      bids: [
        { price: '99.95', quantity: '2.5' },
        { price: '99.91', quantity: '3' },
        { price: '99.8', quantity: '10' }, // outside
      ],
      asks: [
        { price: '100.05', quantity: '1' },
        { price: '100.09', quantity: '4' },
        { price: '100.2', quantity: '9' }, // outside
      ],
    })
    // Second snapshot: only the best levels, depth 1 / 1.
    insertRaw(path, 'book', T0 + 2_000, {
      type: 'book',
      snapshot: true,
      bids: [{ price: '99.95', quantity: '1' }],
      asks: [{ price: '100.05', quantity: '1' }],
    })
    // Incremental book messages carry no full book: ignored.
    insertRaw(path, 'book', T0 + 3_000, {
      type: 'book',
      snapshot: false,
      side: 'bid',
      price: '99.99',
      quantity: '500',
    })
    const summary = make(path, AFTER_CLOSE)
    summary.runOnce()
    const [row] = rows(path)
    expect(row.depth_bid).toBeCloseTo((5.5 + 1) / 2, 9)
    expect(row.depth_ask).toBeCloseTo((5 + 1) / 2, 9)
    summary.stop()
  })

  it('leaves NULL what the stored events cannot support (no book, no trades)', () => {
    const { path, store } = fresh()
    store.append(
      ticker('PF_ETHUSD', T0 + 1_000, '99.9', '100.1', {
        bidSize: '1',
        askSize: '1',
      }),
    )
    const summary = make(path, AFTER_CLOSE)
    summary.runOnce()
    const [row] = rows(path)
    expect(row).toMatchObject({
      trade_count: null,
      buy_volume: null,
      sell_volume: null,
      vwap: null,
      last_price: null,
      depth_bid: null,
      depth_ask: null,
    })
    expect(row.spread_bp).not.toBeNull()
    summary.stop()
  })

  it('ignores unusable payloads without failing, but still counts the events seen', () => {
    const { path, store } = fresh()
    store.append(ticker('PF_ETHUSD', T0 + 1_000, '99.9', '100.1'))
    insertRaw(path, 'trade', T0 + 2_000, trade('buy', '0', '100'))
    insertRaw(path, 'trade', T0 + 3_000, {
      ...trade('buy', '1', '100'),
      side: 'sideways',
    })
    insertRaw(path, 'book', T0 + 4_000, {
      type: 'book',
      snapshot: true,
      bids: [],
      asks: [],
    })
    const summary = make(path, AFTER_CLOSE)
    summary.runOnce()
    const [row] = rows(path)
    expect(row).toMatchObject({
      trade_count: null,
      depth_bid: null,
      events_seen: 4,
    })
    summary.stop()
  })
})

describe('ETH minute summary: closing rule and idempotency (S4)', () => {
  it('writes only closed minutes: not the open one, nor one inside the margin', () => {
    const { path, store } = fresh()
    store.append(ticker('PF_ETHUSD', T0 + 1_000, '99.9', '100.1'))
    store.append(ticker('PF_ETHUSD', T0 + MIN + 1_000, '99.9', '100.1'))
    // Open minute.
    let summary = make(path, T0 + 30_000)
    expect(summary.runOnce().written).toBe(0)
    summary.stop()
    // Ended, but still inside the margin.
    summary = make(path, T0 + MIN + DEFAULT_CLOSE_MARGIN_MS - 1)
    expect(summary.runOnce().written).toBe(0)
    expect(rows(path)).toHaveLength(0)
    summary.stop()
    // Margin elapsed: minute 0 is written; minute 1 is still open.
    summary = make(path, T0 + MIN + DEFAULT_CLOSE_MARGIN_MS)
    expect(summary.runOnce().written).toBe(1)
    expect(rows(path).map((r) => r.minute_start_ms)).toEqual([T0])
    summary.stop()
  })

  it('does not duplicate or rewrite minutes on repeated runs or after a restart', () => {
    const { path, store } = fresh()
    store.append(ticker('PF_ETHUSD', T0 + 1_000, '99.9', '100.1'))
    const first = make(path, AFTER_CLOSE)
    expect(first.runOnce().written).toBe(1)
    expect(first.runOnce().written).toBe(0)
    first.stop()
    const before = rows(path)
    // A restart a bit later: a new instance, same database.
    const second = make(path, AFTER_CLOSE + 10 * MIN)
    expect(second.runOnce().written).toBe(0)
    second.stop()
    expect(rows(path)).toEqual(before)
  })

  it('catches up the minutes missed while stopped, in bounded steps, skipping empty minutes', () => {
    const { path, store } = fresh()
    for (const minute of [0, 1, 4, 5])
      store.append(ticker('PF_ETHUSD', T0 + minute * MIN + 1_000, '99', '101'))
    const summary = make(path, T0 + 10 * MIN, 2)
    expect(summary.runOnce()).toEqual({ written: 2, pending: true })
    expect(summary.runOnce()).toEqual({ written: 0, pending: true })
    expect(summary.runOnce()).toEqual({ written: 2, pending: true })
    expect(summary.runOnce()).toEqual({ written: 0, pending: true })
    expect(summary.runOnce()).toEqual({ written: 0, pending: false })
    expect(
      rows(path).map((r) => (Number(r.minute_start_ms) - T0) / MIN),
    ).toEqual([0, 1, 4, 5])
    summary.stop()
  })

  it('skips the run while canRun says no, and writes once it says yes', () => {
    const { path, store } = fresh()
    store.append(ticker('PF_ETHUSD', T0 + 1_000, '99.9', '100.1'))
    let allowed = false
    const summary = createEthMinuteSummary({
      dbPath: path,
      clock: () => AFTER_CLOSE,
      canRun: () => allowed,
    })
    expect(summary.runOnce()).toEqual({ written: 0, pending: false })
    expect(rows(path)).toHaveLength(0)
    allowed = true
    expect(summary.runOnce().written).toBe(1)
    summary.stop()
  })

  it('does nothing while there are no ETH events and starts once they appear', () => {
    const { path, store } = fresh()
    const summary = make(path, AFTER_CLOSE)
    expect(summary.runOnce()).toEqual({ written: 0, pending: false })
    store.append(ticker('PF_ETHUSD', T0 + 1_000, '99.9', '100.1'))
    expect(summary.runOnce().written).toBe(1)
    summary.stop()
  })
})

describe('ETH minute summary: scope (S4)', () => {
  it('summarizes PF_ETHUSD only', () => {
    const { path, store } = fresh()
    store.append(ticker('PF_ETHUSD', T0 + 1_000, '99.9', '100.1'))
    store.append(ticker('PF_XBTUSD', T0 + 2_000, '50000', '50010'))
    store.append(ticker('PF_SOLUSD', T0 + 3_000, '20', '20.1'))
    insertRaw(
      path,
      'trade',
      T0 + 4_000,
      trade('buy', '9', '50000'),
      'PF_XBTUSD',
    )
    // A minute with only BTC events gets no row at all.
    store.append(ticker('PF_XBTUSD', T0 + MIN + 1_000, '50000', '50010'))
    const summary = make(path, T0 + 3 * MIN)
    summary.runOnce()
    const stored = rows(path)
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({
      product_id: 'PF_ETHUSD',
      events_seen: 1,
      trade_count: null,
    })
    summary.stop()
  })

  it('leaves every existing table, row and trigger of the capture database untouched', () => {
    const { path, store } = fresh()
    store.append(ticker('PF_ETHUSD', T0 + 1_000, '99.9', '100.1'))
    store.append(ticker('PF_XBTUSD', T0 + 2_000, '50000', '50010'))
    const snapshot = () => {
      const db = new DatabaseSync(path, { readOnly: true })
      const master = db
        .prepare(
          `SELECT type,name,sql FROM sqlite_master WHERE name<>? ORDER BY name`,
        )
        .all(SUMMARY_TABLE)
      const events = db
        .prepare(
          `SELECT event_id,content_hash,normalized_json FROM paper_futures_market_events ORDER BY rowid`,
        )
        .all()
      db.close()
      return { master, events }
    }
    const before = snapshot()
    const summary = make(path, AFTER_CLOSE)
    summary.runOnce()
    summary.stop()
    expect(snapshot()).toEqual(before)
    // Market evidence is still immutable.
    const db = new DatabaseSync(path)
    expect(() => db.exec('DELETE FROM paper_futures_market_events')).toThrow(
      /immutable/,
    )
    db.close()
  })

  it('does not stop the capture store from appending and reopening the database', () => {
    const { path, store } = fresh()
    store.append(ticker('PF_ETHUSD', T0 + 1_000, '99.9', '100.1'))
    const summary = make(path, AFTER_CLOSE)
    summary.runOnce()
    expect(
      store.append(ticker('PF_ETHUSD', T0 + 2 * MIN, '99.9', '100.1')),
    ).toBe('inserted')
    summary.stop()
    const reopened = new FuturesMarketStore(path)
    expect(
      reopened.append(ticker('PF_ETHUSD', T0 + 3 * MIN, '99.9', '100.1')),
    ).toBe('inserted')
  })
})
