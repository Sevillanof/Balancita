import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { FuturesMarketStore } from './futures-market-store.ts'

const dirs: string[] = []
function dbPath(): string {
  const path = mkdtempSync(join(tmpdir(), 'balancita-market-'))
  dirs.push(path)
  return join(path, 'fixture.sqlite')
}
afterEach(() => {
  for (const path of dirs.splice(0))
    rmSync(path, { recursive: true, force: true })
})

const event = {
  type: 'trade',
  productId: 'PF_XBTUSD',
  seq: 1,
  eventTime: 1000,
  receivedAt: 1010,
  persistedAt: 1020,
  epoch: 1,
  uid: 'trade-1',
  side: 'buy',
  tradeType: 'fill',
  quantityBtc: '0.01',
  priceUsd: '90000',
  recovered: false,
  raw: { price: '90000', qty: '0.01' },
}

describe('FuturesMarketStore', () => {
  it('deduplicates trades across epochs and rejects changed UID payloads', () => {
    const store = new FuturesMarketStore(dbPath())
    expect(store.append(event)).toBe('inserted')
    expect(
      store.append({ ...event, seq: 88, epoch: 2, receivedAt: 1030 }),
    ).toBe('duplicate')
    expect(() =>
      store.append({ ...event, priceUsd: '90001', epoch: 2 }),
    ).toThrow(/UID.*conflict/i)
    expect(store.eventCount()).toBe(1)
    store.close()
  })

  it('reopens durable events and filters knowledge by received-time cutoff', () => {
    const path = dbPath()
    let store = new FuturesMarketStore(path)
    store.append(event)
    store.close()
    store = new FuturesMarketStore(path)
    expect(store.eventsAsOf(1009)).toEqual([])
    expect(store.eventsAsOf(1010)).toHaveLength(1)
    expect(store.exportJsonl()).toContain('trade-1')
    store.close()
  })

  it('preserves persisted global receipt order across feed-local sequence values and duplicates', () => {
    const path = dbPath()
    const book = {
      type: 'book',
      productId: 'PF_XBTUSD',
      seq: 100,
      eventTime: 1000,
      receivedAt: 1010,
      persistedAt: 1020,
      epoch: 1,
      snapshot: true,
      bids: [{ price: '89999', quantity: '1' }],
      asks: [{ price: '90001', quantity: '1' }],
      raw: { feed: 'book_snapshot' },
    }
    const trade = { ...event, seq: 5, receivedAt: 1010 }
    let store = new FuturesMarketStore(path)
    expect(store.append(book)).toBe('inserted')
    expect(store.append(trade)).toBe('inserted')
    const exported = store
      .exportJsonl()
      .trim()
      .split('\n')
      .map(
        (line) =>
          JSON.parse(line) as {
            type: string
            seq: number
            receivedSequence: number
          },
      )
    expect(
      exported.map((item) => [item.type, item.seq, item.receivedSequence]),
    ).toEqual([
      ['book', 100, 1],
      ['trade', 5, 2],
    ])
    expect(
      store
        .eventsAsOf(1010)
        .map(
          (item) => (item as { type: string; receivedSequence: number }).type,
        ),
    ).toEqual(['book', 'trade'])
    expect(store.eventsAsOf(1009)).toEqual([])
    store.close()
    store = new FuturesMarketStore(path)
    expect(store.append(book)).toBe('duplicate')
    expect(store.exportJsonl().trim().split('\n')).toEqual(
      exported.map((item) => JSON.stringify(item)),
    )
    store.close()
  })

  it('guards durable market evidence against update and delete', () => {
    const path = dbPath()
    const store = new FuturesMarketStore(path)
    store.append(event)
    store.close()
    const raw = new DatabaseSync(path)
    expect(() =>
      raw.prepare('UPDATE paper_futures_market_events SET seq=9').run(),
    ).toThrow(/immutable/i)
    expect(() =>
      raw.prepare('DELETE FROM paper_futures_market_events').run(),
    ).toThrow(/immutable/i)
    raw.close()
  })

  it('uses namespaced additive schema without changing legacy fixture tables or migration version', () => {
    const path = dbPath()
    const fixture = new DatabaseSync(path)
    fixture.exec(`CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY);
      INSERT INTO schema_migrations VALUES(7);
      CREATE TABLE market_observations(id TEXT PRIMARY KEY,payload TEXT);
      INSERT INTO market_observations VALUES('spot-fixture','untouched');`)
    fixture.close()
    const store = new FuturesMarketStore(path)
    expect(store.schemaVersion()).toBe(2)
    store.append(event)
    store.close()
    const reopened = new DatabaseSync(path)
    expect(
      (
        reopened
          .prepare('SELECT MAX(version) AS version FROM schema_migrations')
          .get() as { version: number }
      ).version,
    ).toBe(7)
    expect(
      reopened.prepare('SELECT id,payload FROM market_observations').get(),
    ).toEqual({ id: 'spot-fixture', payload: 'untouched' })
    reopened.close()
  })
})
