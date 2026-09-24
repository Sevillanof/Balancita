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
  type ForecastSourceMode,
  type NewsEvidenceRecord,
  type NewsRelevance,
  type SupportedInstrumentId,
  type TimestampMs,
} from '../../domain/contracts.ts'
import {
  validateForecastOutcome,
  validateForecastRecord,
} from '../forecasts/forecast-validation.ts'
import { contentHashFor } from '../forecasts/forecast-hashing.ts'
import {
  invalid,
  issue,
  type ValidationIssue,
} from '../../platform/validation.ts'
import { validateNewsEvidence } from '../../domain/source-policy.ts'
import { contentHashForNewsEvidence } from '../news/rss-normalizer.ts'
import type { ShadowDecisionRecord } from '../shadow-runs/shadow-decision.ts'
import { restoreShadowDecision } from '../shadow-runs/shadow-decision.ts'
import type { ShadowReport } from '../shadow-runs/shadow-report.ts'
import type {
  ShadowRunReference,
  ShadowRunStart,
  ShadowRunStatus,
} from '../shadow-runs/shadow-run.ts'
import { createShadowStatusRecord } from '../shadow-runs/shadow-run.ts'
import type { ShadowInsertResult } from '../shadow-runs/shadow-run.ts'
import type { ShadowRunStatusKind } from '../shadow-runs/shadow-contracts.ts'
import type { NormalizedMarketPayload } from './market-payload.ts'
import { validateNormalizedMarketPayload } from './market-payload.ts'
import type { FastReplayCandle } from '../simulations/fast-replay-engine.ts'

const SCHEMA_VERSION = 8

export interface OhlcCollectorState {
  readonly cursor: number | null
  readonly lastSuccessfulSync: number
}

export interface OhlcHistoryMetrics {
  readonly candleCount: number
  readonly minTimestamp: number | null
  readonly maxTimestamp: number | null
  readonly coverageHours: number
  readonly gapCount: number
}

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
  readonly sourceMode?: ForecastSourceMode
}

export interface OutcomeInsertResult {
  readonly outcome: 'inserted' | 'duplicate'
  readonly id: string
  readonly version: string
  readonly contentHash: string
}

export interface NewsEvidenceInsertResult {
  readonly outcome: 'inserted' | 'duplicate'
  readonly id: string
  readonly version: string
  readonly contentHash: string
}

export interface NewsEvidenceQuery {
  readonly source?: string
  readonly publishedAtFrom?: TimestampMs
  readonly publishedAtTo?: TimestampMs
  readonly relevance?: NewsRelevance
  readonly usableOnly?: boolean
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

export class NewsStoreValidationError extends Error {
  readonly code = 'invalid_news_evidence' as const
  readonly issues: readonly ValidationIssue[]

  constructor(issues: readonly ValidationIssue[]) {
    super('News evidence operation failed validation.')
    this.name = 'NewsStoreValidationError'
    this.issues = issues
  }
}

export class ShadowStoreValidationError extends Error {
  readonly code = 'invalid_shadow_record' as const
  readonly issues: readonly ValidationIssue[]

  constructor(issues: readonly ValidationIssue[]) {
    super(
      `Shadow validation operation failed validation. [${issues[0]?.code ?? ''}] ${issues[0]?.message ?? ''}`,
    )
    this.name = 'ShadowStoreValidationError'
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
    this.database.exec('PRAGMA busy_timeout = 5000;')
    if (options.path !== ':memory:')
      this.database.exec('PRAGMA journal_mode = WAL;')
    this.migrate()
  }

  schemaVersion(): number {
    const row = this.database
      .prepare('SELECT MAX(version) AS version FROM schema_migrations')
      .get() as SqlRow | undefined
    return typeof row?.version === 'number' ? row.version : 0
  }

  sqliteSettings(): {
    readonly journalMode: string
    readonly busyTimeout: number
  } {
    const journal = this.database.prepare('PRAGMA journal_mode').get() as {
      journal_mode: string
    }
    const timeout = this.database.prepare('PRAGMA busy_timeout').get() as {
      timeout: number
    }
    return { journalMode: journal.journal_mode, busyTimeout: timeout.timeout }
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

  upsertOhlcCandles(
    candles: readonly (FastReplayCandle & { readonly source?: string })[],
  ): number {
    const insert = this.database
      .prepare(`INSERT OR REPLACE INTO candles_1m_kraken
      (timestamp, open, high, low, close, volume, source) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    for (const candle of candles)
      insert.run(
        candle.timestamp,
        candle.open,
        candle.high,
        candle.low,
        candle.close,
        candle.volume,
        candle.source ?? 'kraken_rest_ohlc',
      )
    return candles.length
  }

  listOhlcCandles(startMs: number, endMs: number): readonly FastReplayCandle[] {
    const rows = this.database
      .prepare(
        `SELECT timestamp, open, high, low, close, volume
      FROM candles_1m_kraken WHERE timestamp * 1000 BETWEEN ? AND ? ORDER BY timestamp`,
      )
      .all(startMs, endMs) as SqlRow[]
    return rows.map((row) => ({
      timestamp: Number(row.timestamp),
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
      volume: Number(row.volume),
    }))
  }

  insertOhlcCandles(
    candles: readonly (FastReplayCandle & { readonly source?: string })[],
  ): number {
    const insert = this.database.prepare(
      `INSERT OR IGNORE INTO candles_1m_kraken (timestamp, open, high, low, close, volume, source) VALUES (?, ?, ?, ?, ?, ?, 'kraken_rest_ohlc')`,
    )
    this.database.exec('BEGIN IMMEDIATE')
    try {
      let inserted = 0
      for (const candle of candles) {
        const result = insert.run(
          candle.timestamp,
          candle.open,
          candle.high,
          candle.low,
          candle.close,
          candle.volume,
        )
        inserted += Number(result.changes)
      }
      this.database.exec('COMMIT')
      return inserted
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  ohlcCandleCount(): number {
    const row = this.database
      .prepare('SELECT COUNT(*) AS count FROM candles_1m_kraken')
      .get() as SqlRow
    return Number(row.count)
  }

  latestOhlcTimestamp(): number | null {
    const row = this.database
      .prepare('SELECT MAX(timestamp) AS timestamp FROM candles_1m_kraken')
      .get() as SqlRow
    return row.timestamp === null ? null : Number(row.timestamp)
  }

  ohlcHistoryMetrics(): OhlcHistoryMetrics {
    const row = this.database
      .prepare(
        'SELECT COUNT(*) AS count, MIN(timestamp) AS min_timestamp, MAX(timestamp) AS max_timestamp FROM candles_1m_kraken',
      )
      .get() as SqlRow
    const timestamps = this.database
      .prepare('SELECT timestamp FROM candles_1m_kraken ORDER BY timestamp')
      .all() as SqlRow[]
    let gapCount = 0
    for (let index = 1; index < timestamps.length; index += 1)
      if (
        Number(timestamps[index]!.timestamp) -
          Number(timestamps[index - 1]!.timestamp) >
        60
      )
        gapCount += 1
    const minTimestamp =
      row.min_timestamp === null ? null : Number(row.min_timestamp)
    const maxTimestamp =
      row.max_timestamp === null ? null : Number(row.max_timestamp)
    return {
      candleCount: Number(row.count),
      minTimestamp,
      maxTimestamp,
      coverageHours:
        minTimestamp === null || maxTimestamp === null
          ? 0
          : (maxTimestamp - minTimestamp) / 3600,
      gapCount,
    }
  }

  getOhlcCollectorState(): OhlcCollectorState {
    const row = this.database
      .prepare(
        'SELECT cursor, last_successful_sync FROM ohlc_collector_state WHERE id = 1',
      )
      .get() as SqlRow | undefined
    return {
      cursor:
        row?.cursor === null || row === undefined ? null : Number(row.cursor),
      lastSuccessfulSync:
        row === undefined ? 0 : Number(row.last_successful_sync),
    }
  }

  saveOhlcCollectorState(cursor: number, lastSuccessfulSync: number): void {
    this.database
      .prepare(
        `INSERT INTO ohlc_collector_state (id, cursor, last_successful_sync) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET cursor = excluded.cursor, last_successful_sync = excluded.last_successful_sync`,
      )
      .run(cursor, lastSuccessfulSync)
  }

  saveFastReplayRun(
    id: string,
    request: unknown,
    result: unknown,
    datasetHash: string,
    contentHash: string,
    createdAt = this.clock(),
  ): void {
    const record = { id, request, result, datasetHash, contentHash, createdAt }
    this.database
      .prepare(
        `INSERT INTO fast_replay_runs
      (id, request_json, result_json, dataset_hash, content_hash, created_at, record_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        canonicalJson(request),
        canonicalJson(result),
        datasetHash,
        contentHash,
        createdAt,
        canonicalJson(record),
      )
  }

  listFastReplayRuns(limit = 50): readonly unknown[] {
    const rows = this.database
      .prepare(
        `SELECT record_json FROM fast_replay_runs
      ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      )
      .all(limit) as SqlRow[]
    return rows.flatMap(({ record_json }) => {
      try {
        return [JSON.parse(String(record_json)) as unknown]
      } catch {
        return []
      }
    })
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
           horizon, source_mode, replay_run_id, content_hash, record_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.version,
        record.instrumentId,
        record.createdAt,
        record.asOfTimestamp,
        record.eventCutoff,
        record.horizon,
        record.sourceMode,
        record.replayRunId,
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
        `SELECT record_json, source_mode, replay_run_id FROM forecast_records
         WHERE id = ? AND version = ?`,
      )
      .get(id, version) as SqlRow | undefined
    return row === undefined ? null : hydrateForecast(row)
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
    if (query.sourceMode !== undefined) {
      clauses.push('source_mode = ?')
      parameters.push(query.sourceMode)
    }
    const where = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`
    const rows = this.database
      .prepare(
        `SELECT record_json, source_mode, replay_run_id FROM forecast_records${where} ORDER BY created_at, rowid`,
      )
      .all(...parameters) as SqlRow[]
    return rows.map(hydrateForecast)
  }

  forecastCount(): number {
    const row = this.database
      .prepare('SELECT COUNT(*) AS count FROM forecast_records')
      .get() as SqlRow
    return Number(row.count)
  }

  insertNewsEvidence(input: unknown): NewsEvidenceInsertResult {
    const validation = validateNewsEvidence(input)
    if (!validation.valid) throw new NewsStoreValidationError(validation.issues)
    const evidence = validation.value
    if (contentHashForNewsEvidence(evidence) !== evidence.contentHash)
      throw new NewsStoreValidationError([
        issue(
          'content_hash_mismatch',
          'contentHash',
          'News content hash does not match canonical metadata and provenance.',
        ),
      ])

    const existing = this.database
      .prepare(
        `SELECT id, version, content_hash FROM news_evidence
         WHERE source = ? AND source_item_id = ? AND content_hash = ?`,
      )
      .get(evidence.source, evidence.sourceItemId, evidence.contentHash) as
      SqlRow | undefined
    if (existing !== undefined)
      return {
        outcome: 'duplicate',
        id: String(existing.id),
        version: String(existing.version),
        contentHash: String(existing.content_hash),
      }

    const id = `news:${evidence.source}:${createHash('sha256')
      .update(evidence.sourceItemId)
      .digest('hex')}`
    const versionRow = this.database
      .prepare(
        'SELECT MAX(CAST(version AS INTEGER)) AS version FROM news_evidence WHERE id = ?',
      )
      .get(id) as SqlRow | undefined
    const version = String(Number(versionRow?.version ?? 0) + 1)
    const record: NewsEvidenceRecord = { ...evidence, id, version }
    this.database
      .prepare(
        `INSERT INTO news_evidence
          (id, version, source, source_level, source_item_id, canonical_url,
           published_at, ingested_at, retrieved_at, content_hash, license_status,
           correction_status, correction_of_source_item_id, relevance,
           relevance_rule_version, taxonomy, taxonomy_rule_version, metadata_json,
           content_json, record_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.version,
        record.source,
        record.sourceLevel,
        record.sourceItemId,
        record.url,
        record.publishedAt,
        record.ingestedAt,
        record.retrievedAt,
        record.contentHash,
        record.licenseStatus,
        record.correctionStatus,
        record.correctionOfSourceItemId ?? null,
        record.relevance,
        record.relevanceRuleVersion,
        record.taxonomy,
        record.taxonomyRuleVersion,
        canonicalJson(record.metadata),
        canonicalJson(record.content),
        canonicalJson(record),
      )
    return { outcome: 'inserted', id, version, contentHash: record.contentHash }
  }

  listNewsEvidence(
    query: NewsEvidenceQuery = {},
  ): readonly NewsEvidenceRecord[] {
    const clauses: string[] = []
    const parameters: (string | number)[] = []
    if (query.source !== undefined) {
      clauses.push('source = ?')
      parameters.push(query.source)
    }
    if (query.publishedAtFrom !== undefined) {
      clauses.push('published_at >= ?')
      parameters.push(query.publishedAtFrom)
    }
    if (query.publishedAtTo !== undefined) {
      clauses.push('published_at <= ?')
      parameters.push(query.publishedAtTo)
    }
    if (query.relevance !== undefined) {
      clauses.push('relevance = ?')
      parameters.push(query.relevance)
    }
    if (query.usableOnly === true) {
      clauses.push(
        `correction_status <> 'retracted' AND rowid IN
         (SELECT MAX(rowid) FROM news_evidence GROUP BY id)`,
      )
    }
    const where = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`
    const rows = this.database
      .prepare(
        `SELECT record_json FROM news_evidence${where} ORDER BY published_at, rowid`,
      )
      .all(...parameters) as SqlRow[]
    return rows.map(
      (row) => JSON.parse(String(row.record_json)) as NewsEvidenceRecord,
    )
  }

  newsEvidenceCount(): number {
    const row = this.database
      .prepare('SELECT COUNT(*) AS count FROM news_evidence')
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

  createShadowRun(
    start: ShadowRunStart,
    createdAt: number = this.clock(),
  ): ShadowInsertResult {
    const existing = this.getShadowRunRow(start.id)
    if (existing !== undefined) {
      if (String(existing.content_hash) === start.contentHash)
        return {
          outcome: 'duplicate',
          id: start.id,
          contentHash: start.contentHash,
        }
      throw new ShadowStoreValidationError([
        issue(
          'shadow_run_conflict',
          'contentHash',
          'A shadow run id already exists with a different hash.',
        ),
      ])
    }
    const hashIssue = shadowHashIssue(start, 'contentHash')
    if (hashIssue !== null) throw new ShadowStoreValidationError([hashIssue])

    this.database
      .prepare(
        `INSERT INTO shadow_runs
          (id, run_version, instrument_id, started_at, planned_end_at,
           versions_json, source_constraints_json, content_hash, record_json,
           created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        start.id,
        start.version,
        start.instrumentId,
        start.startedAt,
        start.plannedEndAt,
        canonicalJson(start.versions),
        canonicalJson(start.sourceConstraints),
        start.contentHash,
        canonicalJson(start),
        createdAt,
      )
    this.recordShadowStatus(
      createShadowStatusRecord(start.id, 'collecting', createdAt),
      createdAt,
    )
    return { outcome: 'inserted', id: start.id, contentHash: start.contentHash }
  }

  getShadowRun(runId: string): ShadowRunReference | undefined {
    const row = this.getShadowRunRow(runId)
    if (row === undefined) return undefined
    const run = JSON.parse(String(row.record_json)) as ShadowRunReference
    return { ...run, status: this.currentShadowStatus(runId) }
  }

  listShadowRuns(): readonly ShadowRunReference[] {
    const rows = this.database
      .prepare('SELECT * FROM shadow_runs ORDER BY created_at, rowid')
      .all() as SqlRow[]
    return rows.map((row) => {
      const run = JSON.parse(String(row.record_json)) as ShadowRunReference
      return {
        ...run,
        status: this.currentShadowStatus(run.id),
      }
    })
  }

  shadowRunCount(): number {
    const row = this.database
      .prepare('SELECT COUNT(*) AS count FROM shadow_runs')
      .get() as SqlRow
    return Number(row.count)
  }

  recordShadowStatus(
    status: ShadowRunStatus,
    createdAt: number = this.clock(),
  ): ShadowInsertResult {
    if (this.getShadowRunRow(status.runId) === undefined)
      throw new ShadowStoreValidationError([
        issue(
          'shadow_run_not_found',
          'runId',
          'Status can only be recorded for an existing shadow run.',
        ),
      ])
    const hashIssue = shadowHashIssue(status, 'contentHash')
    if (hashIssue !== null) throw new ShadowStoreValidationError([hashIssue])

    const existing = this.database
      .prepare('SELECT id, content_hash FROM shadow_run_status WHERE id = ?')
      .get(status.id) as SqlRow | undefined
    if (existing !== undefined)
      return {
        outcome: 'duplicate',
        id: status.id,
        contentHash: String(existing.content_hash),
      }
    this.database
      .prepare(
        `INSERT INTO shadow_run_status
          (id, run_id, status, recorded_at, report_hash, reason, content_hash,
           record_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        status.id,
        status.runId,
        status.status,
        status.recordedAt,
        status.reportHash ?? null,
        status.reason,
        status.contentHash,
        canonicalJson(status),
        createdAt,
      )
    return {
      outcome: 'inserted',
      id: status.id,
      contentHash: status.contentHash,
    }
  }

  getShadowStatus(runId: string): ShadowRunStatus | undefined {
    const row = this.database
      .prepare(
        `SELECT record_json FROM shadow_run_status
         WHERE run_id = ? ORDER BY rowid DESC LIMIT 1`,
      )
      .get(runId) as SqlRow | undefined
    return row === undefined
      ? undefined
      : (JSON.parse(String(row.record_json)) as ShadowRunStatus)
  }

  listShadowStatuses(runId: string): readonly ShadowRunStatus[] {
    const rows = this.database
      .prepare(
        `SELECT record_json FROM shadow_run_status
         WHERE run_id = ? ORDER BY rowid`,
      )
      .all(runId) as SqlRow[]
    return rows.map(
      (row) => JSON.parse(String(row.record_json)) as ShadowRunStatus,
    )
  }

  saveShadowReport(
    report: ShadowReport,
    createdAt: number = this.clock(),
  ): ShadowInsertResult {
    if (this.getShadowRunRow(report.runId) === undefined)
      throw new ShadowStoreValidationError([
        issue(
          'shadow_run_not_found',
          'runId',
          'A report can only be saved for an existing shadow run.',
        ),
      ])
    const existing = this.database
      .prepare('SELECT id, content_hash FROM shadow_reports WHERE id = ?')
      .get(report.id) as SqlRow | undefined
    if (existing !== undefined) {
      if (String(existing.content_hash) === report.contentHash)
        return {
          outcome: 'duplicate',
          id: report.id,
          contentHash: report.contentHash,
        }
      throw new ShadowStoreValidationError([
        issue(
          'shadow_report_conflict',
          'contentHash',
          'A shadow report id already exists with a different hash.',
        ),
      ])
    }
    const hashIssue = shadowHashIssue(report, 'contentHash')
    if (hashIssue !== null) throw new ShadowStoreValidationError([hashIssue])

    this.database
      .prepare(
        `INSERT INTO shadow_reports
          (id, run_id, snapshot_timestamp_ms, status, content_hash, record_json,
           created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        report.id,
        report.runId,
        report.snapshotTimestampMs,
        report.status,
        report.contentHash,
        canonicalJson(report),
        createdAt,
      )
    this.recordShadowStatus(
      createShadowStatusRecord(
        report.runId,
        report.status,
        report.snapshotTimestampMs,
        {
          reportHash: report.contentHash,
          reason: 'shadow_report_generated',
        },
      ),
      createdAt,
    )
    return {
      outcome: 'inserted',
      id: report.id,
      contentHash: report.contentHash,
    }
  }

  getShadowReport(runId: string): ShadowReport | undefined {
    const row = this.database
      .prepare(
        `SELECT record_json FROM shadow_reports
         WHERE run_id = ? ORDER BY snapshot_timestamp_ms DESC, rowid DESC LIMIT 1`,
      )
      .get(runId) as SqlRow | undefined
    return row === undefined
      ? undefined
      : (JSON.parse(String(row.record_json)) as ShadowReport)
  }

  getShadowReportById(id: string): ShadowReport | undefined {
    const row = this.database
      .prepare('SELECT record_json FROM shadow_reports WHERE id = ?')
      .get(id) as SqlRow | undefined
    return row === undefined
      ? undefined
      : (JSON.parse(String(row.record_json)) as ShadowReport)
  }

  listShadowReports(): readonly ShadowReport[] {
    const rows = this.database
      .prepare(
        'SELECT record_json FROM shadow_reports ORDER BY snapshot_timestamp_ms, rowid',
      )
      .all() as SqlRow[]
    return rows.map(
      (row) => JSON.parse(String(row.record_json)) as ShadowReport,
    )
  }

  recordShadowDecision(
    decision: ShadowDecisionRecord,
    createdAt: number = this.clock(),
  ): ShadowInsertResult {
    const hashIssue = shadowHashIssue(decision, 'contentHash')
    if (hashIssue !== null) throw new ShadowStoreValidationError([hashIssue])
    if (this.getShadowRunRow(decision.runId) === undefined)
      throw new ShadowStoreValidationError([
        issue(
          'shadow_run_not_found',
          'runId',
          'A decision requires an existing shadow run.',
        ),
      ])
    const report = this.getShadowReportById(decision.reportId)
    if (report === undefined)
      throw new ShadowStoreValidationError([
        issue(
          'shadow_report_not_found',
          'reportId',
          'A decision must reference a saved shadow report.',
        ),
      ])
    if (report.runId !== decision.runId)
      throw new ShadowStoreValidationError([
        issue(
          'shadow_report_run_mismatch',
          'reportId',
          'A decision report must belong to the same shadow run.',
        ),
      ])
    if (report.contentHash !== decision.reportHash)
      throw new ShadowStoreValidationError([
        issue(
          'shadow_report_hash_mismatch',
          'reportHash',
          'A decision report hash must match the saved shadow report.',
        ),
      ])

    const duplicate = this.database
      .prepare(
        'SELECT id, content_hash FROM shadow_decisions WHERE run_id = ? AND content_hash = ?',
      )
      .get(decision.runId, decision.contentHash) as SqlRow | undefined
    if (duplicate !== undefined)
      return {
        outcome: 'duplicate',
        id: String(duplicate.id),
        contentHash: String(duplicate.content_hash),
      }

    const alreadyDecided = this.database
      .prepare('SELECT id FROM shadow_decisions WHERE run_id = ? LIMIT 1')
      .get(decision.runId) as SqlRow | undefined
    if (alreadyDecided !== undefined)
      throw new ShadowStoreValidationError([
        issue(
          'shadow_run_already_decided',
          'runId',
          'A shadow run can hold at most one kept decision.',
        ),
      ])

    const latestStatus = this.getShadowStatus(decision.runId)
    const reviewable =
      latestStatus?.status === 'ready_for_review' ||
      latestStatus?.status === 'insufficient_evidence'
    if (!reviewable)
      throw new ShadowStoreValidationError([
        issue(
          'shadow_run_not_reviewable',
          'status',
          'A decision requires the shadow run to be in a reviewable state.',
        ),
      ])

    this.database
      .prepare(
        `INSERT INTO shadow_decisions
          (id, version, run_id, decision, report_id, report_hash, actor, reason,
           decided_at, content_hash, record_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        decision.id,
        decision.version,
        decision.runId,
        decision.decision,
        decision.reportId,
        decision.reportHash,
        decision.actor,
        decision.reason,
        decision.decidedAt,
        decision.contentHash,
        canonicalJson(decision),
        createdAt,
      )
    this.recordShadowStatus(
      createShadowStatusRecord(
        decision.runId,
        decision.decision,
        decision.decidedAt,
        {
          reportHash: decision.reportHash,
          reason: decision.reason,
        },
      ),
      createdAt,
    )
    return {
      outcome: 'inserted',
      id: decision.id,
      contentHash: decision.contentHash,
    }
  }

  getShadowDecision(runId: string): ShadowDecisionRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM shadow_decisions
         WHERE run_id = ? ORDER BY decided_at DESC, rowid DESC LIMIT 1`,
      )
      .get(runId) as SqlRow | undefined
    if (row === undefined) return undefined
    const restored = restoreShadowDecision(
      JSON.parse(String(row.record_json)) as ShadowDecisionRecord,
    )
    return restored
  }

  listShadowDecisions(runId: string): readonly ShadowDecisionRecord[] {
    const rows = this.database
      .prepare(
        `SELECT record_json FROM shadow_decisions
         WHERE run_id = ? ORDER BY decided_at, rowid`,
      )
      .all(runId) as SqlRow[]
    return rows.map((row) =>
      restoreShadowDecision(
        JSON.parse(String(row.record_json)) as ShadowDecisionRecord,
      ),
    )
  }

  listShadowTables(): string[] {
    const rows = this.database
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name LIKE 'shadow_%' ORDER BY name`,
      )
      .all() as SqlRow[]
    return rows.map((row) => String(row.name))
  }

  private getShadowRunRow(runId: string): SqlRow | undefined {
    return this.database
      .prepare('SELECT * FROM shadow_runs WHERE id = ?')
      .get(runId) as SqlRow | undefined
  }

  private currentShadowStatus(runId: string): ShadowRunStatusKind {
    return this.getShadowStatus(runId)?.status ?? 'collecting'
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
    if (currentVersion < 3) {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS news_evidence (
          id TEXT NOT NULL,
          version TEXT NOT NULL,
          source TEXT NOT NULL,
          source_level TEXT NOT NULL CHECK (source_level IN ('official_primary', 'licensed_reporting')),
          source_item_id TEXT NOT NULL,
          canonical_url TEXT NOT NULL,
          published_at INTEGER NOT NULL,
          ingested_at INTEGER NOT NULL,
          retrieved_at INTEGER NOT NULL,
          content_hash TEXT NOT NULL,
          license_status TEXT NOT NULL CHECK (license_status IN ('official_public', 'licensed', 'unknown')),
          correction_status TEXT NOT NULL CHECK (correction_status IN ('original', 'corrected', 'retracted')),
          correction_of_source_item_id TEXT,
          relevance TEXT NOT NULL CHECK (relevance IN ('relevant', 'not_relevant', 'uncertain')),
          relevance_rule_version TEXT NOT NULL,
          taxonomy TEXT NOT NULL CHECK (taxonomy IN ('macro', 'regulation', 'market_structure', 'technology', 'exchange', 'security', 'other')),
          taxonomy_rule_version TEXT NOT NULL,
          metadata_json TEXT NOT NULL,
          content_json TEXT NOT NULL,
          record_json TEXT NOT NULL,
          PRIMARY KEY (id, version),
          UNIQUE (source, canonical_url, content_hash),
          UNIQUE (source, source_item_id, content_hash)
        ) STRICT;
      `)
      this.database
        .prepare(
          'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
        )
        .run(3, this.clock())
    }
    if (currentVersion < 4) {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS shadow_runs (
          id TEXT PRIMARY KEY,
          run_version TEXT NOT NULL,
          instrument_id TEXT NOT NULL CHECK (instrument_id = 'BTC-EUR'),
          started_at INTEGER NOT NULL,
          planned_end_at INTEGER NOT NULL,
          versions_json TEXT NOT NULL,
          source_constraints_json TEXT NOT NULL,
          content_hash TEXT NOT NULL UNIQUE,
          record_json TEXT NOT NULL,
          created_at INTEGER NOT NULL
        ) STRICT;

        CREATE TABLE IF NOT EXISTS shadow_run_status (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          status TEXT NOT NULL CHECK (
            status IN ('collecting', 'ready_for_review',
                       'insufficient_evidence', 'go', 'no_go')
          ),
          recorded_at INTEGER NOT NULL,
          report_hash TEXT,
          reason TEXT NOT NULL,
          content_hash TEXT NOT NULL UNIQUE,
          record_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (run_id) REFERENCES shadow_runs (id)
        ) STRICT;

        CREATE INDEX IF NOT EXISTS idx_shadow_run_status_run
          ON shadow_run_status (run_id);

        CREATE TABLE IF NOT EXISTS shadow_reports (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          snapshot_timestamp_ms INTEGER NOT NULL,
          status TEXT NOT NULL CHECK (
            status IN ('collecting', 'ready_for_review', 'insufficient_evidence')
          ),
          content_hash TEXT NOT NULL UNIQUE,
          record_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (run_id) REFERENCES shadow_runs (id)
        ) STRICT;

        CREATE INDEX IF NOT EXISTS idx_shadow_reports_run
          ON shadow_reports (run_id, snapshot_timestamp_ms);

        CREATE TABLE IF NOT EXISTS shadow_decisions (
          id TEXT PRIMARY KEY,
          version TEXT NOT NULL,
          run_id TEXT NOT NULL,
          decision TEXT NOT NULL CHECK (decision IN ('go', 'no_go')),
          report_id TEXT NOT NULL,
          report_hash TEXT NOT NULL,
          actor TEXT NOT NULL,
          reason TEXT NOT NULL,
          decided_at INTEGER NOT NULL,
          content_hash TEXT NOT NULL UNIQUE,
          record_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (run_id) REFERENCES shadow_runs (id),
          FOREIGN KEY (report_id) REFERENCES shadow_reports (id)
        ) STRICT;

        CREATE INDEX IF NOT EXISTS idx_shadow_decisions_run
          ON shadow_decisions (run_id, decided_at);
      `)
      this.database
        .prepare(
          'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
        )
        .run(4, this.clock())
    }
    if (currentVersion < 5) {
      this.database.exec(`
        ALTER TABLE forecast_records
          ADD COLUMN source_mode TEXT NOT NULL DEFAULT 'shadow_live'
          CHECK (source_mode IN ('shadow_live', 'historical_replay'));

        ALTER TABLE forecast_records
          ADD COLUMN replay_run_id TEXT;

        CREATE INDEX IF NOT EXISTS idx_forecast_records_source_mode
          ON forecast_records (source_mode, created_at);
      `)
      this.database
        .prepare(
          'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
        )
        .run(5, this.clock())
    }
    if (currentVersion < 6) {
      const existingNewsTable = this.database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'news_evidence'",
        )
        .get() as SqlRow | undefined
      if (existingNewsTable !== undefined)
        this.database.exec(
          'ALTER TABLE news_evidence RENAME TO news_evidence_v5;',
        )
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS news_evidence (
          id TEXT NOT NULL,
          version TEXT NOT NULL,
          source TEXT NOT NULL,
          source_level TEXT NOT NULL CHECK (source_level IN ('official_primary', 'licensed_reporting')),
          source_item_id TEXT NOT NULL,
          canonical_url TEXT NOT NULL,
          published_at INTEGER NOT NULL,
          ingested_at INTEGER NOT NULL,
          retrieved_at INTEGER NOT NULL,
          content_hash TEXT NOT NULL,
          license_status TEXT NOT NULL CHECK (license_status IN ('official_public', 'licensed', 'unknown')),
          correction_status TEXT NOT NULL CHECK (correction_status IN ('original', 'corrected', 'retracted')),
          correction_of_source_item_id TEXT,
          relevance TEXT NOT NULL CHECK (relevance IN ('relevant', 'not_relevant', 'uncertain')),
          relevance_rule_version TEXT NOT NULL,
          taxonomy TEXT NOT NULL CHECK (taxonomy IN ('macro', 'regulation', 'market_structure', 'technology', 'exchange', 'security', 'other')),
          taxonomy_rule_version TEXT NOT NULL,
          metadata_json TEXT NOT NULL,
          content_json TEXT NOT NULL,
          record_json TEXT NOT NULL,
          PRIMARY KEY (id, version),
          UNIQUE (source, canonical_url, content_hash),
          UNIQUE (source, source_item_id, content_hash)
        ) STRICT;

      `)
      if (existingNewsTable !== undefined) {
        this.database.exec(`
          INSERT INTO news_evidence
            SELECT id, version, source, source_level, source_item_id, canonical_url,
                   published_at, ingested_at, retrieved_at, content_hash,
                   license_status, correction_status, correction_of_source_item_id,
                   relevance, relevance_rule_version, taxonomy, taxonomy_rule_version,
                   metadata_json, content_json, record_json
            FROM news_evidence_v5;

          DROP TABLE news_evidence_v5;
        `)
      }
      this.database
        .prepare(
          'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
        )
        .run(6, this.clock())
    }
    if (currentVersion < 7) {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS candles_1m_kraken (
          timestamp INTEGER PRIMARY KEY,
          open REAL NOT NULL,
          high REAL NOT NULL,
          low REAL NOT NULL,
          close REAL NOT NULL,
          volume REAL NOT NULL,
          source TEXT NOT NULL DEFAULT 'kraken_rest_ohlc'
        ) STRICT;
        CREATE TABLE IF NOT EXISTS fast_replay_runs (
          id TEXT PRIMARY KEY,
          request_json TEXT NOT NULL,
          result_json TEXT NOT NULL,
          dataset_hash TEXT NOT NULL,
          content_hash TEXT NOT NULL UNIQUE,
          created_at INTEGER NOT NULL,
          record_json TEXT NOT NULL
        ) STRICT;
        CREATE TRIGGER IF NOT EXISTS fast_replay_runs_no_update
          BEFORE UPDATE ON fast_replay_runs BEGIN
            SELECT RAISE(ABORT, 'fast_replay_runs is append-only');
          END;
        CREATE TRIGGER IF NOT EXISTS fast_replay_runs_no_delete
          BEFORE DELETE ON fast_replay_runs BEGIN
            SELECT RAISE(ABORT, 'fast_replay_runs is append-only');
          END;
      `)
      this.database
        .prepare(
          'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
        )
        .run(7, this.clock())
    }
    if (currentVersion < 8) {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS ohlc_collector_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          cursor INTEGER,
          last_successful_sync INTEGER NOT NULL
        ) STRICT;
      `)
      this.database
        .prepare(
          'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
        )
        .run(8, this.clock())
    }
  }
}

function streamKey(source: string, instrumentId: string): string {
  return `${source}:${instrumentId}`
}

function hydrateForecast(row: SqlRow): ForecastRecord {
  const raw = JSON.parse(String(row.record_json)) as Record<string, unknown>
  const record = raw as unknown as ForecastRecord
  const sourceMode: ForecastSourceMode =
    typeof raw.sourceMode === 'string'
      ? (raw.sourceMode as ForecastSourceMode)
      : typeof row.source_mode === 'string'
        ? (row.source_mode as ForecastSourceMode)
        : 'shadow_live'
  const replayRunId: string | null =
    raw.replayRunId === null
      ? null
      : typeof raw.replayRunId === 'string'
        ? raw.replayRunId
        : row.replay_run_id === null || row.replay_run_id === undefined
          ? null
          : String(row.replay_run_id)
  return { ...record, sourceMode, replayRunId }
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

function shadowHashIssue(
  value: { readonly contentHash: string },
  path: string,
): ValidationIssue | null {
  const { contentHash, ...withoutHash } = value
  return contentHashFor(withoutHash) === contentHash
    ? null
    : issue(
        'content_hash_mismatch',
        path,
        'Content hash does not match the canonical record.',
      )
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
