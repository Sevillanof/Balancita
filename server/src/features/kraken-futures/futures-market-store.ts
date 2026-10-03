import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { canonicalJson } from '../paper-futures/futures-canonical.ts'

type RecordValue = Record<string, unknown>
type StoredRow = { normalized_json: string; received_sequence: number }

function withReceivedSequence(row: StoredRow): unknown {
  return {
    ...JSON.parse(row.normalized_json),
    receivedSequence: Number(row.received_sequence),
  }
}

function asRecord(value: unknown): RecordValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TypeError('Market event must be an object.')
  return value as RecordValue
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')
}

function time(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new TypeError(`${name} must be a non-negative safe integer.`)
  return value
}

/** Append-only public futures evidence store; callers must supply an isolated path. */
export class FuturesMarketStore {
  private readonly db: DatabaseSync

  constructor(path: string) {
    if (!path || path === ':memory:') {
      if (path !== ':memory:')
        throw new TypeError('An explicit database path is required.')
    } else {
      mkdirSync(dirname(path), { recursive: true })
    }
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;')
    if (path !== ':memory:') this.db.exec('PRAGMA journal_mode=WAL;')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS paper_futures_market_migrations (
        version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL
      ) STRICT;
      INSERT OR IGNORE INTO paper_futures_market_migrations VALUES(1, unixepoch('subsec') * 1000);
      CREATE TABLE IF NOT EXISTS paper_futures_instrument_versions (
        metadata_hash TEXT PRIMARY KEY, instrument_id TEXT NOT NULL, retrieved_at INTEGER NOT NULL,
        payload_json TEXT NOT NULL, raw_json TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS paper_futures_market_events (
        event_id TEXT PRIMARY KEY, feed TEXT NOT NULL, product_id TEXT NOT NULL,
        epoch INTEGER NOT NULL, seq INTEGER NOT NULL, event_time INTEGER NOT NULL,
        received_at INTEGER NOT NULL, persisted_at INTEGER NOT NULL, uid TEXT,
        raw_json TEXT NOT NULL, normalized_json TEXT NOT NULL, content_hash TEXT NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS paper_futures_market_trade_uid
        ON paper_futures_market_events(feed, product_id, uid) WHERE uid IS NOT NULL;
      CREATE INDEX IF NOT EXISTS paper_futures_market_received
        ON paper_futures_market_events(product_id, received_at, seq);
      CREATE TABLE IF NOT EXISTS paper_futures_book_snapshots (
        event_id TEXT PRIMARY KEY REFERENCES paper_futures_market_events(event_id),
        product_id TEXT NOT NULL, epoch INTEGER NOT NULL, seq INTEGER NOT NULL,
        event_time INTEGER NOT NULL, received_at INTEGER NOT NULL, bids_json TEXT NOT NULL, asks_json TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS paper_futures_ticker_snapshots (
        event_id TEXT PRIMARY KEY REFERENCES paper_futures_market_events(event_id),
        product_id TEXT NOT NULL, epoch INTEGER NOT NULL, seq INTEGER NOT NULL,
        event_time INTEGER NOT NULL, received_at INTEGER NOT NULL, payload_json TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS paper_futures_data_gaps (
        gap_id TEXT PRIMARY KEY, feed TEXT NOT NULL, product_id TEXT NOT NULL,
        epoch INTEGER NOT NULL, expected_seq INTEGER, actual_seq INTEGER,
        detected_at INTEGER NOT NULL, reason TEXT NOT NULL, policy_version TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS paper_futures_candle_revisions (
        candle_id TEXT NOT NULL, interval_ms INTEGER NOT NULL, bucket_start INTEGER NOT NULL,
        revision INTEGER NOT NULL, known_at INTEGER NOT NULL, close_at INTEGER,
        is_closed INTEGER NOT NULL, coverage TEXT NOT NULL, open_price TEXT NOT NULL,
        high_price TEXT NOT NULL, low_price TEXT NOT NULL, close_price TEXT NOT NULL,
        volume_btc TEXT NOT NULL, trade_count INTEGER NOT NULL, source_hash TEXT NOT NULL,
        PRIMARY KEY(candle_id, revision)
      ) STRICT;
      INSERT OR IGNORE INTO paper_futures_market_migrations VALUES(2, unixepoch('subsec') * 1000);
      CREATE TABLE IF NOT EXISTS paper_futures_market_quality_policies (
        policy_version TEXT PRIMARY KEY, recorded_at INTEGER NOT NULL,
        payload_json TEXT NOT NULL
      ) STRICT;
      INSERT OR IGNORE INTO paper_futures_market_migrations VALUES(3, unixepoch('subsec') * 1000);
      CREATE TRIGGER IF NOT EXISTS paper_futures_market_quality_policies_no_update
        BEFORE UPDATE ON paper_futures_market_quality_policies BEGIN SELECT RAISE(ABORT, 'market evidence is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS paper_futures_market_quality_policies_no_delete
        BEFORE DELETE ON paper_futures_market_quality_policies BEGIN SELECT RAISE(ABORT, 'market evidence is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS paper_futures_market_events_no_update
        BEFORE UPDATE ON paper_futures_market_events BEGIN SELECT RAISE(ABORT, 'market evidence is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS paper_futures_market_events_no_delete
        BEFORE DELETE ON paper_futures_market_events BEGIN SELECT RAISE(ABORT, 'market evidence is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS paper_futures_instrument_versions_no_update
        BEFORE UPDATE ON paper_futures_instrument_versions BEGIN SELECT RAISE(ABORT, 'market evidence is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS paper_futures_instrument_versions_no_delete
        BEFORE DELETE ON paper_futures_instrument_versions BEGIN SELECT RAISE(ABORT, 'market evidence is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS paper_futures_book_snapshots_no_update
        BEFORE UPDATE ON paper_futures_book_snapshots BEGIN SELECT RAISE(ABORT, 'market evidence is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS paper_futures_book_snapshots_no_delete
        BEFORE DELETE ON paper_futures_book_snapshots BEGIN SELECT RAISE(ABORT, 'market evidence is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS paper_futures_ticker_snapshots_no_update
        BEFORE UPDATE ON paper_futures_ticker_snapshots BEGIN SELECT RAISE(ABORT, 'market evidence is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS paper_futures_ticker_snapshots_no_delete
        BEFORE DELETE ON paper_futures_ticker_snapshots BEGIN SELECT RAISE(ABORT, 'market evidence is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS paper_futures_data_gaps_no_update
        BEFORE UPDATE ON paper_futures_data_gaps BEGIN SELECT RAISE(ABORT, 'market evidence is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS paper_futures_data_gaps_no_delete
        BEFORE DELETE ON paper_futures_data_gaps BEGIN SELECT RAISE(ABORT, 'market evidence is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS paper_futures_candle_revisions_no_update
        BEFORE UPDATE ON paper_futures_candle_revisions BEGIN SELECT RAISE(ABORT, 'market evidence is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS paper_futures_candle_revisions_no_delete
        BEFORE DELETE ON paper_futures_candle_revisions BEGIN SELECT RAISE(ABORT, 'market evidence is immutable'); END;
    `)
  }

  close(): void {
    this.db.close()
  }

  schemaVersion(): number {
    const row = this.db
      .prepare(
        'SELECT MAX(version) AS version FROM paper_futures_market_migrations',
      )
      .get() as { version: number | null }
    return row.version ?? 0
  }

  saveInstrument(spec: unknown, rawCatalog: unknown): void {
    const instrument = asRecord(spec)
    const metadataHash = String(instrument.metadataHash ?? '')
    if (!/^[a-f0-9]{64}$/.test(metadataHash))
      throw new TypeError('Instrument metadata hash is invalid.')
    const retrievedAt = time(instrument.retrievedAt, 'retrievedAt')
    this.db
      .prepare(
        `INSERT OR IGNORE INTO paper_futures_instrument_versions
      (metadata_hash,instrument_id,retrieved_at,payload_json,raw_json) VALUES(?,?,?,?,?)`,
      )
      .run(
        metadataHash,
        String(instrument.instrumentId),
        retrievedAt,
        canonicalJson(spec),
        canonicalJson(rawCatalog),
      )
  }

  saveQualityPolicy(policy: unknown, recordedAt: number): void {
    const value = asRecord(policy)
    const version = String(value.version ?? '')
    if (!/^[a-z0-9.-]{1,80}$/.test(version))
      throw new TypeError('Market quality policy version is invalid.')
    const payloadJson = canonicalJson(policy)
    const existing = this.db
      .prepare(
        'SELECT payload_json FROM paper_futures_market_quality_policies WHERE policy_version=?',
      )
      .get(version) as { payload_json: string } | undefined
    if (existing && existing.payload_json !== payloadJson)
      throw new Error('Market quality policy version payload conflict.')
    this.db
      .prepare(
        `INSERT OR IGNORE INTO paper_futures_market_quality_policies
        (policy_version,recorded_at,payload_json) VALUES(?,?,?)`,
      )
      .run(version, time(recordedAt, 'recordedAt'), payloadJson)
  }

  qualityPolicies(): unknown[] {
    return this.db
      .prepare(
        `SELECT policy_version AS version,recorded_at AS recordedAt,payload_json AS payloadJson
        FROM paper_futures_market_quality_policies ORDER BY policy_version`,
      )
      .all() as unknown[]
  }

  append(value: unknown): 'inserted' | 'duplicate' {
    const event = asRecord(value)
    const feed = event.type
    if (feed !== 'trade' && feed !== 'book' && feed !== 'ticker')
      throw new TypeError('Unknown futures market feed.')
    const product = event.productId
    if (product !== 'PF_XBTUSD')
      throw new TypeError('Unexpected futures product.')
    const epoch = time(event.epoch, 'epoch')
    const seq = time(event.seq, 'seq')
    const eventTime = time(event.eventTime, 'eventTime')
    const receivedAt = time(event.receivedAt, 'receivedAt')
    const persistedAt = time(event.persistedAt, 'persistedAt')
    const uid = feed === 'trade' ? String(event.uid ?? '') : null
    if (feed === 'trade' && (!uid || uid.length > 128))
      throw new TypeError('Trade UID is required.')
    const normalizedEvent = Object.fromEntries(
      Object.entries(event).filter(([, value]) => value !== undefined),
    )
    delete normalizedEvent.receivedSequence
    const content =
      feed === 'trade'
        ? {
            uid,
            eventTime,
            side: event.side,
            tradeType: event.tradeType,
            quantityBtc: event.quantityBtc,
            priceUsd: event.priceUsd,
          }
        : normalizedEvent
    const contentHash = digest(feed === 'trade' ? content : normalizedEvent)
    if (uid !== null) {
      const existing = this.db
        .prepare(
          `SELECT content_hash FROM paper_futures_market_events
        WHERE feed=? AND product_id=? AND uid=?`,
        )
        .get(feed, product, uid) as { content_hash: string } | undefined
      if (existing) {
        if (existing.content_hash !== contentHash)
          throw new Error('Trade UID payload conflict.')
        return 'duplicate'
      }
    }
    const eventId =
      uid === null
        ? `${feed}:${product}:${epoch}:${seq}:${contentHash}`
        : `${feed}:${product}:${uid}`
    const existingEvent = this.db
      .prepare(
        'SELECT content_hash FROM paper_futures_market_events WHERE event_id=?',
      )
      .get(eventId) as { content_hash: string } | undefined
    if (existingEvent) {
      if (existingEvent.content_hash !== contentHash)
        throw new Error('Market event identity payload conflict.')
      return 'duplicate'
    }
    const rawJson =
      typeof event.rawJson === 'string'
        ? event.rawJson
        : canonicalJson(event.raw)
    if (Buffer.byteLength(rawJson, 'utf8') > 256_000)
      throw new RangeError(
        'Raw market evidence exceeds the configured size bound.',
      )
    const normalizedJson = canonicalJson(normalizedEvent)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db
        .prepare(
          `INSERT INTO paper_futures_market_events
        (event_id,feed,product_id,epoch,seq,event_time,received_at,persisted_at,uid,raw_json,normalized_json,content_hash)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          eventId,
          feed,
          product,
          epoch,
          seq,
          eventTime,
          receivedAt,
          persistedAt,
          uid,
          rawJson,
          normalizedJson,
          contentHash,
        )
      if (feed === 'book' && event.snapshot === true) {
        this.db
          .prepare(
            `INSERT INTO paper_futures_book_snapshots
          (event_id,product_id,epoch,seq,event_time,received_at,bids_json,asks_json) VALUES(?,?,?,?,?,?,?,?)`,
          )
          .run(
            eventId,
            product,
            epoch,
            seq,
            eventTime,
            receivedAt,
            canonicalJson(event.bids),
            canonicalJson(event.asks),
          )
      }
      if (feed === 'ticker') {
        this.db
          .prepare(
            `INSERT INTO paper_futures_ticker_snapshots
          (event_id,product_id,epoch,seq,event_time,received_at,payload_json) VALUES(?,?,?,?,?,?,?)`,
          )
          .run(
            eventId,
            product,
            epoch,
            seq,
            eventTime,
            receivedAt,
            normalizedJson,
          )
      }
      this.db.exec('COMMIT')
      return 'inserted'
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  appendGap(gap: {
    feed: string
    productId: string
    epoch: number
    expectedSeq?: number
    actualSeq: number
    detectedAt: number
    reason: string
    policyVersion: string
  }): void {
    const id = digest(gap)
    this.db
      .prepare(
        `INSERT OR IGNORE INTO paper_futures_data_gaps
      (gap_id,feed,product_id,epoch,expected_seq,actual_seq,detected_at,reason,policy_version)
      VALUES(?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        gap.feed,
        gap.productId,
        time(gap.epoch, 'epoch'),
        gap.expectedSeq ?? null,
        time(gap.actualSeq, 'actualSeq'),
        time(gap.detectedAt, 'detectedAt'),
        gap.reason,
        gap.policyVersion,
      )
  }

  saveCandleRevision(candle: {
    id: string
    intervalMs: number
    bucketStart: number
    revision: number
    knownAt: number
    closeAt?: number
    isClosed: boolean
    coverage: string
    open: string
    high: string
    low: string
    close: string
    volumeBtc: string
    tradeCount: number
    sourceHash: string
  }): void {
    this.db
      .prepare(
        `INSERT INTO paper_futures_candle_revisions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        candle.id,
        candle.intervalMs,
        candle.bucketStart,
        candle.revision,
        candle.knownAt,
        candle.closeAt ?? null,
        candle.isClosed ? 1 : 0,
        candle.coverage,
        candle.open,
        candle.high,
        candle.low,
        candle.close,
        candle.volumeBtc,
        candle.tradeCount,
        candle.sourceHash,
      )
  }

  eventsAsOf(receivedCutoff: number): unknown[] {
    time(receivedCutoff, 'receivedCutoff')
    return (
      this.db
        .prepare(
          `SELECT normalized_json,rowid AS received_sequence FROM paper_futures_market_events
      WHERE received_at<=? ORDER BY rowid`,
        )
        .all(receivedCutoff) as StoredRow[]
    ).map(withReceivedSequence)
  }

  eventCount(): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS count FROM paper_futures_market_events')
      .get() as { count: number }
    return Number(row.count)
  }

  candleRevisions(): unknown[] {
    return this.db
      .prepare(
        `SELECT * FROM paper_futures_candle_revisions
      ORDER BY interval_ms,bucket_start,revision`,
      )
      .all() as unknown[]
  }

  candlesAsOf(knownAtCutoff: number): unknown[] {
    time(knownAtCutoff, 'knownAtCutoff')
    return this.db
      .prepare(
        `SELECT * FROM paper_futures_candle_revisions
         WHERE known_at<=? AND close_at<=? AND is_closed=1
           AND revision=(
             SELECT MAX(latest.revision)
             FROM paper_futures_candle_revisions AS latest
             WHERE latest.candle_id=paper_futures_candle_revisions.candle_id
               AND latest.known_at<=? AND latest.close_at<=? AND latest.is_closed=1
           )
         ORDER BY interval_ms,bucket_start,candle_id`,
      )
      .all(
        knownAtCutoff,
        knownAtCutoff,
        knownAtCutoff,
        knownAtCutoff,
      ) as unknown[]
  }

  gapsAsOf(detectedAtCutoff: number): unknown[] {
    time(detectedAtCutoff, 'detectedAtCutoff')
    return this.db
      .prepare(
        `SELECT * FROM paper_futures_data_gaps WHERE detected_at<=?
         ORDER BY detected_at,rowid`,
      )
      .all(detectedAtCutoff) as unknown[]
  }

  exportJsonl(): string {
    const rows = this.db
      .prepare(
        `SELECT normalized_json,rowid AS received_sequence FROM paper_futures_market_events
      ORDER BY rowid`,
      )
      .all() as StoredRow[]
    return (
      rows.map((row) => canonicalJson(withReceivedSequence(row))).join('\n') +
      (rows.length ? '\n' : '')
    )
  }
}
