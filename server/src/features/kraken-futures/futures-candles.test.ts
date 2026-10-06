import { describe, expect, it } from 'vitest'
import type { TradeEvent } from './futures-market.ts'
import { FuturesCandleBuilder } from './futures-candles.ts'
import { FuturesMarketStore } from './futures-market-store.ts'

function trade(
  uid: string,
  eventTime: number,
  priceUsd: string,
  quantityBtc: string,
  seq: number,
): TradeEvent {
  return {
    type: 'trade',
    productId: 'PF_XBTUSD',
    epoch: 1,
    seq,
    eventTime,
    receivedAt: eventTime + 5,
    persistedAt: eventTime + 5,
    uid,
    side: 'buy',
    tradeType: 'fill',
    quantityBtc,
    priceUsd,
    recovered: false,
    raw: {},
    rawJson: '{}',
  }
}

type Row = {
  candle_id: string
  revision: number
  is_closed: number
  open_price: string
  high_price: string
  low_price: string
  close_price: string
  volume_btc: string
  trade_count: number
  source_hash: string
}
const rows = (store: FuturesMarketStore) => store.candleRevisions() as Row[]

describe('FuturesCandleBuilder restart over an existing market database', () => {
  const intervals = [60_000, 300_000]

  it('continues an open candle after a restart instead of colliding on revision 1', () => {
    const store = new FuturesMarketStore(':memory:')
    const first = new FuturesCandleBuilder(store, intervals)
    const t1 = trade('a', 60_000, '100', '1', 1)
    const t2 = trade('b', 70_000, '105', '0.5', 2)
    for (const t of [t1, t2]) {
      store.append(t)
      first.addTrade(t, t.receivedAt)
    }
    // Capture process restarts: a fresh builder over the same database.
    const second = new FuturesCandleBuilder(store, intervals)
    const t3 = trade('c', 80_000, '95', '0.25', 3)
    store.append(t3)
    expect(() => second.addTrade(t3, t3.receivedAt)).not.toThrow()
    const latest = rows(store)
      .filter((row) => row.candle_id === 'PF_XBTUSD:60000:60000')
      .at(-1)!
    expect(latest.revision).toBe(3)
    expect(latest.open_price).toBe('100')
    expect(latest.high_price).toBe('105')
    expect(latest.low_price).toBe('95')
    expect(latest.close_price).toBe('95')
    expect(latest.volume_btc).toBe('1.75')
    expect(latest.trade_count).toBe(3)
    expect(latest.source_hash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('closes a candle left open by the previous process once its bucket ends', () => {
    const store = new FuturesMarketStore(':memory:')
    const first = new FuturesCandleBuilder(store, intervals)
    const t1 = trade('a', 60_000, '100', '1', 1)
    store.append(t1)
    first.addTrade(t1, t1.receivedAt)
    const second = new FuturesCandleBuilder(store, intervals)
    second.restoreOpenCandles(130_000)
    second.advanceClock(130_000)
    const minute = rows(store).filter(
      (row) => row.candle_id === 'PF_XBTUSD:60000:60000',
    )
    expect(minute.map((row) => [row.revision, row.is_closed])).toEqual([
      [1, 0],
      [2, 1],
    ])
    // The 5 minute bucket is still open and stays untouched.
    const five = rows(store).filter(
      (row) => row.candle_id === 'PF_XBTUSD:300000:0',
    )
    expect(five.map((row) => row.is_closed)).toEqual([0])
    // Restoring again never re-closes or duplicates an already closed candle.
    const third = new FuturesCandleBuilder(store, intervals)
    third.restoreOpenCandles(130_000)
    third.advanceClock(130_000)
    expect(
      rows(store).filter((row) => row.candle_id === 'PF_XBTUSD:60000:60000'),
    ).toHaveLength(2)
  })

  it('never collides with a second writer that advanced the same candle', () => {
    const store = new FuturesMarketStore(':memory:')
    const stale = new FuturesCandleBuilder(store, intervals)
    const t1 = trade('a', 60_000, '100', '1', 1)
    store.append(t1)
    stale.addTrade(t1, t1.receivedAt)
    // Another capture process resumes the same candle and moves it on.
    const other = new FuturesCandleBuilder(store, intervals)
    const t2 = trade('b', 70_000, '105', '0.5', 2)
    store.append(t2)
    other.addTrade(t2, t2.receivedAt)
    // The stale process still holds revision 1 in memory.
    const t3 = trade('c', 80_000, '95', '0.25', 3)
    store.append(t3)
    expect(() => stale.addTrade(t3, t3.receivedAt)).not.toThrow()
    const minute = rows(store).filter(
      (row) => row.candle_id === 'PF_XBTUSD:60000:60000',
    )
    expect(minute.map((row) => row.revision)).toEqual([1, 2, 3])
    expect(minute.at(-1)!.trade_count).toBe(3)
    expect(minute.at(-1)!.volume_btc).toBe('1.75')
    expect(minute.at(-1)!.low_price).toBe('95')
  })

  it('never collides when the clock closes a candle another writer already moved on', () => {
    const store = new FuturesMarketStore(':memory:')
    const stale = new FuturesCandleBuilder(store, intervals)
    const t1 = trade('a', 60_000, '100', '1', 1)
    store.append(t1)
    stale.addTrade(t1, t1.receivedAt)
    const other = new FuturesCandleBuilder(store, intervals)
    const t2 = trade('b', 70_000, '105', '0.5', 2)
    store.append(t2)
    other.addTrade(t2, t2.receivedAt)
    expect(() => stale.advanceClock(130_000)).not.toThrow()
    // The other writer closes it too: the candle ends up closed exactly once.
    expect(() => other.advanceClock(130_000)).not.toThrow()
    const minute = rows(store).filter(
      (row) => row.candle_id === 'PF_XBTUSD:60000:60000',
    )
    expect(minute.map((row) => [row.revision, row.is_closed])).toEqual([
      [1, 0],
      [2, 0],
      [3, 1],
    ])
    expect(minute.at(-1)!.trade_count).toBe(2)
  })

  it('forgets a candle whose revision write failed and resumes it from the store', () => {
    const store = new FuturesMarketStore(':memory:')
    let fail = true
    const flaky = {
      saveCandleRevision: (
        ...args: Parameters<FuturesMarketStore['saveCandleRevision']>
      ) => {
        if (fail) throw new Error('disk hiccup')
        store.saveCandleRevision(...args)
      },
      candleHeadById: (id: string) => store.candleHeadById(id),
    }
    const builder = new FuturesCandleBuilder(flaky, [60_000])
    const t1 = trade('a', 60_000, '100', '1', 1)
    expect(() => builder.addTrade(t1, t1.receivedAt)).toThrow('disk hiccup')
    fail = false
    const t2 = trade('b', 70_000, '105', '0.5', 2)
    builder.addTrade(t2, t2.receivedAt)
    expect(rows(store).map((row) => [row.revision, row.trade_count])).toEqual([
      [1, 1],
    ])
  })
})
