import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  validateMarketDataEnvelope,
  type MarketDataStatus,
  type ForecastOutcome,
  type ForecastHorizon,
  type ForecastRecord,
  type SupportedInstrumentId,
  type TimestampMs,
} from '../contracts.ts'
import {
  validateForecastOutcome,
  validateForecastRecord,
} from '../forecast-validation.ts'
import { contentHashFor } from '../forecast-hashing.ts'
import { invalid, issue, type ValidationIssue } from '../validation.ts'
import {
  validateNormalizedMarketPayload,
  type NormalizedMarketPayload,
} from './market-payload.ts'

const SCHEMA_VERSION = 2

export interface MarketStoreOptions {
  readonly path: string
  readonly clock?: () => TimestampMs
}

export interface StoredMarketObservation {
  readonly id: string
  readonly source: string
  readonly instrumentId: SupportedInstrumentId
  readonly eventTime: TimestampMs
  readonly receivedTime: TimestampMs
  readonly displayTime: TimestampMs
  readonly sequence?: number
  readonly status: MarketDataStatus
  readonly payload: NormalizedMarketPayload
  readonly freshnessAgeMs: number
  readonly freshnessIsStale: boolean
  readonly contentHash: string
  readonly createdAt: TimestampMs
}

export interface ObservationInsertResult {
  readonly outcome: 'inserted' | 'duplicate'
  readonly id: string
  readonly contentHash: string
}

export interface MarketCursor {
  readonly source: string
  readonly instrumentId: SupportedInstrumentId
  readonly lastSequence?: number
  readonly lastTradeId?: number
  readonly connectionRevision: number
  readonly schemaVersion: number
  readonly status: MarketDataStatus
  readonly lastEventTime?: TimestampMs
  readonly freshnessAgeMs?: number
  readonly updatedAt: TimestampMs
}

export interface CursorUpdate {
  readonly source: string
  readonly instrumentId: SupportedInstrumentId
  readonly lastSequence?: number
  readonly lastTradeId?: number
  readonly status?: MarketDataStatus
  readonly lastEventTime?: TimestampMs
  readonly freshnessAgeMs?: number
  readonly updatedAt?: TimestampMs
}

export interface MarketGap {
  readonly id: number
  readonly source: string
  readonly instrumentId: SupportedInstrumentId
  readonly prevSequence: number
  readonly currentSequence: number
  readonly detectedAt: TimestampMs
  readonly evidence: Readonly<Record<string, unknown>>
}

export interface GapInput {
  readonly source: string
  readonly instrumentId: SupportedInstrumentId
  readonly prevSequence: number
  readonly currentSequence: number
  readonly detectedAt: TimestampMs
  readonly evidence: Readonly<Record<string, unknown>>
}

export interface ForecastInsertResult {
  readonly outcome: 'inserted' | 'duplicate'
  readonly id: string
  readonly version: string
  readonly contentHash: string
}

export interface ForecastQuery {
  readonly instrumentId?: SupportedInstrumentId
  readonly horizon?: ForecastHorizon
  readonly createdAtFrom?: TimestampMs
  readonly createdAtTo?: TimestampMs
}

export interface OutcomeInsertResult {
  readonly outcome: 'inserted' | 'duplicate'
  readonly id: string
  readonly version: string
  readonly contentHash: string
}

export class MarketStoreValidationError extends Error {
  readonly code = 'invalid_market_observation' as const
  readonly issues: readonly ValidationIssue[]

  constructor(issues: readonly ValidationIssue[]) {
    super('Market observation failed validation.')
    this.name = 'MarketStoreValidationError'
    this.issues = issues
  }
}

export class ForecastStoreValidationError extends Error {
  readonly code = 'invalid_forecast_record' as const
  readonly issues: readonly ValidationIssue[]

  constructor(issues: readonly ValidationIssue[]) {
    super('Forecast ledger operation failed validation.')
    this.name = 'ForecastStoreValidationError'
    this.issues = issues
  }
}

type SqlRow = Record<string, unknown>

export class MarketStore {
  private readonly database: DatabaseSync
  private readonly clock: () => TimestampMs

  constructor(options: MarketStoreOptions) {
    if (options.path !== ':memory:')
      mkdirSync(dirname(options.path), { recursive: true })
    this.database = new DatabaseSync(options.path)
    this.clock = options.clock ?? (() => Date.now() as TimestampMs)
    this.database.exec('PRAGMA foreign_keys = ON;')
    this.migrate()
  }

  schemaVersion(): number {
    const row = this.database
      .prepare('SELECT MAX(version) AS version FROM schema_migrations')
      .get() as SqlRow | undefined
    return typeof row?.version === 'number' ? row.version : 0
  }

  insertObservation(
    input: unknown,
    createdAt: TimestampMs = this.clock(),
  ): ObservationInsertResult {
    const envelope = validateMarketDataEnvelope(input)
    const payload = envelope.valid
      ? validateNormalizedMarketPayload(envelope.value.payload)
      : invalid([])
    const issues: ValidationIssue[] = [
      ...(!envelope.valid ? envelope.issues : []),
      ...(!payload.valid ? payload.issues : []),
    ]
    if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
      issues.push(
        issue(
          'invalid_timestamp',
          'createdAt',
          'Created time must be a non-negative safe integer.',
        ),
      )
    }
    if (issues.length > 0 || !envelope.valid || !payload.valid) {
      throw new MarketStoreValidationError(issues)
    }

    const canonical = canonicalJson({
      source: envelope.value.source,
      instrumentId: envelope.value.instrumentId,
      eventTime: envelope.value.eventTime,
      sequence: envelope.value.sequence ?? null,
      payload: payload.value,
    })
    const contentHash = createHash('sha256').update(canonical).digest('hex')
    const id = `${envelope.value.source}:${envelope.value.instrumentId}:${contentHash}`
    const existing = this.database
      .prepare('SELECT id FROM market_observations WHERE content_hash = ?')
      .get(contentHash) as SqlRow | undefined
    if (existing !== undefined) {
      return { outcome: 'duplicate', id: String(existing.id), contentHash }
    }

    this.database
      .prepare(
        `INSERT INTO market_observations
          (id, source, instrument_id, event_time, received_time, display_time,
           sequence, status, payload_json, freshness_age_ms, freshness_is_stale,
           content_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        envelope.value.source,
        envelope.value.instrumentId,
        envelope.value.eventTime,
        envelope.value.receivedTime,
        envelope.value.displayTime,
        envelope.value.sequence ?? null,
        envelope.value.status,
        canonicalJson(payload.value),
        envelope.value.freshness.ageMs,
        envelope.value.freshness.isStale ? 1 : 0,
        contentHash,
        createdAt,
      )
    return { outcome: 'inserted', id, contentHash }
  }

  observationCount(): number {
    const row = this.database
      .prepare('SELECT COUNT(*) AS count FROM market_observations')
      .get() as SqlRow
    return Number(row.count)
  }

  listObservations(): readonly StoredMarketObservation[] {
    const rows = this.database
      .prepare('SELECT * FROM market_observations ORDER BY rowid')
      .all() as SqlRow[]
    return rows.map((row) => ({
      id: String(row.id),
      source: String(row.source),
      instrumentId: row.instrument_id as SupportedInstrumentId,
      eventTime: Number(row.event_time) as TimestampMs,
      receivedTime: Number(row.received_time) as TimestampMs,
      displayTime: Number(row.display_time) as TimestampMs,
      ...(row.sequence === null ? {} : { sequence: Number(row.sequence) }),
      status: row.status as MarketDataStatus,
      payload: JSON.parse(String(row.payload_json)) as NormalizedMarketPayload,
      freshnessAgeMs: Number(row.freshness_age_ms),
      freshnessIsStale: Number(row.freshness_is_stale) === 1,
      contentHash: String(row.content_hash),
      createdAt: Number(row.created_at) as TimestampMs,
    }))
  }

  insertForecast(input: unknown): ForecastInsertResult {
    const validation = validateForecastRecord(input)
    if (!validation.valid)
      throw new ForecastStoreValidationError(validation.issues)
    const record = validation.value
    const hashIssues = hashIssuesFor(record)
    if (hashIssues.length > 0)
      throw new ForecastStoreValidationError(hashIssues)

    const existing = this.database
      .prepare(
        'SELECT id, version, content_hash FROM forecast_records WHERE id = ? AND version = ?',
      )
      .get(record.id, record.version) as SqlRow | undefined
    if (existing !== undefined) {
      if (String(existing.content_hash) !== record.contentHash)
        throw new ForecastStoreValidationError([
          issue(
            'forecast_conflict',
            'contentHash',
            'A forecast id/version already exists with a different hash.',
          ),
        ])
      return {
        outcome: 'duplicate',
        id: String(existing.id),
        version: String(existing.version),
        contentHash: String(existing.content_hash),
      }
    }
    const hashOwner = this.database
      .prepare(
        'SELECT id, version FROM forecast_records WHERE content_hash = ?',
      )
      .get(record.contentHash) as SqlRow | undefined
    if (hashOwner !== undefined)
      throw new ForecastStoreValidationError([
        issue(
          'forecast_hash_conflict',
          'contentHash',
          'A different forecast already uses this content hash.',
        ),
      ])

    this.database
      .prepare(
        `INSERT INTO forecast_records
          (id, version, instrument_id, created_at, as_of_timestamp, event_cutoff,
           horizon, content_hash, record_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.version,
        record.instrumentId,
        record.createdAt,
        record.asOfTimestamp,
        record.eventCutoff,
        record.horizon,
        record.contentHash,
        canonicalJson(record),
      )
    return {
      outcome: 'inserted',
      id: record.id,
      version: record.version,
      contentHash: record.contentHash,
    }
  }

  getForecast(id: string, version = '1'): ForecastRecord | null {
    const row = this.database
      .prepare(
        'SELECT record_json FROM forecast_records WHERE id = ? AND version = ?',
      )
      .get(id, version) as SqlRow | undefined
    return row === undefined
      ? null
      : (JSON.parse(String(row.record_json)) as ForecastRecord)
  }

  listForecasts(query: ForecastQuery = {}): readonly ForecastRecord[] {
    const clauses: string[] = []
    const parameters: (string | number)[] = []
    if (query.instrumentId !== undefined) {
      clauses.push('instrument_id = ?')
      parameters.push(query.instrumentId)
    }
    if (query.horizon !== undefined) {
      clauses.push('horizon = ?')
      parameters.push(query.horizon)
    }
    if (query.createdAtFrom !== undefined) {
      clauses.push('created_at >= ?')
      parameters.push(query.createdAtFrom)
    }
    if (query.createdAtTo !== undefined) {
      clauses.push('created_at <= ?')
      parameters.push(query.createdAtTo)
    }
    const where = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`
    const rows = this.database
      .prepare(
        `SELECT record_json FROM forecast_records${where} ORDER BY created_at, rowid`,
      )
      .all(...parameters) as SqlRow[]
    return rows.map(
      (row) => JSON.parse(String(row.record_json)) as ForecastRecord,
    )
  }

  forecastCount(): number {
    const row = this.database
      .prepare('SELECT COUNT(*) AS count FROM forecast_records')
      .get() as SqlRow
    return Number(row.count)
  }

  insertOutcome(input: unknown): OutcomeInsertResult {
    const validation = validateForecastOutcome(input)
    if (!validation.valid)
      throw new ForecastStoreValidationError(validation.issues)
    const outcome = validation.value
    const forecast = this.getForecast(
      outcome.forecastId,
      outcome.forecastVersion,
    )
    const referenceIssues =
      forecast === null
        ? [
            issue(
              'forecast_not_found',
              'forecastId',
              'Outcome must reference an existing forecast.',
            ),
          ]
        : []
    const checked =
      forecast === null
        ? validation
        : validateForecastOutcome(outcome, forecast)
    const horizonEnd =
      forecast === null
        ? null
        : forecast.asOfTimestamp +
          (
            {
              '15m': 15 * 60_000,
              '1h': 60 * 60_000,
              '4h': 4 * 60 * 60_000,
              '24h': 24 * 60 * 60_000,
            } as const
          )[forecast.horizon]
    const timingIssues =
      forecast !== null &&
      horizonEnd !== null &&
      (outcome.evaluatedAt < horizonEnd ||
        outcome.observedEventTime < horizonEnd)
        ? [
            issue(
              'outcome_before_horizon',
              'observedEventTime',
              'Outcome evidence must be at or after the forecast horizon.',
            ),
          ]
        : []
    if (!checked.valid || referenceIssues.length > 0 || timingIssues.length > 0)
      throw new ForecastStoreValidationError([
        ...referenceIssues,
        ...timingIssues,
        ...(checked.valid ? [] : checked.issues),
      ])
    const hashIssues = hashIssuesFor(outcome)
    if (hashIssues.length > 0)
      throw new ForecastStoreValidationError(hashIssues)

    const existing = this.database
      .prepare(
        'SELECT id, version, content_hash FROM forecast_outcomes WHERE id = ? AND version = ?',
      )
      .get(outcome.id, outcome.version) as SqlRow | undefined
    if (existing !== undefined) {
      if (String(existing.content_hash) !== outcome.contentHash)
        throw new ForecastStoreValidationError([
          issue(
            'outcome_conflict',
            'contentHash',
            'An outcome id/version already exists with a different hash.',
          ),
        ])
      return {
        outcome: 'duplicate',
        id: String(existing.id),
        version: String(existing.version),
        contentHash: String(existing.content_hash),
      }
    }
    this.database
      .prepare(
        `INSERT INTO forecast_outcomes
          (id, version, forecast_id, forecast_version, evaluated_at,
           observed_event_time, observed_data_hash, observed_data_is_closed,
           observed_price, label, realized_return, neutral_band, brier_score,
           log_loss, return_absolute_error, range_absolute_error, cost_json,
           content_hash, outcome_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        outcome.id,
        outcome.version,
        outcome.forecastId,
        outcome.forecastVersion,
        outcome.evaluatedAt,
        outcome.observedEventTime,
        outcome.observedDataHash,
        outcome.observedDataIsClosed ? 1 : 0,
        outcome.observedPrice,
        outcome.label,
        outcome.realizedReturn,
        outcome.neutralBand,
        outcome.brierScore,
        outcome.logLoss ?? null,
        outcome.returnAbsoluteError ?? null,
        outcome.rangeAbsoluteError ?? null,
        outcome.costs === undefined ? null : canonicalJson(outcome.costs),
        outcome.contentHash,
        canonicalJson(outcome),
      )
    return {
      outcome: 'inserted',
      id: outcome.id,
      version: outcome.version,
      contentHash: outcome.contentHash,
    }
  }

  listOutcomes(): readonly ForecastOutcome[] {
    const rows = this.database
      .prepare(
        'SELECT outcome_json FROM forecast_outcomes ORDER BY evaluated_at, rowid',
      )
      .all() as SqlRow[]
    return rows.map(
      (row) => JSON.parse(String(row.outcome_json)) as ForecastOutcome,
    )
  }

  beginConnection(
    source: string,
    instrumentId: SupportedInstrumentId,
    updatedAt: TimestampMs = this.clock(),
  ): number {
    const current = this.getCursor(source, instrumentId)
    const revision = (current?.connectionRevision ?? 0) + 1
    this.database
      .prepare(
        `INSERT INTO market_cursors
          (stream_key, source, instrument_id, last_sequence, last_trade_id,
           connection_revision, schema_version, status, last_event_time,
           freshness_age_ms, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(stream_key) DO UPDATE SET
           connection_revision = excluded.connection_revision,
           schema_version = excluded.schema_version,
           updated_at = excluded.updated_at`,
      )
      .run(
        streamKey(source, instrumentId),
        source,
        instrumentId,
        current?.lastSequence ?? null,
        current?.lastTradeId ?? null,
        revision,
        SCHEMA_VERSION,
        current?.status ?? 'stale',
        current?.lastEventTime ?? null,
        current?.freshnessAgeMs ?? null,
        updatedAt,
      )
    return revision
  }

  getCursor(
    source: string,
    instrumentId: SupportedInstrumentId,
  ): MarketCursor | null {
    const row = this.database
      .prepare('SELECT * FROM market_cursors WHERE stream_key = ?')
      .get(streamKey(source, instrumentId)) as SqlRow | undefined
    if (row === undefined) return null
    return {
      source: String(row.source),
      instrumentId: row.instrument_id as SupportedInstrumentId,
      ...(row.last_sequence === null
        ? {}
        : { lastSequence: Number(row.last_sequence) }),
      ...(row.last_trade_id === null
        ? {}
        : { lastTradeId: Number(row.last_trade_id) }),
      connectionRevision: Number(row.connection_revision),
      schemaVersion: Number(row.schema_version),
      status: row.status as MarketDataStatus,
      ...(row.last_event_time === null
        ? {}
        : { lastEventTime: Number(row.last_event_time) as TimestampMs }),
      ...(row.freshness_age_ms === null
        ? {}
        : { freshnessAgeMs: Number(row.freshness_age_ms) }),
      updatedAt: Number(row.updated_at) as TimestampMs,
    }
  }

  updateCursor(input: CursorUpdate): void {
    const current = this.getCursor(input.source, input.instrumentId)
    const updatedAt = input.updatedAt ?? this.clock()
    const lastSequence = maxOptional(current?.lastSequence, input.lastSequence)
    const lastTradeId = maxOptional(current?.lastTradeId, input.lastTradeId)
    this.database
      .prepare(
        `INSERT INTO market_cursors
          (stream_key, source, instrument_id, last_sequence, last_trade_id,
           connection_revision, schema_version, status, last_event_time,
           freshness_age_ms, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(stream_key) DO UPDATE SET
           last_sequence = excluded.last_sequence,
           last_trade_id = excluded.last_trade_id,
           schema_version = excluded.schema_version,
           status = excluded.status,
           last_event_time = excluded.last_event_time,
           freshness_age_ms = excluded.freshness_age_ms,
           updated_at = excluded.updated_at`,
      )
      .run(
        streamKey(input.source, input.instrumentId),
        input.source,
        input.instrumentId,
        lastSequence ?? null,
        lastTradeId ?? null,
        current?.connectionRevision ?? 0,
        SCHEMA_VERSION,
        input.status ?? current?.status ?? 'stale',
        input.lastEventTime ?? current?.lastEventTime ?? null,
        input.freshnessAgeMs ?? current?.freshnessAgeMs ?? null,
        updatedAt,
      )
  }

  markStale(
    source: string,
    instrumentId: SupportedInstrumentId,
    now: TimestampMs,
    staleAfterMs: number,
  ): void {
    const cursor = this.getCursor(source, instrumentId)
    if (
      cursor?.lastEventTime === undefined ||
      now - cursor.lastEventTime <= staleAfterMs
    ) {
      return
    }
    this.updateCursor({
      source,
      instrumentId,
      status: 'stale',
      freshnessAgeMs: now - cursor.lastEventTime,
      updatedAt: now,
    })
  }

  markStreamStale(
    source: string,
    instrumentId: SupportedInstrumentId,
    updatedAt: TimestampMs,
  ): void {
    if (this.getCursor(source, instrumentId) === null) return
    this.updateCursor({ source, instrumentId, status: 'stale', updatedAt })
  }

  recordGap(input: GapInput): void {
    if (
      !Number.isSafeInteger(input.prevSequence) ||
      !Number.isSafeInteger(input.currentSequence) ||
      input.currentSequence <= input.prevSequence
    ) {
      throw new MarketStoreValidationError([
        issue(
          'invalid_gap',
          'gap',
          'Gap sequences must be increasing safe integers.',
        ),
      ])
    }
    const detectedAt = input.detectedAt
    if (!Number.isSafeInteger(detectedAt) || detectedAt < 0) {
      throw new MarketStoreValidationError([
        issue('invalid_timestamp', 'detectedAt', 'Gap time is invalid.'),
      ])
    }
    this.database
      .prepare(
        `INSERT OR IGNORE INTO market_gaps
          (source, instrument_id, prev_sequence, current_sequence, detected_at,
           evidence_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.source,
        input.instrumentId,
        input.prevSequence,
        input.currentSequence,
        detectedAt,
        canonicalJson(input.evidence),
      )
  }

  listGaps(): readonly MarketGap[] {
    const rows = this.database
      .prepare('SELECT * FROM market_gaps ORDER BY id')
      .all() as SqlRow[]
    return rows.map((row) => ({
      id: Number(row.id),
      source: String(row.source),
      instrumentId: row.instrument_id as SupportedInstrumentId,
      prevSequence: Number(row.prev_sequence),
      currentSequence: Number(row.current_sequence),
      detectedAt: Number(row.detected_at) as TimestampMs,
      evidence: JSON.parse(String(row.evidence_json)) as Record<
        string,
        unknown
      >,
    }))
  }

  close(): void {
    this.database.close()
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      ) STRICT;
    `)
    let currentVersion = this.schemaVersion()
    if (currentVersion < 1) {
      this.database.exec(`
      CREATE TABLE IF NOT EXISTS market_observations (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        instrument_id TEXT NOT NULL CHECK (instrument_id = 'BTC-EUR'),
        event_time INTEGER NOT NULL,
        received_time INTEGER NOT NULL,
        display_time INTEGER NOT NULL,
        sequence INTEGER,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        freshness_age_ms INTEGER NOT NULL,
        freshness_is_stale INTEGER NOT NULL CHECK (freshness_is_stale IN (0, 1)),
        content_hash TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS market_cursors (
        stream_key TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        instrument_id TEXT NOT NULL CHECK (instrument_id = 'BTC-EUR'),
        last_sequence INTEGER,
        last_trade_id INTEGER,
        connection_revision INTEGER NOT NULL,
        schema_version INTEGER NOT NULL,
        status TEXT NOT NULL,
        last_event_time INTEGER,
        freshness_age_ms INTEGER,
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS market_gaps (
        id INTEGER PRIMARY KEY,
        source TEXT NOT NULL,
        instrument_id TEXT NOT NULL CHECK (instrument_id = 'BTC-EUR'),
        prev_sequence INTEGER NOT NULL,
        current_sequence INTEGER NOT NULL,
        detected_at INTEGER NOT NULL,
        evidence_json TEXT NOT NULL,
        UNIQUE (source, instrument_id, prev_sequence, current_sequence)
      ) STRICT;
    `)
      this.database
        .prepare(
          'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
        )
        .run(1, this.clock())
      currentVersion = 1
    }
    if (currentVersion < 2) {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS forecast_records (
          id TEXT NOT NULL,
          version TEXT NOT NULL,
          instrument_id TEXT NOT NULL CHECK (instrument_id = 'BTC-EUR'),
          created_at INTEGER NOT NULL,
          as_of_timestamp INTEGER NOT NULL,
          event_cutoff INTEGER NOT NULL,
          horizon TEXT NOT NULL CHECK (horizon IN ('15m', '1h', '4h', '24h')),
          content_hash TEXT NOT NULL UNIQUE,
          record_json TEXT NOT NULL,
          PRIMARY KEY (id, version)
        ) STRICT;

        CREATE TABLE IF NOT EXISTS forecast_outcomes (
          id TEXT NOT NULL,
          version TEXT NOT NULL,
          forecast_id TEXT NOT NULL,
          forecast_version TEXT NOT NULL,
          evaluated_at INTEGER NOT NULL,
          observed_event_time INTEGER NOT NULL,
          observed_data_hash TEXT NOT NULL,
          observed_data_is_closed INTEGER NOT NULL CHECK (observed_data_is_closed = 1),
          observed_price REAL NOT NULL,
          label TEXT NOT NULL CHECK (label IN ('up', 'down', 'flat')),
          realized_return REAL NOT NULL,
          neutral_band REAL NOT NULL,
          brier_score REAL NOT NULL,
          log_loss REAL,
          return_absolute_error REAL,
          range_absolute_error REAL,
          cost_json TEXT,
          content_hash TEXT NOT NULL UNIQUE,
          outcome_json TEXT NOT NULL,
          PRIMARY KEY (id, version),
          FOREIGN KEY (forecast_id, forecast_version)
            REFERENCES forecast_records (id, version)
        ) STRICT;
      `)
      this.database
        .prepare(
          'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
        )
        .run(2, this.clock())
    }
  }
}

function streamKey(source: string, instrumentId: string): string {
  return `${source}:${instrumentId}`
}

function maxOptional(
  left: number | undefined,
  right: number | undefined,
): number | undefined {
  if (left === undefined) return right
  if (right === undefined) return left
  return Math.max(left, right)
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

function hashIssuesFor(
  value: ForecastRecord | ForecastOutcome,
): readonly ValidationIssue[] {
  const { contentHash, ...withoutHash } = value
  return contentHashFor(withoutHash) === contentHash
    ? []
    : [
        issue(
          'content_hash_mismatch',
          'contentHash',
          'Content hash does not match the canonical record.',
        ),
      ]
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (typeof value !== 'object' || value === null) return value
  const record = value as Record<string, unknown>
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, canonicalize(record[key])]),
  )
}
