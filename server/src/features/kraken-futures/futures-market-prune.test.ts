import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { FuturesMarketStore } from './futures-market-store.ts'
import { pruneMarketEvents } from './futures-market-prune.ts'
import { acquireWriterLock } from '../../platform/writer-lock.ts'

const DAY = 86_400_000
const NOW = 100 * DAY
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

function trade(uid: string, receivedAt: number, seq: number) {
  return {
    type: 'trade',
    productId: 'PF_XBTUSD',
    seq,
    eventTime: receivedAt - 5,
    receivedAt,
    persistedAt: receivedAt + 5,
    epoch: 1,
    uid,
    side: 'buy',
    tradeType: 'fill',
    quantityBtc: '0.01',
    priceUsd: '90000',
    recovered: false,
    raw: { price: '90000' },
  }
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'balancita-prune-'))
  dirs.push(dir)
  const path = join(dir, 'market.sqlite')
  const store = new FuturesMarketStore(path)
  store.append(trade('old', NOW - 8 * DAY, 1))
  store.append(trade('edge', NOW - 6 * DAY, 2))
  store.append(trade('new', NOW - 1000, 3))
  store.close()
  return path
}

describe('pruneMarketEvents', () => {
  it('removes only events older than the retention and restores the immutability guard', () => {
    const path = setup()
    const result = pruneMarketEvents(path, { days: 7, now: NOW })
    expect(result.events).toBe(1)
    const db = new DatabaseSync(path)
    const uids = db
      .prepare('SELECT uid FROM paper_futures_market_events ORDER BY rowid')
      .all()
      .map((row) => (row as { uid: string }).uid)
    expect(uids).toEqual(['edge', 'new'])
    expect(() => db.exec('DELETE FROM paper_futures_market_events')).toThrow(
      /immutable/,
    )
    db.close()
  })

  it('refuses to run while capture holds the writer lock', () => {
    const path = setup()
    const lock = acquireWriterLock(path)
    try {
      expect(() => pruneMarketEvents(path, { days: 7, now: NOW })).toThrow()
    } finally {
      lock.release()
    }
  })

  it('rejects a retention below one day', () => {
    expect(() => pruneMarketEvents('/nonexistent', { days: 0 })).toThrow(
      RangeError,
    )
  })
})

describe('trimRawEvents', () => {
  function ticker(seq: number, receivedAt: number) {
    return {
      type: 'ticker',
      productId: 'PF_XBTUSD',
      seq,
      eventTime: receivedAt - 5,
      receivedAt,
      persistedAt: receivedAt + 5,
      epoch: 1,
      bid: '1',
      ask: '2',
      mark: '1.5',
      raw: { bid_size: '1' },
    }
  }

  it('drops old tickers and old trades, compacts middle-aged trades and keeps the guard', () => {
    const dir = mkdtempSync(join(tmpdir(), 'balancita-trim-'))
    dirs.push(dir)
    const store = new FuturesMarketStore(join(dir, 'market.sqlite'))
    const H = 3_600_000
    store.append(trade('t-old', NOW - 8 * DAY, 1))
    store.append(trade('t-mid', NOW - 2 * DAY, 2))
    store.append(ticker(4, NOW - 2 * DAY + 5))
    store.append(trade('t-new', NOW - H, 3))
    store.append(ticker(5, NOW - H + 5))
    const result = store.trimRawEvents({
      now: NOW,
      tickerRetentionMs: 24 * H,
      eventRetentionMs: 7 * DAY,
      rawKeepMs: 24 * H,
    })
    expect(result.done).toBe(true)
    expect(result.deleted).toBe(2)
    expect(result.slimmed).toBe(1)
    store.close()
    const db = new DatabaseSync(join(dir, 'market.sqlite'))
    const rows = db
      .prepare(
        "SELECT uid, feed, raw_json, json_type(normalized_json, '$.raw') AS has FROM paper_futures_market_events ORDER BY rowid",
      )
      .all() as {
      uid: string | null
      feed: string
      raw_json: string
      has: string | null
    }[]
    expect(rows.map((row) => row.uid ?? row.feed)).toEqual([
      't-mid',
      't-new',
      'ticker',
    ])
    expect(rows[0]?.has).toBeNull()
    expect(rows[0]?.raw_json).not.toBe('')
    expect(() => db.exec('DELETE FROM paper_futures_market_events')).toThrow(
      /immutable/,
    )
    expect(() =>
      db.exec(`UPDATE paper_futures_market_events SET feed='x'`),
    ).toThrow(/immutable/)
    db.close()
  })
})
