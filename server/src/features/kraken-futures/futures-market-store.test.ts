import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { canonicalJson } from '../paper-futures/futures-canonical.ts'
import { FuturesMarketStore } from './futures-market-store.ts'
import { parseHistoricalFundingResponse } from './historical-funding.ts'

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

  it('treats an event another writer committed mid-append as a duplicate', () => {
    const path = dbPath()
    const first = new FuturesMarketStore(path)
    const second = new FuturesMarketStore(path)
    // The second process checked for the uid before the first one committed.
    const prepared = (
      second as unknown as { prepared: (sql: string) => unknown }
    ).prepared.bind(second)
    ;(second as unknown as { prepared: (sql: string) => unknown }).prepared = (
      sql: string,
    ) =>
      /SELECT content_hash FROM paper_futures_market_events\s+WHERE (feed|event_id)=\?(?! OR)/.test(
        sql,
      )
        ? { get: () => undefined }
        : prepared(sql)
    expect(first.append(event)).toBe('inserted')
    expect(second.append(event)).toBe('duplicate')
    expect(first.eventCount()).toBe(1)
    first.close()
    second.close()
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
    expect(store.schemaVersion()).toBe(5)
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

  it('no longer writes the redundant ticker snapshot table', () => {
    const path = dbPath()
    const store = new FuturesMarketStore(path)
    store.append({
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
    })
    const rows = store.eventCount()
    store.close()
    const check = new DatabaseSync(path)
    expect(rows).toBeGreaterThan(0)
    expect(
      check
        .prepare('SELECT COUNT(*) AS count FROM paper_futures_ticker_snapshots')
        .get(),
    ).toEqual({ count: 0 })
    check.close()
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
  const BTC = 'PF_XBTUSD'
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
    productId = 'PF_XBTUSD',
  ) => {
    const rawResponse = JSON.stringify({ productId, receivedAtMs, candles })
    return {
      productId,
      intervalMs,
      fromMs: T,
      toMs: receivedAtMs,
      receivedAtMs,
      rawResponse,
      sha256: createHash('sha256').update(rawResponse, 'utf8').digest('hex'),
      candles,
    }
  }

  /** Rewrites the official tables of a fresh file into their schema-4 shape (no product_id). */
  function downgradeToSchema4(
    path: string,
    responses: ReadonlyArray<ReturnType<typeof response>>,
  ): void {
    const raw = new DatabaseSync(path)
    raw.exec(`
      DROP TABLE paper_futures_official_candles;
      DROP TABLE paper_futures_official_candle_responses;
      DELETE FROM paper_futures_market_migrations WHERE version=5;
      CREATE TABLE paper_futures_official_candle_responses(
        sha256 TEXT PRIMARY KEY, interval_ms INTEGER NOT NULL, from_ms INTEGER NOT NULL,
        to_ms INTEGER NOT NULL, received_at INTEGER NOT NULL, raw_response TEXT NOT NULL
      ) STRICT;
      CREATE TABLE paper_futures_official_candles(
        interval_ms INTEGER NOT NULL, bucket_start INTEGER NOT NULL, revision_hash TEXT NOT NULL,
        known_at INTEGER NOT NULL, open_price TEXT NOT NULL, high_price TEXT NOT NULL,
        low_price TEXT NOT NULL, close_price TEXT NOT NULL, volume_btc TEXT NOT NULL,
        response_sha256 TEXT NOT NULL REFERENCES paper_futures_official_candle_responses(sha256),
        PRIMARY KEY(interval_ms, bucket_start, revision_hash)
      ) STRICT;
      CREATE TRIGGER paper_futures_official_candle_responses_no_update
        BEFORE UPDATE ON paper_futures_official_candle_responses BEGIN SELECT RAISE(ABORT, 'market evidence is immutable'); END;
      CREATE TRIGGER paper_futures_official_candle_responses_no_delete
        BEFORE DELETE ON paper_futures_official_candle_responses BEGIN SELECT RAISE(ABORT, 'market evidence is immutable'); END;
      CREATE TRIGGER paper_futures_official_candles_no_update
        BEFORE UPDATE ON paper_futures_official_candles BEGIN SELECT RAISE(ABORT, 'market evidence is immutable'); END;
      CREATE TRIGGER paper_futures_official_candles_no_delete
        BEFORE DELETE ON paper_futures_official_candles BEGIN SELECT RAISE(ABORT, 'market evidence is immutable'); END;
    `)
    let rowid = 100
    for (const item of responses) {
      raw
        .prepare(
          'INSERT OR IGNORE INTO paper_futures_official_candle_responses VALUES(?,?,?,?,?,?)',
        )
        .run(
          item.sha256,
          item.intervalMs,
          item.fromMs,
          item.toMs,
          item.receivedAtMs,
          item.rawResponse,
        )
      for (const candle of item.candles)
        raw
          .prepare(
            'INSERT OR IGNORE INTO paper_futures_official_candles(rowid, interval_ms, bucket_start, revision_hash, known_at, open_price, high_price, low_price, close_price, volume_btc, response_sha256) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
          )
          .run(
            // Gaps in the rowids, as a long-running capture leaves them.
            (rowid += 7),
            candle.intervalMs,
            candle.bucketStart,
            createHash('sha256').update(JSON.stringify(candle)).digest('hex'),
            item.receivedAtMs,
            candle.open,
            candle.high,
            candle.low,
            candle.close,
            candle.volumeBtc,
            item.sha256,
          )
    }
    raw.close()
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
    expect(store.latestOfficialBucket(BTC, M)).toBe(T + 2 * M)
    expect(store.latestOfficialBucket(BTC, 300_000)).toBeUndefined()

    expect(
      store
        .officialCandlesAsOf(BTC, M, T + 3 * M, 10)
        .map((row) => row.bucketStart),
    ).toEqual([T, T + M])
    const all = store.officialCandlesAsOf(BTC, M, T + 4 * M, 10)
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
      store
        .officialCandlesAsOf(BTC, M, T + 4 * M, 2)
        .map((row) => row.bucketStart),
    ).toEqual([T + M, T + 2 * M])
    store.close()
  })

  it('keeps a changed official candle as a new revision and reads the first known one', () => {
    const store = new FuturesMarketStore(dbPath())
    store.appendOfficialCandles(response(T + 2 * M, [official(T)]))
    store.appendOfficialCandles(
      response(T + 5 * M, [official(T, { volumeBtc: '1.6' })]),
    )
    const [row] = store.officialCandlesAsOf(BTC, M, T + 10 * M, 10)
    expect(row!.volumeBtc).toBe('1.5')
    expect(
      store.officialCandleQuality(BTC, M).officialRevisionConflicts,
    ).toEqual([T])
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

  it('tails first-known official candles by rowid', () => {
    const store = new FuturesMarketStore(dbPath())
    expect(store.maxOfficialRowid()).toBe(0)
    store.appendOfficialCandles(
      response(T + 3 * M, [official(T), official(T + M)]),
    )
    const cursor = store.maxOfficialRowid()
    expect(cursor).toBe(2)
    store.appendOfficialCandles(
      response(T + 4 * M, [
        official(T + M, { volumeBtc: '9' }), // changed revision of a known bucket
        official(T + 2 * M),
      ]),
    )
    const rows = store.officialCandlesAfter(BTC, cursor, M, 10)
    // The changed revision is not the first known one: only the new bucket.
    expect(rows.map((row) => row.candle.bucketStart)).toEqual([T + 2 * M])
    expect(rows[0]!.rowid).toBe(store.maxOfficialRowid())
    expect(
      store
        .officialCandlesAfter(BTC, 0, M, 10)
        .map((r) => r.candle.bucketStart),
    ).toEqual([T, T + M, T + 2 * M])
    expect(store.officialCandlesAfter(BTC, 0, 300_000, 10)).toEqual([])
    expect(() => store.officialCandlesAfter(BTC, 0, M, 0)).toThrow(RangeError)
    store.close()
  })

  it('reports no official rows on a schema-3 read-only store', () => {
    const path = dbPath()
    const writer = new FuturesMarketStore(path)
    writer.appendOfficialCandles(response(T + 3 * M, [official(T)]))
    writer.close()
    const raw = new DatabaseSync(path)
    raw.exec('DELETE FROM paper_futures_market_migrations WHERE version>=4')
    raw.close()
    const v3 = new FuturesMarketStore(path, { readOnly: true })
    expect(v3.maxOfficialRowid()).toBe(0)
    expect(v3.officialCandlesAfter(BTC, 0, M, 10)).toEqual([])
    v3.close()
  })

  it('opens schema 3, schema 4 and schema 5 databases read-only', () => {
    const path = dbPath()
    new FuturesMarketStore(path).close()
    const v5 = new FuturesMarketStore(path, { readOnly: true })
    expect(v5.schemaVersion()).toBe(5)
    v5.close()
    downgradeToSchema4(path, [])
    const v4 = new FuturesMarketStore(path, { readOnly: true })
    expect(v4.schemaVersion()).toBe(4)
    // The schema-4 official tables have no product column: nothing is served
    // until the writer migrates the file.
    expect(v4.maxOfficialRowid()).toBe(0)
    expect(v4.latestOfficialBucket(BTC, M)).toBeUndefined()
    expect(v4.officialCandlesAsOf(BTC, M, T, 10)).toEqual([])
    expect(v4.officialCandlesAfter(BTC, 0, M, 10)).toEqual([])
    v4.close()
    const raw = new DatabaseSync(path)
    raw.exec('DELETE FROM paper_futures_market_migrations WHERE version>=4')
    raw.close()
    const v3 = new FuturesMarketStore(path, { readOnly: true })
    expect(v3.schemaVersion()).toBe(3)
    expect(v3.officialCandlesAsOf(BTC, M, T, 10)).toEqual([])
    v3.close()
  })

  it('keeps products apart: same bucket and values, separate keys, lookups and cursors', () => {
    const store = new FuturesMarketStore(dbPath())
    const btc = response(T + 3 * M, [official(T), official(T + M)])
    const eth = response(
      T + 3 * M,
      [official(T), official(T + M)],
      M,
      'PF_ETHUSD',
    )
    expect(store.appendOfficialCandles(btc)).toEqual({ inserted: 2 })
    // Identical values and bucket under another product are not a duplicate.
    expect(store.appendOfficialCandles(eth)).toEqual({ inserted: 2 })
    expect(store.appendOfficialCandles(eth)).toEqual({ inserted: 0 })
    store.appendOfficialCandles(
      response(T + 4 * M, [official(T + 2 * M)], M, 'PF_ETHUSD'),
    )
    expect(store.latestOfficialBucket(BTC, M)).toBe(T + M)
    expect(store.latestOfficialBucket('PF_ETHUSD', M)).toBe(T + 2 * M)
    expect(store.latestOfficialBucket('PF_SOLUSD', M)).toBeUndefined()
    expect(
      store
        .officialCandlesAsOf('PF_ETHUSD', M, T + 9 * M, 10)
        .map((row) => row.bucketStart),
    ).toEqual([T, T + M, T + 2 * M])
    expect(
      store
        .officialCandlesAsOf(BTC, M, T + 9 * M, 10)
        .map((row) => row.bucketStart),
    ).toEqual([T, T + M])
    const ethRows = store.officialCandlesAfter('PF_ETHUSD', 0, M, 10)
    expect(ethRows).toHaveLength(3)
    expect(store.officialCandlesAfter(BTC, 0, M, 10)).toHaveLength(2)
    // Cursors are global rowids: each product sees only its own rows after one.
    expect(
      store
        .officialCandlesAfter(BTC, 1, M, 10)
        .map((row) => row.candle.bucketStart),
    ).toEqual([T + M])
    expect(
      store
        .officialCandlesAfter('PF_ETHUSD', 4, M, 10)
        .map((row) => row.candle.bucketStart),
    ).toEqual([T + 2 * M])
    expect(ethRows.map((row) => row.rowid)).toEqual([3, 4, 5])
    expect(store.maxOfficialRowid()).toBe(5)
    store.close()
  })

  it('rejects an official response for an invalid product or one of another product than its candles', () => {
    const store = new FuturesMarketStore(dbPath())
    expect(() =>
      store.appendOfficialCandles({
        ...response(T + 2 * M, [official(T)]),
        productId: 'pf_xbtusd',
      }),
    ).toThrow(/product/i)
    store.close()
  })

  it('refuses quality reports for a product with no observed candles', () => {
    const store = new FuturesMarketStore(dbPath())
    expect(() => store.officialCandleQuality('PF_ETHUSD', M)).toThrow(
      /PF_XBTUSD/,
    )
    store.close()
  })

  describe('migration 5 (product_id)', () => {
    const rowSet = (path: string, table: string) => {
      const raw = new DatabaseSync(path)
      const rows = raw
        .prepare(`SELECT rowid AS id, * FROM ${table} ORDER BY rowid`)
        .all()
      raw.close()
      return rows as Record<string, unknown>[]
    }

    it('rebuilds a schema-4 file: rows, rowids, hashes and links are kept, rows become PF_XBTUSD', () => {
      const path = dbPath()
      const seed = new FuturesMarketStore(path)
      seed.close()
      const first = response(T + 3 * M, [official(T), official(T + M)])
      const second = response(T + 4 * M, [
        official(T + M, { volumeBtc: '1.6' }),
        official(T + 2 * M),
      ])
      downgradeToSchema4(path, [first, second])
      const before = {
        candles: rowSet(path, 'paper_futures_official_candles'),
        responses: rowSet(path, 'paper_futures_official_candle_responses'),
      }
      expect(before.candles).toHaveLength(4)

      const store = new FuturesMarketStore(path)
      expect(store.schemaVersion()).toBe(5)
      store.close()

      const after = {
        candles: rowSet(path, 'paper_futures_official_candles'),
        responses: rowSet(path, 'paper_futures_official_candle_responses'),
      }
      const strip = (rows: Record<string, unknown>[]) =>
        rows.map(({ product_id: product, ...rest }) => {
          expect(product).toBe('PF_XBTUSD')
          return rest
        })
      // Same rowids (the gateway cursors on them), same content, same order.
      expect(strip(after.candles)).toEqual(before.candles)
      expect(strip(after.responses)).toEqual(before.responses)

      const raw = new DatabaseSync(path)
      expect(raw.prepare('PRAGMA foreign_key_check').all()).toEqual([])
      const keys = raw
        .prepare(
          "SELECT name FROM pragma_table_info('paper_futures_official_candles') WHERE pk>0 ORDER BY pk",
        )
        .all()
        .map((row) => (row as { name: string }).name)
      expect(keys).toEqual([
        'product_id',
        'interval_ms',
        'bucket_start',
        'revision_hash',
      ])
      const refs = raw
        .prepare(
          'SELECT "table" AS parent FROM pragma_foreign_key_list(\'paper_futures_official_candles\')',
        )
        .all()
        .map((row) => (row as { parent: string }).parent)
      expect(refs).toEqual([
        'paper_futures_official_candle_responses',
        'paper_futures_official_candle_responses',
      ])
      // Append-only triggers are back on the rebuilt tables.
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

      // The migrated file serves the old data as PF_XBTUSD and takes new products.
      const again = new FuturesMarketStore(path)
      expect(again.schemaVersion()).toBe(5)
      expect(
        again
          .officialCandlesAsOf(BTC, M, T + 9 * M, 10)
          .map((row) => row.bucketStart),
      ).toEqual([T, T + M, T + 2 * M])
      expect(
        again.officialCandlesAsOf(BTC, M, T + 9 * M, 10)[1]!.volumeBtc,
      ).toBe('1.5')
      expect(again.latestOfficialBucket('PF_ETHUSD', M)).toBeUndefined()
      expect(
        again.appendOfficialCandles(
          response(T + 3 * M, [official(T)], M, 'PF_ETHUSD'),
        ),
      ).toEqual({ inserted: 1 })
      again.close()
    })

    it('is a no-op on an already migrated file', () => {
      const path = dbPath()
      const store = new FuturesMarketStore(path)
      store.appendOfficialCandles(response(T + 3 * M, [official(T)]))
      store.close()
      const before = rowSet(path, 'paper_futures_official_candles')
      new FuturesMarketStore(path).close()
      new FuturesMarketStore(path).close()
      expect(rowSet(path, 'paper_futures_official_candles')).toEqual(before)
      const raw = new DatabaseSync(path)
      expect(
        raw
          .prepare(
            'SELECT COUNT(*) AS n FROM paper_futures_market_migrations WHERE version=5',
          )
          .get(),
      ).toEqual({ n: 1 })
      raw.close()
    })

    it('migrates an empty schema-4 file', () => {
      const path = dbPath()
      new FuturesMarketStore(path).close()
      downgradeToSchema4(path, [])
      const store = new FuturesMarketStore(path)
      expect(store.schemaVersion()).toBe(5)
      expect(store.maxOfficialRowid()).toBe(0)
      store.close()
    })
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
    expect(store.officialCandleQuality(BTC, M, T)).toEqual({
      intervalMs: M,
      sinceBucketStart: T,
      compared: 3,
      matched: 1,
      closeMismatches: [T + 2 * M],
      volumeMismatches: [T + M],
      observedMissing: [T + 3 * M],
      officialRevisionConflicts: [],
    })
    expect(store.officialCandleQuality(BTC, M, T + M).compared).toBe(2)
    store.close()
  })
})

describe('funding evidence dedupe', () => {
  const HOUR = 3_600_000
  const T0 = Date.parse('2026-10-05T00:00:00.000Z')
  const response = (
    periods: ReadonlyArray<readonly [number, string]>,
    receivedAt: number,
  ) =>
    parseHistoricalFundingResponse(
      JSON.stringify({
        result: 'success',
        serverTime: new Date(receivedAt).toISOString(),
        rates: periods.map(([hour, rate]) => ({
          timestamp: new Date(T0 + hour * HOUR).toISOString(),
          fundingRate: Number(rate),
          relativeFundingRate: 0.0001,
        })),
      }),
      receivedAt,
    )
  const counts = (path: string) => {
    const db = new DatabaseSync(path, { readOnly: true })
    const row = (table: string) =>
      Number(
        (
          db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
            n: number
          }
        ).n,
      )
    const result = {
      responses: row('paper_futures_funding_responses'),
      periods: row('paper_futures_funding_periods'),
    }
    db.close()
    return result
  }

  it('stores nothing for a repeated response and only the new periods otherwise', () => {
    const path = dbPath()
    const store = new FuturesMarketStore(path)
    const base = [
      [0, '0.1'],
      [1, '0.2'],
      [2, '0.3'],
    ] as const
    expect(
      store.appendNewFundingKnowledge(response(base, T0 + 3 * HOUR + 1_000)),
    ).toEqual({ stored: true, newPeriods: 3 })
    expect(counts(path)).toEqual({ responses: 1, periods: 3 })

    // Same periods re-fetched later: different bytes (serverTime), no news.
    expect(
      store.appendNewFundingKnowledge(response(base, T0 + 3 * HOUR + 301_000)),
    ).toEqual({ stored: false, newPeriods: 0 })
    expect(counts(path)).toEqual({ responses: 1, periods: 3 })

    // One new period: exactly one new row, first-known rows are untouched.
    expect(
      store.appendNewFundingKnowledge(
        response([...base, [3, '0.4']], T0 + 4 * HOUR + 1_000),
      ),
    ).toEqual({ stored: true, newPeriods: 1 })
    expect(counts(path)).toEqual({ responses: 2, periods: 4 })
    const known = store.fundingRecordsAsOf(Number.MAX_SAFE_INTEGER)
    expect(known.map((r) => [r.startMs, r.knownAtMs])).toEqual([
      [T0, T0 + 3 * HOUR + 1_000],
      [T0 + HOUR, T0 + 3 * HOUR + 1_000],
      [T0 + 2 * HOUR, T0 + 3 * HOUR + 1_000],
      [T0 + 3 * HOUR, T0 + 4 * HOUR + 1_000],
    ])
    store.close()
  })

  it('keeps a changed rate for a known period as new, conflicting evidence', () => {
    const path = dbPath()
    const store = new FuturesMarketStore(path)
    store.appendNewFundingKnowledge(response([[0, '0.1']], T0 + HOUR + 1_000))
    expect(
      store.appendNewFundingKnowledge(
        response([[0, '0.5']], T0 + HOUR + 9_000),
      ),
    ).toEqual({ stored: true, newPeriods: 1 })
    expect(counts(path)).toEqual({ responses: 2, periods: 2 })
    expect(store.fundingForInterval(T0 + 10, T0 + 2 * HOUR)).toHaveLength(2)
    store.close()
  })

  it('leaves appendFundingResponse (legacy single-process path) unchanged', () => {
    const path = dbPath()
    const store = new FuturesMarketStore(path)
    const base = [
      [0, '0.1'],
      [1, '0.2'],
    ] as const
    store.appendFundingResponse(response(base, T0 + 2 * HOUR + 1_000))
    store.appendFundingResponse(response(base, T0 + 2 * HOUR + 301_000))
    expect(counts(path)).toEqual({ responses: 2, periods: 4 })
    store.close()
  })
})
