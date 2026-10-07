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
