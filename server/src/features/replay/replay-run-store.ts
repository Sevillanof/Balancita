import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { TimestampMs } from '../../domain/contracts.ts'
import { canonicalJson } from '../forecasts/forecast-hashing.ts'
import {
  ReplayRunError,
  type ReplayCheckpoint,
  type ReplayInsertResult,
  type ReplayRunReference,
  type ReplayRunStart,
  type ReplayRunStatusKind,
} from './replay-run.ts'
import type { ReplayRunSummary } from './replay-run.ts'

export interface ReplayRunStoreOptions {
  readonly path: string
  readonly clock?: () => TimestampMs
}

export interface ReplayRunFinalize {
  readonly status: ReplayRunStatusKind
  readonly checkpointCount: number
  readonly forecastCount: number
  readonly outcomeCount: number
}

type SqlRow = Record<string, unknown>

/**
 * Durable storage for replay runs and their checkpoints. It is intentionally
 * independent from `MarketStore`: it opens only the injected path, so replay
 * orchestration metadata can never be written to the live
 * `server/data/market.sqlite` database.
 */
export class ReplayRunStore {
  private readonly database: DatabaseSync
  private readonly clock: () => TimestampMs

  constructor(options: ReplayRunStoreOptions) {
    if (options.path !== ':memory:')
      mkdirSync(dirname(options.path), { recursive: true })
    this.database = new DatabaseSync(options.path)
    this.clock = options.clock ?? (() => Date.now() as TimestampMs)
    this.migrate()
  }

  saveRun(
    start: ReplayRunStart,
    createdAt: number = this.clock(),
  ): ReplayInsertResult {
    const existing = this.getRunRow(start.id)
    if (existing !== undefined) {
      if (String(existing.content_hash) === start.contentHash)
        return {
          outcome: 'duplicate',
          id: start.id,
          contentHash: start.contentHash,
        }
      throw new ReplayRunError(
        'A replay run id already exists with a different content hash.',
      )
    }
    this.database
      .prepare(
        `INSERT INTO replay_runs
          (id, run_version, instrument_id, dataset_hash, import_version, interval,
           horizon, started_at, ended_at, candle_count, status, checkpoint_count,
           forecast_count, outcome_count, content_hash, record_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        start.id,
        start.version,
        start.instrumentId,
        start.datasetHash,
        start.importVersion,
        start.interval,
        start.horizon,
        start.startedAt,
        start.endedAt,
        start.candleCount,
        'running',
        0,
        0,
        0,
        start.contentHash,
        canonicalJson(start),
        createdAt,
      )
    return {
      outcome: 'inserted',
      id: start.id,
      contentHash: start.contentHash,
    }
  }

  finalizeRun(runId: string, summary: ReplayRunFinalize): void {
    const existing = this.getRunRow(runId)
    if (existing === undefined)
      throw new ReplayRunError(`No replay run exists for id ${runId}.`)
    this.database
      .prepare(
        `UPDATE replay_runs SET
           status = ?, checkpoint_count = ?, forecast_count = ?, outcome_count = ?
         WHERE id = ?`,
      )
      .run(
        summary.status,
        summary.checkpointCount,
        summary.forecastCount,
        summary.outcomeCount,
        runId,
      )
  }

  getRun(runId: string): ReplayRunReference | undefined {
    const row = this.getRunRow(runId)
    return row === undefined ? undefined : hydrateRun(row)
  }

  listRuns(): readonly ReplayRunReference[] {
    const rows = this.database
      .prepare('SELECT * FROM replay_runs ORDER BY created_at, rowid')
      .all() as SqlRow[]
    return rows.map(hydrateRun)
  }

  runCount(): number {
    const row = this.database
      .prepare('SELECT COUNT(*) AS count FROM replay_runs')
      .get() as SqlRow
    return Number(row.count)
  }

  saveCheckpoint(
    checkpoint: ReplayCheckpoint,
    createdAt: number = this.clock(),
  ): ReplayInsertResult {
    if (this.getRunRow(checkpoint.runId) === undefined)
      throw new ReplayRunError(
        'A checkpoint can only be saved for an existing replay run.',
      )
    const existing = this.database
      .prepare('SELECT id, content_hash FROM replay_checkpoints WHERE id = ?')
      .get(checkpoint.id) as SqlRow | undefined
    if (existing !== undefined) {
      if (String(existing.content_hash) !== checkpoint.contentHash)
        throw new ReplayRunError(
          'A replay checkpoint id already exists with a different content hash.',
        )
      return {
        outcome: 'duplicate',
        id: checkpoint.id,
        contentHash: checkpoint.contentHash,
      }
    }
    this.database
      .prepare(
        `INSERT INTO replay_checkpoints
          (id, run_id, checkpoint_index, virtual_time, bucket_start, bucket_end,
           forecast_id, forecast_hash, evaluated_outcome_count, content_hash,
           record_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        checkpoint.id,
        checkpoint.runId,
        checkpoint.index,
        checkpoint.virtualTime,
        checkpoint.bucketStart,
        checkpoint.bucketEnd,
        checkpoint.forecastId,
        checkpoint.forecastHash,
        checkpoint.evaluatedOutcomeCount,
        checkpoint.contentHash,
        canonicalJson(checkpoint),
        createdAt,
      )
    return {
      outcome: 'inserted',
      id: checkpoint.id,
      contentHash: checkpoint.contentHash,
    }
  }

  listCheckpoints(runId: string): readonly ReplayCheckpoint[] {
    const rows = this.database
      .prepare(
        `SELECT record_json FROM replay_checkpoints
         WHERE run_id = ? ORDER BY checkpoint_index`,
      )
      .all(runId) as SqlRow[]
    return rows.map(
      (row) => JSON.parse(String(row.record_json)) as ReplayCheckpoint,
    )
  }

  checkpointCount(runId: string): number {
    const row = this.database
      .prepare(
        'SELECT COUNT(*) AS count FROM replay_checkpoints WHERE run_id = ?',
      )
      .get(runId) as SqlRow
    return Number(row.count)
  }

  close(): void {
    this.database.close()
  }

  private getRunRow(runId: string): SqlRow | undefined {
    return this.database
      .prepare('SELECT * FROM replay_runs WHERE id = ?')
      .get(runId) as SqlRow | undefined
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS replay_runs (
        id TEXT PRIMARY KEY,
        run_version TEXT NOT NULL,
        instrument_id TEXT NOT NULL CHECK (instrument_id = 'BTC-EUR'),
        dataset_hash TEXT NOT NULL,
        import_version TEXT NOT NULL,
        interval TEXT NOT NULL CHECK (interval IN ('1m', '5m', '15m', '1h')),
        horizon TEXT NOT NULL CHECK (horizon IN ('15m', '1h', '4h', '24h')),
        started_at INTEGER NOT NULL,
        ended_at INTEGER NOT NULL,
        candle_count INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (
          status IN ('pending', 'running', 'completed', 'failed')
        ),
        checkpoint_count INTEGER NOT NULL,
        forecast_count INTEGER NOT NULL,
        outcome_count INTEGER NOT NULL,
        content_hash TEXT NOT NULL UNIQUE,
        record_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS replay_checkpoints (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        checkpoint_index INTEGER NOT NULL,
        virtual_time INTEGER NOT NULL,
        bucket_start INTEGER NOT NULL,
        bucket_end INTEGER NOT NULL,
        forecast_id TEXT NOT NULL,
        forecast_hash TEXT NOT NULL,
        evaluated_outcome_count INTEGER NOT NULL,
        content_hash TEXT NOT NULL UNIQUE,
        record_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE (run_id, checkpoint_index),
        FOREIGN KEY (run_id) REFERENCES replay_runs (id)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_replay_checkpoints_run
        ON replay_checkpoints (run_id, checkpoint_index);
    `)
  }
}

function hydrateRun(row: SqlRow): ReplayRunReference {
  const start = JSON.parse(String(row.record_json)) as ReplayRunStart
  const summary: ReplayRunSummary = {
    status: row.status as ReplayRunStatusKind,
    checkpointCount: Number(row.checkpoint_count),
    forecastCount: Number(row.forecast_count),
    outcomeCount: Number(row.outcome_count),
    createdAt: Number(row.created_at) as TimestampMs,
  }
  return { ...start, ...summary }
}
