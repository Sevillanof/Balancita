import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import type { HistoricalFundingResponse } from './historical-funding.ts'
import type { OfficialCandleResponse } from './official-candles.ts'
import { existsSync, mkdirSync } from 'node:fs'
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

/** Latest stored state of a candle, used to resume it after a restart. */
export interface StoredCandleHead {
  readonly id: string
  readonly intervalMs: number
  readonly bucketStart: number
  readonly revision: number
  readonly knownAt: number
  readonly closed: boolean
  readonly open: string
  readonly high: string
  readonly low: string
  readonly close: string
  readonly volumeBtc: string
  readonly tradeCount: number
  readonly sourceHash: string
}

/** First-known revision of an official Kraken candle. */
export interface OfficialStoredCandle {
  readonly intervalMs: number
  readonly bucketStart: number
  readonly closeAt: number
  readonly knownAt: number
  readonly open: string
  readonly high: string
  readonly low: string
  readonly close: string
  readonly volumeBtc: string
  readonly responseSha256: string
  readonly revisionHash: string
}

export interface OfficialCandleQuality {
  readonly intervalMs: number
  readonly sinceBucketStart: number
  compared: number
  matched: number
  readonly closeMismatches: number[]
  readonly volumeMismatches: number[]
  /** Official buckets with no closed observed candle (capture down or quiet). */
  readonly observedMissing: number[]
  /** Buckets whose official values changed between fetches. */
  readonly officialRevisionConflicts: number[]
}

function sameDecimal(left: string, right: string): boolean {
  const normal = (value: string) => {
    let text = value.replace(/^0+(?=\d)/, '')
    if (text.includes('.')) text = text.replace(/0+$/, '').replace(/\.$/, '')
    return text
  }
  return normal(left) === normal(right)
}

function candleHead(row: RecordValue): StoredCandleHead {
  return {
    id: String(row.candle_id),
    intervalMs: Number(row.interval_ms),
    bucketStart: Number(row.bucket_start),
    revision: Number(row.revision),
    knownAt: Number(row.known_at),
    closed: Number(row.is_closed) === 1,
    open: String(row.open_price),
    high: String(row.high_price),
    low: String(row.low_price),
    close: String(row.close_price),
    volumeBtc: String(row.volume_btc),
    tradeCount: Number(row.trade_count),
    sourceHash: String(row.source_hash),
  }
}

function digest(value: unknown): string {
  return sha256(canonicalJson(value))
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

const SURROGATE = /[\ud800-\udfff]/

function validateScalarText(text: string): void {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = text.charCodeAt(index + 1)
      if (!(low >= 0xdc00 && low <= 0xdfff))
        throw new TypeError('Unpaired Unicode surrogate.')
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError('Unpaired Unicode surrogate.')
    }
  }
}

function compareScalars(left: string, right: string): number {
  const a = Array.from(left, (character) => character.codePointAt(0)!)
  const b = Array.from(right, (character) => character.codePointAt(0)!)
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index]! - b[index]!
  }
  return a.length - b.length
}

/**
 * Output-identical to `canonicalJson` (RFC 8785-style code point key order,
 * same validation errors) but sorts keys without per-comparison allocation:
 * UTF-16 code unit order equals code point order unless a key has surrogates.
 * Equivalence is covered by the store tests; the shared helper stays the
 * contract for every other canonical consumer.
 */
function canonicalEvent(item: unknown): string {
  if (typeof item === 'string') {
    validateScalarText(item)
    return JSON.stringify(item)
  }
  if (item === null || typeof item === 'boolean') return JSON.stringify(item)
  if (typeof item === 'number') {
    if (!Number.isFinite(item) || !Number.isSafeInteger(item))
      throw new TypeError('Only safe integers are canonical numbers.')
    return String(item)
  }
  if (Array.isArray(item)) {
    let out = '['
    for (let index = 0; index < item.length; index += 1)
      out += (index === 0 ? '' : ',') + canonicalEvent(item[index])
    return `${out}]`
  }
  if (typeof item === 'object' && item !== null) {
    const record = item as Record<string, unknown>
    const keys = Object.keys(record)
    let surrogates = false
    for (const key of keys) {
      validateScalarText(key)
      if (!surrogates && SURROGATE.test(key)) surrogates = true
    }
    if (surrogates) keys.sort(compareScalars)
    else keys.sort()
    let out = '{'
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index]!
      if (record[key] === undefined)
        throw new TypeError('Undefined is not canonical.')
      out +=
        (index === 0 ? '' : ',') +
        `${JSON.stringify(key)}:${canonicalEvent(record[key])}`
    }
    return `${out}}`
  }
  throw new TypeError('Unsupported canonical value.')
}

function time(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new TypeError(`${name} must be a non-negative safe integer.`)
  return value
}

function officialRow(row: RecordValue): OfficialStoredCandle {
  return {
    intervalMs: Number(row.interval_ms),
    closeAt: Number(row.bucket_start) + Number(row.interval_ms),
    bucketStart: Number(row.bucket_start),
    knownAt: Number(row.known_at),
    open: String(row.open_price),
    high: String(row.high_price),
    low: String(row.low_price),
    close: String(row.close_price),
    volumeBtc: String(row.volume_btc),
    responseSha256: String(row.response_sha256),
    revisionHash: String(row.revision_hash),
  }
}

/** Append-only public futures evidence store; callers must supply an isolated path. */
export class FuturesMarketStore {
  private readonly db: DatabaseSync
  private readonly statements = new Map<string, StatementSync>()
  readonly readOnly: boolean

  constructor(path: string, options: { readOnly?: boolean } = {}) {
    this.readOnly = options.readOnly ?? false
    if (!path || path === ':memory:') {
      if (path !== ':memory:')
        throw new TypeError('An explicit database path is required.')
      if (this.readOnly)
        throw new TypeError(
          'A read-only market source must be a database file.',
        )
    } else {
      if (this.readOnly && !existsSync(path))
        throw new Error('Read-only futures market source does not exist.')
      if (!this.readOnly) mkdirSync(dirname(path), { recursive: true })
    }
    this.db = new DatabaseSync(path, { readOnly: this.readOnly })
    if (!this.readOnly)
      this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;')
    if (path !== ':memory:' && !this.readOnly)
      // Every event keeps its own committed transaction; NORMAL in WAL mode
      // avoids an fsync per commit (durable against app crashes).
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;')
    if (this.readOnly) {
      // Tolerate the single writer holding a commit lock; never writes.
      this.db.exec('PRAGMA busy_timeout=2000;')
      const version = this.schemaVersion()
      if (version !== 3 && version !== 4)
        throw new Error(
          'Read-only futures market source schema is unsupported.',
        )
      return
    }
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
      CREATE INDEX IF NOT EXISTS paper_futures_data_gaps_detected_at
        ON paper_futures_data_gaps(detected_at);
      CREATE TABLE IF NOT EXISTS paper_futures_candle_revisions (
        candle_id TEXT NOT NULL, interval_ms INTEGER NOT NULL, bucket_start INTEGER NOT NULL,
        revision INTEGER NOT NULL, known_at INTEGER NOT NULL, close_at INTEGER,
        is_closed INTEGER NOT NULL, coverage TEXT NOT NULL, open_price TEXT NOT NULL,
        high_price TEXT NOT NULL, low_price TEXT NOT NULL, close_price TEXT NOT NULL,
        volume_btc TEXT NOT NULL, trade_count INTEGER NOT NULL, source_hash TEXT NOT NULL,
        PRIMARY KEY(candle_id, revision)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS paper_futures_candle_revisions_bucket
        ON paper_futures_candle_revisions(interval_ms, bucket_start);
      INSERT OR IGNORE INTO paper_futures_market_migrations VALUES(2, unixepoch('subsec') * 1000);
      CREATE TABLE IF NOT EXISTS paper_futures_market_quality_policies (
        policy_version TEXT PRIMARY KEY, recorded_at INTEGER NOT NULL,
        payload_json TEXT NOT NULL
      ) STRICT;
      INSERT OR IGNORE INTO paper_futures_market_migrations VALUES(3, unixepoch('subsec') * 1000);
      CREATE TABLE IF NOT EXISTS paper_futures_funding_responses(
        sha256 TEXT PRIMARY KEY, received_at INTEGER NOT NULL, server_time TEXT NOT NULL, raw_response TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS paper_futures_funding_periods(
        response_sha256 TEXT NOT NULL REFERENCES paper_futures_funding_responses(sha256),
        start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL, funding_rate TEXT NOT NULL,
        known_at INTEGER NOT NULL, unit TEXT NOT NULL, PRIMARY KEY(response_sha256,start_ms)
      ) STRICT;
      CREATE TRIGGER IF NOT EXISTS paper_futures_funding_responses_no_update
        BEFORE UPDATE ON paper_futures_funding_responses BEGIN SELECT RAISE(ABORT, 'funding evidence is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS paper_futures_funding_responses_no_delete
        BEFORE DELETE ON paper_futures_funding_responses BEGIN SELECT RAISE(ABORT, 'funding evidence is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS paper_futures_funding_periods_no_update
        BEFORE UPDATE ON paper_futures_funding_periods BEGIN SELECT RAISE(ABORT, 'funding evidence is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS paper_futures_funding_periods_no_delete
        BEFORE DELETE ON paper_futures_funding_periods BEGIN SELECT RAISE(ABORT, 'funding evidence is immutable'); END;
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
      CREATE TABLE IF NOT EXISTS paper_futures_official_candle_responses(
        sha256 TEXT PRIMARY KEY, interval_ms INTEGER NOT NULL, from_ms INTEGER NOT NULL,
        to_ms INTEGER NOT NULL, received_at INTEGER NOT NULL, raw_response TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS paper_futures_official_candles(
        interval_ms INTEGER NOT NULL, bucket_start INTEGER NOT NULL, revision_hash TEXT NOT NULL,
        known_at INTEGER NOT NULL, open_price TEXT NOT NULL, high_price TEXT NOT NULL,
        low_price TEXT NOT NULL, close_price TEXT NOT NULL, volume_btc TEXT NOT NULL,
        response_sha256 TEXT NOT NULL REFERENCES paper_futures_official_candle_responses(sha256),
        PRIMARY KEY(interval_ms, bucket_start, revision_hash)
      ) STRICT;
      CREATE TRIGGER IF NOT EXISTS paper_futures_official_candle_responses_no_update
        BEFORE UPDATE ON paper_futures_official_candle_responses BEGIN SELECT RAISE(ABORT, 'market evidence is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS paper_futures_official_candle_responses_no_delete
        BEFORE DELETE ON paper_futures_official_candle_responses BEGIN SELECT RAISE(ABORT, 'market evidence is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS paper_futures_official_candles_no_update
        BEFORE UPDATE ON paper_futures_official_candles BEGIN SELECT RAISE(ABORT, 'market evidence is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS paper_futures_official_candles_no_delete
        BEFORE DELETE ON paper_futures_official_candles BEGIN SELECT RAISE(ABORT, 'market evidence is immutable'); END;
      INSERT OR IGNORE INTO paper_futures_market_migrations VALUES(4, unixepoch('subsec') * 1000);
    `)
  }

  /** Read-only stores opened on a schema-3 file have no official candle tables. */
  private hasOfficialCandles(): boolean {
    return this.schemaVersion() >= 4
  }

  /** Prepares each hot-path statement once per connection. */
  private prepared(sql: string): StatementSync {
    let statement = this.statements.get(sql)
    if (!statement) {
      statement = this.db.prepare(sql)
      this.statements.set(sql, statement)
    }
    return statement
  }

  /** Diagnostic: current connection `synchronous` level (1 = NORMAL). */
  synchronousLevel(): number {
    const row = this.db.prepare('PRAGMA synchronous').get() as {
      synchronous: number
    }
    return Number(row.synchronous)
  }

  close(): void {
    this.statements.clear()
    this.db.close()
  }

  /** Stores every period of the response, even those already known. */
  appendFundingResponse(response: HistoricalFundingResponse): void {
    this.writeFundingResponse(response, response.records)
  }

  /**
   * Stores the response (raw bytes and hash kept as provenance) only when it
   * adds knowledge: at least one `start_ms` not yet stored with the same rate.
   * Only those periods get rows, so a re-fetch of known history writes nothing.
   * A known period whose rate changed is new, conflicting evidence and is kept
   * with its own `known_at`. Readers still pick the first-known row per
   * `start_ms`, and new rows always get a higher rowid than every older one.
   */
  appendNewFundingKnowledge(response: HistoricalFundingResponse): {
    stored: boolean
    newPeriods: number
  } {
    if (this.readOnly)
      throw new Error('Cannot append to a read-only market store.')
    const known = new Set<string>()
    try {
      const rows = this.db
        .prepare(
          'SELECT DISTINCT start_ms, funding_rate FROM paper_futures_funding_periods',
        )
        .all() as Array<{ start_ms: number; funding_rate: string }>
      for (const row of rows) known.add(`${row.start_ms}:${row.funding_rate}`)
    } catch (error) {
      if (!(error instanceof Error && error.message.includes('no such table')))
        throw error
    }
    const fresh = response.records.filter(
      (record) => !known.has(`${record.startMs}:${record.fundingRate}`),
    )
    if (fresh.length === 0) return { stored: false, newPeriods: 0 }
    this.writeFundingResponse(response, fresh)
    return { stored: true, newPeriods: fresh.length }
  }

  private writeFundingResponse(
    response: HistoricalFundingResponse,
    records: HistoricalFundingResponse['records'],
  ): void {
    if (this.readOnly)
      throw new Error('Cannot append to a read-only market store.')
    const raw = response.rawResponse
    if (Buffer.byteLength(raw, 'utf8') > 2 * 1024 * 1024)
      throw new RangeError('Historical funding response exceeds 2 MiB.')
    const hash = createHash('sha256').update(raw, 'utf8').digest('hex')
    if (hash !== response.sha256)
      throw new Error('Funding response hash mismatch.')
    const prior = this.db
      .prepare(
        'SELECT raw_response FROM paper_futures_funding_responses WHERE sha256=?',
      )
      .get(hash) as { raw_response: string } | undefined
    if (prior && prior.raw_response !== raw)
      throw new Error('Funding response hash identity conflict.')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db
        .prepare(
          'INSERT OR IGNORE INTO paper_futures_funding_responses VALUES(?,?,?,?)',
        )
        .run(
          hash,
          time(response.receivedAtMs, 'receivedAtMs'),
          response.serverTime,
          raw,
        )
      const insert = this.db.prepare(
        'INSERT OR IGNORE INTO paper_futures_funding_periods VALUES(?,?,?,?,?,?)',
      )
      for (const record of records) {
        if (
          record.sha256 !== hash ||
          record.knownAtMs !== response.receivedAtMs ||
          record.unit !== 'USD/BTC/hour'
        )
          throw new Error(
            'Funding period provenance does not match its response.',
          )
        insert.run(
          hash,
          time(record.startMs, 'funding start'),
          time(record.endMs, 'funding end'),
          record.fundingRate,
          time(record.knownAtMs, 'funding knownAt'),
          record.unit,
        )
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /**
   * Stores one official charts response and its settled closed candles.
   * A bucket whose values change later is kept as another revision; readers
   * use the first revision known by their cutoff.
   */
  appendOfficialCandles(response: OfficialCandleResponse): {
    inserted: number
  } {
    if (this.readOnly)
      throw new Error('Cannot append to a read-only market store.')
    const raw = response.rawResponse
    if (sha256(raw) !== response.sha256)
      throw new Error('Official candle response hash mismatch.')
    const receivedAt = time(response.receivedAtMs, 'official receivedAt')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.prepared(
        'INSERT OR IGNORE INTO paper_futures_official_candle_responses VALUES(?,?,?,?,?,?)',
      ).run(
        response.sha256,
        time(response.intervalMs, 'official interval'),
        time(response.fromMs, 'official from'),
        time(response.toMs, 'official to'),
        receivedAt,
        raw,
      )
      const insert = this.prepared(
        'INSERT OR IGNORE INTO paper_futures_official_candles VALUES(?,?,?,?,?,?,?,?,?,?)',
      )
      let inserted = 0
      for (const candle of response.candles) {
        if (candle.intervalMs !== response.intervalMs)
          throw new Error(
            'Official candle interval does not match its response.',
          )
        const values = {
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
          volumeBtc: candle.volumeBtc,
        }
        const result = insert.run(
          candle.intervalMs,
          time(candle.bucketStart, 'official bucket'),
          digest(values),
          receivedAt,
          values.open,
          values.high,
          values.low,
          values.close,
          values.volumeBtc,
          response.sha256,
        )
        inserted += Number(result.changes)
      }
      this.db.exec('COMMIT')
      return { inserted }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  latestOfficialBucket(intervalMs: number): number | undefined {
    if (!this.hasOfficialCandles()) return undefined
    const row = this.prepared(
      'SELECT MAX(bucket_start) AS bucket FROM paper_futures_official_candles WHERE interval_ms=?',
    ).get(time(intervalMs, 'official interval')) as { bucket: number | null }
    return row.bucket ?? undefined
  }

  /** Latest `limit` official candles known by the cutoff, ascending. */
  officialCandlesAsOf(
    intervalMs: number,
    knownAtCutoff: number,
    limit: number,
  ): OfficialStoredCandle[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5_000)
      throw new RangeError('Official candle limit must be between 1 and 5000.')
    if (!this.hasOfficialCandles()) return []
    const rows = this.prepared(
      `WITH known AS (
         SELECT *, ROW_NUMBER() OVER (
           PARTITION BY bucket_start ORDER BY known_at, rowid
         ) AS revision_rank
         FROM paper_futures_official_candles
         WHERE interval_ms=? AND known_at<=?
       )
       SELECT * FROM (
         SELECT * FROM known WHERE revision_rank=1
         ORDER BY bucket_start DESC LIMIT ?
       ) ORDER BY bucket_start`,
    ).all(
      time(intervalMs, 'official interval'),
      time(knownAtCutoff, 'knownAtCutoff'),
      limit,
    ) as RecordValue[]
    return rows.map(officialRow)
  }

  /** Highest official-candle rowid (0 when none or on a schema-3 store). */
  maxOfficialRowid(): number {
    if (!this.hasOfficialCandles()) return 0
    const row = this.prepared(
      'SELECT MAX(rowid) AS id FROM paper_futures_official_candles',
    ).get() as { id: number | null }
    return Number(row.id ?? 0)
  }

  /**
   * First-known official candles of one interval appended after a rowid
   * cursor, ascending. A later changed revision of a known bucket is skipped,
   * like `officialCandlesAsOf`. Bounded by rowid and the primary key.
   */
  officialCandlesAfter(
    rowid: number,
    intervalMs: number,
    limit = 500,
  ): Array<{ rowid: number; candle: OfficialStoredCandle }> {
    time(rowid, 'rowid')
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5_000)
      throw new RangeError('Official candle limit must be between 1 and 5000.')
    if (!this.hasOfficialCandles()) return []
    const rows = this.prepared(
      `SELECT o.rowid AS id, o.* FROM paper_futures_official_candles AS o
       WHERE o.rowid>? AND o.interval_ms=?
         AND NOT EXISTS (
           SELECT 1 FROM paper_futures_official_candles AS earlier
           WHERE earlier.interval_ms=o.interval_ms
             AND earlier.bucket_start=o.bucket_start
             AND earlier.rowid<o.rowid
         )
       ORDER BY o.rowid LIMIT ?`,
    ).all(rowid, time(intervalMs, 'official interval'), limit) as RecordValue[]
    return rows.map((row) => ({
      rowid: Number(row.id),
      candle: officialRow(row),
    }))
  }

  /**
   * Quality check of the observed capture against official candles: close
   * and volume of the final closed observed revision. Open/high/low follow
   * different conventions (Kraken opens at the previous close) and are not
   * compared.
   */
  officialCandleQuality(
    intervalMs: number,
    sinceBucketStart = 0,
  ): OfficialCandleQuality {
    const report: OfficialCandleQuality = {
      intervalMs,
      sinceBucketStart,
      compared: 0,
      matched: 0,
      closeMismatches: [],
      volumeMismatches: [],
      observedMissing: [],
      officialRevisionConflicts: [],
    }
    if (!this.hasOfficialCandles()) return report
    const rows = this.db
      .prepare(
        `WITH official AS (
           SELECT bucket_start, close_price, volume_btc,
             COUNT(*) OVER (PARTITION BY bucket_start) AS revisions,
             ROW_NUMBER() OVER (
               PARTITION BY bucket_start ORDER BY known_at, rowid
             ) AS revision_rank
           FROM paper_futures_official_candles
           WHERE interval_ms=? AND bucket_start>=?
         ), observed AS (
           SELECT bucket_start, close_price, volume_btc,
             ROW_NUMBER() OVER (
               PARTITION BY candle_id ORDER BY revision DESC
             ) AS revision_rank
           FROM paper_futures_candle_revisions
           WHERE interval_ms=? AND bucket_start>=? AND is_closed=1
         )
         SELECT o.bucket_start, o.close_price AS official_close,
           o.volume_btc AS official_volume, o.revisions,
           b.close_price AS observed_close, b.volume_btc AS observed_volume
         FROM official AS o
         LEFT JOIN observed AS b
           ON b.bucket_start=o.bucket_start AND b.revision_rank=1
         WHERE o.revision_rank=1
         ORDER BY o.bucket_start`,
      )
      .all(
        intervalMs,
        sinceBucketStart,
        intervalMs,
        sinceBucketStart,
      ) as RecordValue[]
    for (const row of rows) {
      const bucket = Number(row.bucket_start)
      if (Number(row.revisions) > 1)
        report.officialRevisionConflicts.push(bucket)
      if (row.observed_close === null) {
        report.observedMissing.push(bucket)
        continue
      }
      report.compared += 1
      const closeSame = sameDecimal(
        String(row.observed_close),
        String(row.official_close),
      )
      const volumeSame = sameDecimal(
        String(row.observed_volume),
        String(row.official_volume),
      )
      if (!closeSame) report.closeMismatches.push(bucket)
      if (!volumeSame) report.volumeMismatches.push(bucket)
      if (closeSame && volumeSame) report.matched += 1
    }
    return report
  }

  fundingRecordsAsOf(knownAtCutoff: number): Record<string, unknown>[] {
    time(knownAtCutoff, 'knownAtCutoff')
    try {
      return this.db
        .prepare(
          `SELECT p.start_ms AS startMs,p.end_ms AS endMs,p.funding_rate AS fundingRate,
      p.known_at AS knownAtMs,p.unit,r.server_time AS serverTime,r.sha256
      FROM paper_futures_funding_periods p JOIN paper_futures_funding_responses r ON r.sha256=p.response_sha256
      WHERE p.known_at<=? ORDER BY p.start_ms,p.known_at,r.sha256`,
        )
        .all(knownAtCutoff) as Record<string, unknown>[]
    } catch (error) {
      if (error instanceof Error && error.message.includes('no such table'))
        return []
      throw error
    }
  }

  fundingSourceEvidence(): Record<string, unknown>[] {
    return this.fundingRecordsAsOf(Number.MAX_SAFE_INTEGER).map((record) => ({
      startMs: record.startMs,
      endMs: record.endMs,
      fundingRate: record.fundingRate,
      knownAtMs: record.knownAtMs,
      unit: record.unit,
      serverTime: record.serverTime,
      sha256: record.sha256,
    }))
  }

  fundingResponse(sha256: string): Record<string, unknown> | undefined {
    return this.db
      .prepare(
        'SELECT sha256,received_at AS receivedAt,server_time AS serverTime,raw_response AS rawResponse FROM paper_futures_funding_responses WHERE sha256=?',
      )
      .get(sha256) as Record<string, unknown> | undefined
  }

  fundingForInterval(
    at: number,
    knownAtCutoff: number,
  ): Record<string, unknown>[] {
    time(at, 'funding decision time')
    time(knownAtCutoff, 'funding known cutoff')
    try {
      return this.db
        .prepare(
          `SELECT p.start_ms AS startMs,p.end_ms AS endMs,p.funding_rate AS fundingRate,
        p.known_at AS knownAtMs,p.unit,r.server_time AS serverTime,r.sha256
        FROM paper_futures_funding_periods p JOIN paper_futures_funding_responses r ON r.sha256=p.response_sha256
        WHERE p.start_ms<=? AND p.end_ms>? AND p.known_at<=? ORDER BY p.known_at,r.sha256`,
        )
        .all(at, at, knownAtCutoff) as Record<string, unknown>[]
    } catch (error) {
      if (error instanceof Error && error.message.includes('no such table'))
        return []
      throw error
    }
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
    const rawJson =
      typeof rawCatalog === 'string' ? rawCatalog : JSON.stringify(rawCatalog)
    if (
      typeof rawJson !== 'string' ||
      Buffer.byteLength(rawJson, 'utf8') > 5_000_000
    )
      throw new RangeError(
        'Instrument catalog exceeds the 5 MB evidence bound.',
      )
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
        rawJson,
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

  instrumentVersions(): unknown[] {
    return this.db
      .prepare(
        `SELECT metadata_hash,instrument_id,retrieved_at,payload_json,raw_json
         FROM paper_futures_instrument_versions ORDER BY retrieved_at,metadata_hash`,
      )
      .all() as unknown[]
  }

  frozenSnapshot(): Record<string, unknown> {
    const events = this.eventsAsOf(Number.MAX_SAFE_INTEGER)
    const candles = this.candleRevisions()
    const gaps = this.gapsAsOf(Number.MAX_SAFE_INTEGER)
    const funding = this.fundingSourceEvidence()
    return {
      schema_version:
        funding.length === 0
          ? 'futures-market-source-snapshot.v1'
          : 'futures-market-source-snapshot.v2',
      instruments: this.instrumentVersions(),
      quality_policies: this.qualityPolicies(),
      events,
      candles,
      gaps,
      ...(funding.length === 0 ? {} : { funding_observations: funding }),
    }
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
    // Non-trade content is the normalized event itself: canonicalise it once
    // and reuse the text for both the hash and the stored JSON.
    let normalizedJson: string | undefined
    let contentHash: string
    if (feed === 'trade') contentHash = sha256(canonicalEvent(content))
    else {
      normalizedJson = canonicalEvent(normalizedEvent)
      contentHash = sha256(normalizedJson)
    }
    if (uid !== null) {
      const existing = this.prepared(
        `SELECT content_hash FROM paper_futures_market_events
        WHERE feed=? AND product_id=? AND uid=?`,
      ).get(feed, product, uid) as { content_hash: string } | undefined
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
    const existingEvent = this.prepared(
      'SELECT content_hash FROM paper_futures_market_events WHERE event_id=?',
    ).get(eventId) as { content_hash: string } | undefined
    if (existingEvent) {
      if (existingEvent.content_hash !== contentHash)
        throw new Error('Market event identity payload conflict.')
      return 'duplicate'
    }
    const rawJson =
      typeof event.rawJson === 'string'
        ? event.rawJson
        : canonicalEvent(event.raw)
    if (Buffer.byteLength(rawJson, 'utf8') > 256_000)
      throw new RangeError(
        'Raw market evidence exceeds the configured size bound.',
      )
    normalizedJson ??= canonicalEvent(normalizedEvent)
    this.prepared('BEGIN IMMEDIATE').run()
    try {
      this.prepared(
        `INSERT INTO paper_futures_market_events
        (event_id,feed,product_id,epoch,seq,event_time,received_at,persisted_at,uid,raw_json,normalized_json,content_hash)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
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
        this.prepared(
          `INSERT INTO paper_futures_book_snapshots
          (event_id,product_id,epoch,seq,event_time,received_at,bids_json,asks_json) VALUES(?,?,?,?,?,?,?,?)`,
        ).run(
          eventId,
          product,
          epoch,
          seq,
          eventTime,
          receivedAt,
          canonicalEvent(event.bids),
          canonicalEvent(event.asks),
        )
      }
      if (feed === 'ticker') {
        this.prepared(
          `INSERT INTO paper_futures_ticker_snapshots
          (event_id,product_id,epoch,seq,event_time,received_at,payload_json) VALUES(?,?,?,?,?,?,?)`,
        ).run(
          eventId,
          product,
          epoch,
          seq,
          eventTime,
          receivedAt,
          normalizedJson,
        )
      }
      this.prepared('COMMIT').run()
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

  latestBookTickerAsOf(
    receivedCutoff: number,
    maximumReceivedSequence?: number,
  ): Record<string, unknown>[] {
    time(receivedCutoff, 'receivedCutoff')
    if (maximumReceivedSequence !== undefined)
      time(maximumReceivedSequence, 'maximumReceivedSequence')
    const latest = (feed: 'book' | 'ticker') =>
      this.db
        .prepare(
          `SELECT normalized_json,rowid AS received_sequence
           FROM paper_futures_market_events
           WHERE received_at<=? AND feed=?
             ${maximumReceivedSequence === undefined ? '' : 'AND rowid<=?'}
           ORDER BY rowid DESC LIMIT 1`,
        )
        .all(
          ...(maximumReceivedSequence === undefined
            ? [receivedCutoff, feed]
            : [receivedCutoff, feed, maximumReceivedSequence]),
        ) as StoredRow[]
    return latest('book')
      .concat(latest('ticker'))
      .map(withReceivedSequence) as Record<string, unknown>[]
  }

  eventsAfter(receivedSequence: number): unknown[] {
    time(receivedSequence, 'receivedSequence')
    return (
      this.db
        .prepare(
          `SELECT normalized_json,rowid AS received_sequence FROM paper_futures_market_events
           WHERE rowid>? ORDER BY rowid`,
        )
        .all(receivedSequence) as StoredRow[]
    ).map(withReceivedSequence)
  }

  eventCountAfter(receivedSequence: number): number {
    time(receivedSequence, 'receivedSequence')
    const row = this.db
      .prepare(
        'SELECT COUNT(*) AS count FROM paper_futures_market_events WHERE rowid>?',
      )
      .get(receivedSequence) as { count: number }
    return Number(row.count)
  }

  pendingEventsAfterAsOf(
    receivedSequence: number,
    receivedCutoff: number,
  ): {
    count: number
    firstSequence: number | null
    lastSequence: number | null
  } {
    time(receivedSequence, 'receivedSequence')
    time(receivedCutoff, 'receivedCutoff')
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count, MIN(rowid) AS first_sequence,
                MAX(rowid) AS last_sequence
         FROM paper_futures_market_events
         WHERE rowid>? AND received_at<=?`,
      )
      .get(receivedSequence, receivedCutoff) as {
      count: number
      first_sequence: number | null
      last_sequence: number | null
    }
    return {
      count: Number(row.count),
      firstSequence:
        row.first_sequence === null ? null : Number(row.first_sequence),
      lastSequence:
        row.last_sequence === null ? null : Number(row.last_sequence),
    }
  }

  pendingSourceProgressAsOf(
    receivedSequence: number,
    receivedCutoff: number,
    sourceWatermark: number,
  ): {
    pendingCount: number
    firstPendingSequence: number | null
    oldestPendingReceivedAt: number | null
    watermarkSequence: number | null
    watermarkReceivedAt: number | null
    sourcePendingLagMs: number | null
    sourcePendingLagUnavailableReason: string | null
    clockDomain: 'source_received_time'
  } {
    time(receivedSequence, 'receivedSequence')
    time(receivedCutoff, 'receivedCutoff')
    time(sourceWatermark, 'sourceWatermark')
    this.db.exec('BEGIN')
    try {
      const pending = this.db
        .prepare(
          `SELECT COUNT(*) AS count, MIN(rowid) AS first_sequence,
                  MIN(received_at) FILTER (WHERE rowid=(
                    SELECT MIN(rowid) FROM paper_futures_market_events
                    WHERE product_id='PF_XBTUSD' AND rowid>? AND rowid<=? AND received_at<=?
                  )) AS first_received_at
           FROM paper_futures_market_events
           WHERE product_id='PF_XBTUSD' AND rowid>? AND rowid<=? AND received_at<=?`,
        )
        .get(
          receivedSequence,
          sourceWatermark,
          receivedCutoff,
          receivedSequence,
          sourceWatermark,
          receivedCutoff,
        ) as {
        count: number
        first_sequence: number | null
        first_received_at: number | null
      }
      const watermark = this.db
        .prepare(
          `SELECT rowid AS sequence, received_at
           FROM paper_futures_market_events
           WHERE product_id='PF_XBTUSD' AND rowid<=? AND received_at<=?
           ORDER BY rowid DESC LIMIT 1`,
        )
        .get(sourceWatermark, receivedCutoff) as
        | { sequence: number; received_at: number }
        | undefined
      const pendingCount = Number(pending.count)
      const firstSequence =
        pending.first_sequence === null ? null : Number(pending.first_sequence)
      const firstReceivedAt =
        pending.first_received_at === null
          ? null
          : Number(pending.first_received_at)
      const watermarkSequence = watermark ? Number(watermark.sequence) : null
      const watermarkReceivedAt = watermark
        ? Number(watermark.received_at)
        : null
      let unavailableReason: string | null = null
      let lag: number | null = null
      if (pendingCount === 0) {
        unavailableReason = 'no_pending_source_rows'
      } else if (
        firstSequence === null ||
        firstReceivedAt === null ||
        watermarkSequence === null ||
        watermarkReceivedAt === null ||
        !Number.isSafeInteger(firstReceivedAt) ||
        !Number.isSafeInteger(watermarkReceivedAt)
      ) {
        unavailableReason = 'invalid_source_received_time'
      } else {
        const reversals = this.db
          .prepare(
            `SELECT COUNT(*) AS count FROM (
               SELECT received_at,
                      LAG(received_at) OVER (ORDER BY rowid) AS prior_received_at
               FROM paper_futures_market_events
               WHERE product_id='PF_XBTUSD' AND rowid>=? AND rowid<=?
             ) WHERE prior_received_at IS NOT NULL
               AND received_at<prior_received_at`,
          )
          .get(firstSequence, watermarkSequence) as { count: number }
        if (Number(reversals.count) > 0) {
          unavailableReason = 'non_monotonic_source_received_time'
        } else if (watermarkReceivedAt < firstReceivedAt) {
          unavailableReason = 'non_comparable_source_received_time'
        } else {
          lag = watermarkReceivedAt - firstReceivedAt
        }
      }
      this.db.exec('COMMIT')
      return {
        pendingCount,
        firstPendingSequence: firstSequence,
        oldestPendingReceivedAt: firstReceivedAt,
        watermarkSequence,
        watermarkReceivedAt,
        sourcePendingLagMs: lag,
        sourcePendingLagUnavailableReason: unavailableReason,
        clockDomain: 'source_received_time',
      }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  latestTickerAsOf(
    receivedCutoff: number,
  ): Record<string, unknown> | undefined {
    time(receivedCutoff, 'receivedCutoff')
    const row = this.db
      .prepare(
        `SELECT normalized_json, rowid AS received_sequence
         FROM paper_futures_market_events
         WHERE feed='ticker' AND received_at<=?
         ORDER BY received_at DESC,rowid DESC LIMIT 1`,
      )
      .get(receivedCutoff) as StoredRow | undefined
    return row
      ? (withReceivedSequence(row) as Record<string, unknown>)
      : undefined
  }

  /** Highest event rowid, or 0 when empty. Tail cursor for read-only followers. */
  maxEventRowid(): number {
    const row = this.db
      .prepare('SELECT MAX(rowid) AS id FROM paper_futures_market_events')
      .get() as { id: number | null }
    return Number(row.id ?? 0)
  }

  /** Latest receipt time over every feed, or null when no event is stored. */
  latestEventReceivedAt(): number | null {
    const row = this.db
      .prepare(
        `SELECT received_at FROM paper_futures_market_events
         ORDER BY rowid DESC LIMIT 1`,
      )
      .get() as { received_at: number } | undefined
    return row ? Number(row.received_at) : null
  }

  /**
   * Ticker and trade events appended after a rowid cursor, ascending. Book
   * events are skipped on purpose: followers never need their payloads.
   */
  tickerTradeEventsAfter(
    rowid: number,
    limit = 500,
  ): Array<{ rowid: number; event: Record<string, unknown> }> {
    time(rowid, 'rowid')
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5_000)
      throw new RangeError('Tail limit must be between 1 and 5000.')
    return (
      this.db
        .prepare(
          `SELECT rowid AS id, normalized_json FROM paper_futures_market_events
           WHERE rowid>? AND feed IN ('ticker','trade')
           ORDER BY rowid LIMIT ?`,
        )
        .all(rowid, limit) as Array<{ id: number; normalized_json: string }>
    ).map((row) => ({
      rowid: Number(row.id),
      event: JSON.parse(row.normalized_json) as Record<string, unknown>,
    }))
  }

  /** Highest candle revision rowid, or 0 when empty. */
  maxCandleRevisionRowid(): number {
    const row = this.db
      .prepare('SELECT MAX(rowid) AS id FROM paper_futures_candle_revisions')
      .get() as { id: number | null }
    return Number(row.id ?? 0)
  }

  /** Candle revisions of one interval appended after a rowid cursor, ascending. */
  candleRevisionsAfter(
    rowid: number,
    intervalMs: number,
    limit = 500,
  ): Array<{ rowid: number; revision: Record<string, unknown> }> {
    time(rowid, 'rowid')
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1)
      throw new RangeError('Candle interval must be a positive integer.')
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5_000)
      throw new RangeError('Tail limit must be between 1 and 5000.')
    return (
      this.db
        .prepare(
          `SELECT rowid AS id, candle_id,interval_ms,bucket_start,revision,known_at,
             close_at,is_closed,coverage,open_price,high_price,low_price,
             close_price,volume_btc,trade_count
           FROM paper_futures_candle_revisions
           WHERE rowid>? AND interval_ms=?
           ORDER BY rowid LIMIT ?`,
        )
        .all(rowid, intervalMs, limit) as Array<Record<string, unknown>>
    ).map((row) => {
      const { id, ...revision } = row
      return { rowid: Number(id), revision }
    })
  }

  /** Newest stored revision (any state) of one interval, or undefined. */
  latestCandleRevision(
    intervalMs: number,
  ): Record<string, unknown> | undefined {
    return this.db
      .prepare(
        `SELECT candle_id,interval_ms,bucket_start,revision,known_at,close_at,
           is_closed,coverage,open_price,high_price,low_price,close_price,
           volume_btc,trade_count
         FROM paper_futures_candle_revisions WHERE interval_ms=?
         ORDER BY rowid DESC LIMIT 1`,
      )
      .get(intervalMs) as Record<string, unknown> | undefined
  }

  latestInstrumentMetadataHash(): string | null {
    const row = this.db
      .prepare(
        `SELECT metadata_hash FROM paper_futures_instrument_versions
         ORDER BY retrieved_at DESC LIMIT 1`,
      )
      .get() as { metadata_hash: string } | undefined
    return row?.metadata_hash ?? null
  }

  eventCount(): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS count FROM paper_futures_market_events')
      .get() as { count: number }
    return Number(row.count)
  }

  /** Latest stored revision of one candle (index lookup), for restart restore. */
  candleHeadById(candleId: string): StoredCandleHead | undefined {
    const row = this.prepared(
      `SELECT candle_id,interval_ms,bucket_start,revision,known_at,is_closed,
        open_price,high_price,low_price,close_price,volume_btc,trade_count,source_hash
       FROM paper_futures_candle_revisions WHERE candle_id=?
       ORDER BY revision DESC LIMIT 1`,
    ).get(candleId) as RecordValue | undefined
    return row === undefined ? undefined : candleHead(row)
  }

  /** Latest revisions of candles still open from `sinceBucketStart` on. */
  openCandleHeads(
    intervalMs: number,
    sinceBucketStart: number,
  ): StoredCandleHead[] {
    time(intervalMs, 'intervalMs')
    time(sinceBucketStart, 'sinceBucketStart')
    return (
      this.prepared(
        `SELECT candle_id,interval_ms,bucket_start,revision,known_at,is_closed,
          open_price,high_price,low_price,close_price,volume_btc,trade_count,source_hash
         FROM paper_futures_candle_revisions AS r
         WHERE interval_ms=? AND bucket_start>=? AND is_closed=0
           AND revision=(
             SELECT MAX(m.revision) FROM paper_futures_candle_revisions AS m
             WHERE m.candle_id=r.candle_id)
         ORDER BY bucket_start`,
      ).all(intervalMs, sinceBucketStart) as RecordValue[]
    ).map(candleHead)
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

  /**
   * Most recent closed candles for one interval, latest closed revision per
   * bucket, ascending by bucket start. Bounded and index-ordered.
   */
  closedCandlesTail(intervalMs: number, limit = 500): unknown[] {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1)
      throw new RangeError('Candle interval must be a positive integer.')
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
      throw new RangeError('Candle tail limit must be between 1 and 500.')
    const rows = this.db
      .prepare(
        `SELECT candle_id,interval_ms,bucket_start,revision,known_at,close_at,
           is_closed,coverage,open_price,high_price,low_price,close_price,
           volume_btc,trade_count,source_hash
         FROM paper_futures_candle_revisions AS c
         WHERE interval_ms=? AND is_closed=1
           AND revision=(
             SELECT MAX(latest.revision)
             FROM paper_futures_candle_revisions AS latest
             WHERE latest.candle_id=c.candle_id AND latest.is_closed=1
           )
         ORDER BY bucket_start DESC
         LIMIT ?`,
      )
      .all(intervalMs, limit) as unknown[]
    return rows.reverse()
  }

  candlesTailAsOf(knownAtCutoff: number, limitPerInterval = 500): unknown[] {
    time(knownAtCutoff, 'knownAtCutoff')
    if (
      !Number.isSafeInteger(limitPerInterval) ||
      limitPerInterval < 1 ||
      limitPerInterval > 500
    )
      throw new RangeError('Candle tail limit must be between 1 and 500.')
    return this.db
      .prepare(
        `WITH eligible AS (
           SELECT *, ROW_NUMBER() OVER (
             PARTITION BY candle_id ORDER BY revision DESC
           ) AS revision_rank
           FROM paper_futures_candle_revisions
           WHERE known_at<=? AND close_at<=? AND is_closed=1
             AND NOT EXISTS (
               SELECT 1 FROM paper_futures_data_gaps AS gap
               WHERE gap.detected_at < paper_futures_candle_revisions.known_at
                 AND paper_futures_candle_revisions.close_at<=gap.detected_at
             )
         ), ranked AS (
           SELECT *, ROW_NUMBER() OVER (
             PARTITION BY interval_ms ORDER BY bucket_start DESC,candle_id DESC
           ) AS tail_rank
           FROM eligible WHERE revision_rank=1
         )
         SELECT candle_id,interval_ms,bucket_start,revision,known_at,close_at,
           is_closed,coverage,open_price,high_price,low_price,close_price,
           volume_btc,trade_count,source_hash
         FROM ranked WHERE tail_rank<=?
         ORDER BY interval_ms,bucket_start,candle_id`,
      )
      .all(knownAtCutoff, knownAtCutoff, limitPerInterval) as unknown[]
  }

  bookSnapshotHasKnownGap(event: {
    epoch: number
    seq: number
    eventTime: number
    receivedAt: number
  }): boolean {
    time(event.epoch, 'book epoch')
    time(event.seq, 'book sequence')
    time(event.eventTime, 'book event time')
    time(event.receivedAt, 'book received time')
    const row = this.db
      .prepare(
        `SELECT EXISTS(
           SELECT 1 FROM paper_futures_data_gaps
           WHERE feed='book' AND detected_at<=?
             AND ( ?<=detected_at OR (epoch=? AND actual_seq IS NOT NULL AND ?<actual_seq) )
         ) AS has_gap`,
      )
      .get(event.receivedAt, event.eventTime, event.epoch, event.seq) as {
      has_gap: number
    }
    return Number(row.has_gap) === 1
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

  gapStatusAsOf(detectedAtCutoff: number): {
    knownAtMs: number
    gapFree: boolean
  } {
    time(detectedAtCutoff, 'detectedAtCutoff')
    const row = this.db
      .prepare(
        `SELECT EXISTS(
           SELECT 1 FROM paper_futures_data_gaps WHERE detected_at<=?
         ) AS has_gap`,
      )
      .get(detectedAtCutoff) as { has_gap: number }
    return { knownAtMs: detectedAtCutoff, gapFree: Number(row.has_gap) === 0 }
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
