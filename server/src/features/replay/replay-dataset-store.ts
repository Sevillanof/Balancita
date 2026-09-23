import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { TimestampMs } from '../../domain/contracts.ts'
import { canonicalJson } from '../forecasts/forecast-hashing.ts'
import type { FrozenReplayDataset } from './replay-contracts.ts'

export interface ReplayDatasetStoreOptions {
  readonly path: string
  readonly clock?: () => TimestampMs
}

export interface ReplayDatasetSaveResult {
  readonly outcome: 'inserted' | 'duplicate'
  readonly datasetHash: string
}

type SqlRow = Record<string, unknown>

/**
 * Durable storage for frozen replay datasets. It is intentionally independent
 * from `MarketStore`: it opens only the injected path, so replay data can never
 * be written to the live `server/data/market.sqlite` database.
 */
export class ReplayDatasetStore {
  private readonly database: DatabaseSync
  private readonly clock: () => TimestampMs

  constructor(options: ReplayDatasetStoreOptions) {
    if (options.path !== ':memory:')
      mkdirSync(dirname(options.path), { recursive: true })
    this.database = new DatabaseSync(options.path)
    this.clock = options.clock ?? (() => Date.now() as TimestampMs)
    this.migrate()
  }

  saveDataset(
    dataset: FrozenReplayDataset,
    createdAt: TimestampMs = this.clock(),
  ): ReplayDatasetSaveResult {
    const existing = this.database
      .prepare(
        'SELECT dataset_json FROM replay_datasets WHERE dataset_hash = ?',
      )
      .get(dataset.datasetHash) as SqlRow | undefined
    if (existing !== undefined) {
      if (String(existing.dataset_json) !== canonicalJson(dataset))
        throw new Error(
          'A replay dataset hash already exists with different content.',
        )
      return { outcome: 'duplicate', datasetHash: dataset.datasetHash }
    }
    this.database
      .prepare(
        `INSERT INTO replay_datasets
          (dataset_hash, instrument_id, source, import_version, interval,
           as_of_timestamp, dataset_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        dataset.datasetHash,
        dataset.instrumentId,
        dataset.source,
        dataset.importVersion,
        dataset.interval,
        dataset.asOfTimestamp,
        canonicalJson(dataset),
        createdAt,
      )
    return { outcome: 'inserted', datasetHash: dataset.datasetHash }
  }

  getDataset(datasetHash: string): FrozenReplayDataset | null {
    const row = this.database
      .prepare(
        'SELECT dataset_json FROM replay_datasets WHERE dataset_hash = ?',
      )
      .get(datasetHash) as SqlRow | undefined
    return row === undefined
      ? null
      : (JSON.parse(String(row.dataset_json)) as FrozenReplayDataset)
  }

  listDatasets(): readonly FrozenReplayDataset[] {
    const rows = this.database
      .prepare(
        'SELECT dataset_json FROM replay_datasets ORDER BY created_at, rowid',
      )
      .all() as SqlRow[]
    return rows.map(
      (row) => JSON.parse(String(row.dataset_json)) as FrozenReplayDataset,
    )
  }

  close(): void {
    this.database.close()
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS replay_datasets (
        dataset_hash TEXT PRIMARY KEY,
        instrument_id TEXT NOT NULL CHECK (instrument_id = 'BTC-EUR'),
        source TEXT NOT NULL CHECK (source = 'kraken'),
        import_version TEXT NOT NULL,
        interval TEXT NOT NULL CHECK (interval IN ('1m', '5m', '15m', '1h')),
        as_of_timestamp INTEGER NOT NULL,
        dataset_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT;
    `)
  }
}
