import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { canonicalJson } from '../paper-futures/futures-canonical.ts'
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

  it('keeps candle revisions append-only (no UPDATE or DELETE)', () => {
    const path = dbPath()
    const store = new FuturesMarketStore(path)
    store.saveCandleRevision({
      id: 'PF_XBTUSD:60000:0',
      intervalMs: 60_000,
      bucketStart: 0,
      revision: 1,
      knownAt: 60_001,
      closeAt: 60_000,
      isClosed: true,
      coverage: 'observed_trades_only_no_gap_certification',
      open: '100',
      high: '101',
      low: '99',
      close: '100',
      volumeBtc: '1',
      tradeCount: 1,
      sourceHash: 'a'.repeat(64),
    })
    store.close()
    const raw = new DatabaseSync(path)
    expect(() =>
      raw
        .prepare("UPDATE paper_futures_candle_revisions SET close_price='1'")
        .run(),
    ).toThrow(/immutable/i)
    expect(() =>
      raw.prepare('DELETE FROM paper_futures_candle_revisions').run(),
    ).toThrow(/immutable/i)
    raw.close()
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

  it('uses WAL with synchronous NORMAL while keeping one transaction per event', () => {
    const store = new FuturesMarketStore(dbPath())
    expect(store.synchronousLevel()).toBe(1)
    store.append(event)
    store.append({ ...event, seq: 2, uid: 'trade-2' })
    expect(store.eventCount()).toBe(2)
    store.close()
  })

  it('returns the latest closed 60s revisions, bounded and ascending', () => {
    const store = new FuturesMarketStore(dbPath())
    const save = (
      bucket: number,
      revision: number,
      isClosed: boolean,
      intervalMs = 60_000,
      close = '100',
    ) =>
      store.saveCandleRevision({
        id: `PF_XBTUSD:${intervalMs}:${bucket}`,
        intervalMs,
        bucketStart: bucket,
        revision,
        knownAt: bucket + intervalMs + revision,
        closeAt: bucket + intervalMs,
        isClosed,
        coverage: 'observed_trades_only_no_gap_certification',
        open: '100',
        high: '101',
        low: '99',
        close,
        volumeBtc: '1',
        tradeCount: 1,
        sourceHash: 'a'.repeat(64),
      })
    for (let index = 0; index < 505; index += 1) save(index * 60_000, 1, true)
    save(505 * 60_000, 1, false)
    save(10 * 60_000, 2, true, 60_000, '777')
    save(0, 1, true, 300_000)
    const tail = store.closedCandlesTail(60_000, 500) as {
      bucket_start: number
      close_price: string
      revision: number
      is_closed: number
    }[]
    expect(tail).toHaveLength(500)
    expect(tail[0]!.bucket_start).toBe(5 * 60_000)
    expect(tail.at(-1)!.bucket_start).toBe(504 * 60_000)
    expect(tail.every((row) => row.is_closed === 1)).toBe(true)
    const sorted = tail.map((row) => row.bucket_start)
    expect(sorted).toEqual([...sorted].sort((a, b) => a - b))
    const small = store.closedCandlesTail(60_000, 3) as typeof tail
    expect(small.map((row) => row.bucket_start)).toEqual([
      502 * 60_000,
      503 * 60_000,
      504 * 60_000,
    ])
    const revised = store.closedCandlesTail(60_000, 500) as typeof tail
    expect(
      revised.find((row) => row.bucket_start === 10 * 60_000),
    ).toMatchObject({ revision: 2, close_price: '777' })
    expect(() => store.closedCandlesTail(60_000, 501)).toThrow(RangeError)
    store.close()
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
    expect(store.schemaVersion()).toBe(4)
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

describe('FuturesMarketStore append hot path', () => {
  const base = {
    type: 'book',
    productId: 'PF_XBTUSD',
    epoch: 1,
    eventTime: 1000,
    receivedAt: 1010,
    persistedAt: 1010,
    snapshot: false,
    side: 'bid',
    price: '99.5',
    quantity: '2',
    marketQuality: { policy_version: 'p', book_valid: true },
  }

  it('reuses prepared statements instead of re-preparing per event', () => {
    const store = new FuturesMarketStore(':memory:')
    const prepare = vi.spyOn(DatabaseSync.prototype, 'prepare')
    try {
      store.append({ ...base, seq: 1, rawJson: '{"a":1}' })
      const afterFirst = prepare.mock.calls.length
      for (let seq = 2; seq <= 60; seq += 1)
        store.append({ ...base, seq, rawJson: `{"a":${seq}}` })
      expect(prepare.mock.calls.length).toBe(afterFirst)
    } finally {
      prepare.mockRestore()
    }
  })

  it('stores canonical JSON and content hashes identical to canonicalJson', () => {
    const path = dbPath()
    const store = new FuturesMarketStore(path)
    const events: Array<Record<string, unknown>> = [
      {
        ...base,
        seq: 1,
        rawJson: '{}',
        // non-ASCII, astral and surrogate-ordering keys, nested arrays
        extra: {
          é: 1,
          '\u{1F600}': 2,
          '～': 3,
          z: [{ b: 1, a: 'x' }],
          Z: null,
        },
        optional: undefined,
      },
      {
        type: 'ticker',
        productId: 'PF_XBTUSD',
        epoch: 1,
        seq: 2,
        eventTime: 1000,
        receivedAt: 1011,
        persistedAt: 1011,
        last: '100',
        suspended: false,
        funding: { status: 'unknown' },
        rawJson: '{}',
      },
      {
        ...base,
        seq: 3,
        snapshot: true,
        bids: [{ price: '99', quantity: '1' }],
        asks: [{ price: '101', quantity: '2' }],
        rawJson: '{}',
      },
      { ...event, rawJson: '{}' },
    ]
    for (const item of events) store.append(item)
    store.close()
    const db = new DatabaseSync(path, { readOnly: true })
    const rows = db
      .prepare(
        'SELECT feed,normalized_json,content_hash,event_id,raw_json FROM paper_futures_market_events ORDER BY rowid',
      )
      .all() as Array<Record<string, string>>
    db.close()
    expect(rows).toHaveLength(events.length)
    events.forEach((item, index) => {
      const normalized = Object.fromEntries(
        Object.entries(item).filter(([, value]) => value !== undefined),
      )
      const expected = canonicalJson(normalized)
      expect(rows[index]!.normalized_json).toBe(expected)
      const hashed =
        item.type === 'trade'
          ? canonicalJson({
              uid: item.uid,
              eventTime: item.eventTime,
              side: item.side,
              tradeType: item.tradeType,
              quantityBtc: item.quantityBtc,
              priceUsd: item.priceUsd,
            })
          : expected
      expect(rows[index]!.content_hash).toBe(
        createHash('sha256').update(hashed, 'utf8').digest('hex'),
      )
    })
  })

  it('rejects unpaired surrogates in keys and values like canonicalJson', () => {
    const store = new FuturesMarketStore(':memory:')
    expect(() =>
      store.append({ ...base, seq: 1, rawJson: '{}', '\uD800': 1 }),
    ).toThrow(/surrogate/)
    expect(() =>
      store.append({ ...base, seq: 2, rawJson: '{}', note: 'a\uDC00' }),
    ).toThrow(/surrogate/)
  })
})

describe('FuturesMarketStore official candles', () => {
  const M = 60_000
  const T = 1_791_281_220_000
  const official = (
    bucketStart: number,
    values: Partial<
      Record<'open' | 'high' | 'low' | 'close' | 'volumeBtc', string>
    > = {},
    intervalMs = M,
  ) => ({
    intervalMs,
    bucketStart,
    open: '100',
    high: '102',
    low: '99',
    close: '101',
    volumeBtc: '1.5',
    ...values,
  })
  const response = (
    receivedAtMs: number,
    candles: ReturnType<typeof official>[],
    intervalMs = M,
  ) => {
    const rawResponse = JSON.stringify({ receivedAtMs, candles })
    return {
      intervalMs,
      fromMs: T,
      toMs: receivedAtMs,
      receivedAtMs,
      rawResponse,
      sha256: createHash('sha256').update(rawResponse, 'utf8').digest('hex'),
      candles,
    }
  }

  it('appends official candles idempotently and reads them as of a knowledge cutoff', () => {
    const store = new FuturesMarketStore(dbPath())
    const first = response(T + 3 * M, [official(T), official(T + M)])
    expect(store.appendOfficialCandles(first)).toEqual({ inserted: 2 })
    expect(store.appendOfficialCandles(first)).toEqual({ inserted: 0 })
    // A later response repeats a known candle and adds the next one.
    expect(
      store.appendOfficialCandles(
        response(T + 4 * M, [
          official(T + M),
          official(T + 2 * M, { close: '100' }),
        ]),
      ),
    ).toEqual({ inserted: 1 })
    expect(store.latestOfficialBucket(M)).toBe(T + 2 * M)
    expect(store.latestOfficialBucket(300_000)).toBeUndefined()

    expect(
      store.officialCandlesAsOf(M, T + 3 * M, 10).map((row) => row.bucketStart),
    ).toEqual([T, T + M])
    const all = store.officialCandlesAsOf(M, T + 4 * M, 10)
    expect(all.map((row) => row.bucketStart)).toEqual([T, T + M, T + 2 * M])
    expect(all[0]).toEqual({
      intervalMs: M,
      bucketStart: T,
      closeAt: T + M,
      knownAt: T + 3 * M,
      open: '100',
      high: '102',
      low: '99',
      close: '101',
      volumeBtc: '1.5',
      responseSha256: first.sha256,
      revisionHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    })
    expect(
      store.officialCandlesAsOf(M, T + 4 * M, 2).map((row) => row.bucketStart),
    ).toEqual([T + M, T + 2 * M])
    store.close()
  })

  it('keeps a changed official candle as a new revision and reads the first known one', () => {
    const store = new FuturesMarketStore(dbPath())
    store.appendOfficialCandles(response(T + 2 * M, [official(T)]))
    store.appendOfficialCandles(
      response(T + 5 * M, [official(T, { volumeBtc: '1.6' })]),
    )
    const [row] = store.officialCandlesAsOf(M, T + 10 * M, 10)
    expect(row!.volumeBtc).toBe('1.5')
    expect(store.officialCandleQuality(M).officialRevisionConflicts).toEqual([
      T,
    ])
    store.close()
  })

  it('rejects a response whose hash does not match its raw body', () => {
    const store = new FuturesMarketStore(dbPath())
    expect(() =>
      store.appendOfficialCandles({
        ...response(T + 2 * M, [official(T)]),
        sha256: 'f'.repeat(64),
      }),
    ).toThrow(/hash/)
    store.close()
  })

  it('guards official candle evidence against update and delete', () => {
    const path = dbPath()
    const store = new FuturesMarketStore(path)
    store.appendOfficialCandles(response(T + 2 * M, [official(T)]))
    store.close()
    const raw = new DatabaseSync(path)
    for (const [table, column] of [
      ['paper_futures_official_candles', 'known_at'],
      ['paper_futures_official_candle_responses', 'received_at'],
    ]) {
      expect(() => raw.prepare(`DELETE FROM ${table}`).run()).toThrow(
        /immutable/i,
      )
      expect(() =>
        raw.prepare(`UPDATE ${table} SET ${column}=0`).run(),
      ).toThrow(/immutable/i)
    }
    raw.close()
  })

  it('opens schema 3 and schema 4 databases read-only', () => {
    const path = dbPath()
    new FuturesMarketStore(path).close()
    const v4 = new FuturesMarketStore(path, { readOnly: true })
    expect(v4.schemaVersion()).toBe(4)
    v4.close()
    const raw = new DatabaseSync(path)
    raw.exec('DELETE FROM paper_futures_market_migrations WHERE version=4')
    raw.close()
    const v3 = new FuturesMarketStore(path, { readOnly: true })
    expect(v3.schemaVersion()).toBe(3)
    expect(v3.officialCandlesAsOf(M, T, 10)).toEqual([])
    v3.close()
  })

  it('compares closed observed 60s candles with official close and volume', () => {
    const store = new FuturesMarketStore(dbPath())
    const observed = (
      bucketStart: number,
      close: string,
      volumeBtc: string,
      revision = 2,
    ) =>
      store.saveCandleRevision({
        id: `PF_XBTUSD:60000:${bucketStart}`,
        intervalMs: M,
        bucketStart,
        revision,
        knownAt: bucketStart + M + 1,
        closeAt: bucketStart + M,
        isClosed: true,
        coverage: 'observed_trades_only_no_gap_certification',
        open: '100',
        high: '102',
        low: '99',
        close,
        volumeBtc,
        tradeCount: 3,
        sourceHash: 'a'.repeat(64),
      })
    observed(T, '101', '1.5') // match
    observed(T + M, '101', '1.4992') // missed trades
    observed(T + 2 * M, '100', '1.5') // close differs
    // T + 3M: official only (observed missing)
    observed(T + 5 * M, '101', '1.5') // observed only: not compared
    store.appendOfficialCandles(
      response(T + 5 * M, [
        official(T),
        official(T + M),
        official(T + 2 * M),
        official(T + 3 * M, { volumeBtc: '0' }),
      ]),
    )
    expect(store.officialCandleQuality(M, T)).toEqual({
      intervalMs: M,
      sinceBucketStart: T,
      compared: 3,
      matched: 1,
      closeMismatches: [T + 2 * M],
      volumeMismatches: [T + M],
      observedMissing: [T + 3 * M],
      officialRevisionConflicts: [],
    })
    expect(store.officialCandleQuality(M, T + M).compared).toBe(2)
    store.close()
  })
})
