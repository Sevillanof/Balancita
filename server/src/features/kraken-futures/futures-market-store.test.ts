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
  it('stores public catalog decimals as raw JSON without canonicalizing them as hashes', () => {
    const store = new FuturesMarketStore(dbPath())
    const rawCatalog = {
      instruments: [{ symbol: 'PF_XBTUSD', impactMidSize: 0.08 }],
    }
    store.saveInstrument(
      {
        instrumentId: 'kraken-futures:PF_XBTUSD',
        metadataHash: 'a'.repeat(64),
        retrievedAt: 1000,
      },
      rawCatalog,
    )
    const row = store.instrumentVersions()[0] as { raw_json: string }
    expect(JSON.parse(row.raw_json)).toEqual(rawCatalog)
    store.close()
  })

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

  it('reports indexed gap knowledge with the existing detected-time cutoff', () => {
    const store = new FuturesMarketStore(dbPath())
    store.appendGap({
      feed: 'book',
      productId: 'PF_XBTUSD',
      epoch: 1,
      expectedSeq: 2,
      actualSeq: 3,
      detectedAt: 1015,
      reason: 'sequence_gap',
      policyVersion: 'snapshot-contiguous-observed.v1',
    })

    expect(store.gapStatusAsOf(1014)).toEqual({
      knownAtMs: 1014,
      gapFree: true,
    })
    expect(store.gapStatusAsOf(1015)).toEqual({
      knownAtMs: 1015,
      gapFree: false,
    })
    expect(store.gapsAsOf(1014)).toEqual([])
    expect(store.gapsAsOf(1015)).toHaveLength(1)
    store.close()
  })

  it('counts pending durable events by watermark and received-time cutoff', () => {
    const store = new FuturesMarketStore(dbPath())
    store.append(event)
    store.append({ ...event, seq: 2, uid: 'trade-2', receivedAt: 2020 })
    store.append({ ...event, seq: 3, uid: 'trade-3', receivedAt: 3030 })

    expect(store.pendingEventsAfterAsOf(1, 2020)).toEqual({
      count: 1,
      firstSequence: 2,
      lastSequence: 2,
    })
    expect(store.pendingEventsAfterAsOf(1, 3030)).toEqual({
      count: 2,
      firstSequence: 2,
      lastSequence: 3,
    })
    store.close()
  })

  it('measures pending source lag against its durable receipt watermark', () => {
    const store = new FuturesMarketStore(dbPath())
    store.append({ ...event, receivedAt: 10 })
    store.append({ ...event, seq: 2, uid: 'lag-2', receivedAt: 20 })
    store.append({ ...event, seq: 3, uid: 'lag-3', receivedAt: 30 })
    store.append({ ...event, seq: 4, uid: 'lag-4', receivedAt: 40 })

    expect(store.pendingSourceProgressAsOf(1, 30, 3)).toMatchObject({
      pendingCount: 2,
      firstPendingSequence: 2,
      oldestPendingReceivedAt: 20,
      watermarkSequence: 3,
      watermarkReceivedAt: 30,
      sourcePendingLagMs: 10,
      sourcePendingLagUnavailableReason: null,
      clockDomain: 'source_received_time',
    })
    expect(store.pendingSourceProgressAsOf(2, 30, 3)).toMatchObject({
      pendingCount: 1,
      sourcePendingLagMs: 0,
    })
    expect(store.pendingSourceProgressAsOf(3, 30, 3)).toMatchObject({
      pendingCount: 0,
      firstPendingSequence: null,
      sourcePendingLagMs: null,
      sourcePendingLagUnavailableReason: 'no_pending_source_rows',
    })
    store.close()
  })

  it('does not report comparable lag across backwards source receipt clocks', () => {
    const store = new FuturesMarketStore(dbPath())
    store.append({ ...event, receivedAt: 10 })
    store.append({ ...event, seq: 2, uid: 'reverse-2', receivedAt: 30 })
    store.append({ ...event, seq: 3, uid: 'reverse-3', receivedAt: 20 })

    expect(store.pendingSourceProgressAsOf(1, 30, 3)).toMatchObject({
      pendingCount: 2,
      sourcePendingLagMs: null,
      sourcePendingLagUnavailableReason: 'non_monotonic_source_received_time',
    })
    store.close()
  })

  it('selects only closed candle revisions known by the cutoff', () => {
    const store = new FuturesMarketStore(dbPath())
    const revision = (revision: number, knownAt: number, isClosed: boolean) =>
      store.saveCandleRevision({
        id: 'PF_XBTUSD:60000:0',
        intervalMs: 60_000,
        bucketStart: 0,
        revision,
        knownAt,
        closeAt: 60_000,
        isClosed,
        coverage: 'observed_trades_only_no_gap_certification',
        open: '100',
        high: '101',
        low: '99',
        close: '100',
        volumeBtc: '1',
        tradeCount: 1,
        sourceHash: 'a'.repeat(64),
      })
    revision(1, 60_000, false)
    revision(2, 60_001, true)
    revision(3, 60_002, true)
    expect(store.candlesAsOf(60_000)).toEqual([])
    expect(
      (store.candlesAsOf(60_001)[0] as { revision: number }).revision,
    ).toBe(2)
    expect(
      (store.candlesAsOf(60_002)[0] as { revision: number }).revision,
    ).toBe(3)
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

  it('persists an immutable versioned paper-quality policy without relabeling events', () => {
    const path = dbPath()
    const store = new FuturesMarketStore(path)
    store.append(event)
    const policy = {
      version: 'snapshot-contiguous-observed.v1',
      sourceGuarantee: 'undocumented',
      eligibility: 'paper_only',
    }
    store.saveQualityPolicy(policy, 2000)
    expect(store.qualityPolicies()).toHaveLength(1)
    expect(store.eventsAsOf(1010)).toHaveLength(1)
    store.close()
    const raw = new DatabaseSync(path)
    expect(() =>
      raw
        .prepare(
          'UPDATE paper_futures_market_quality_policies SET recorded_at=3',
        )
        .run(),
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
    expect(store.schemaVersion()).toBe(3)
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
