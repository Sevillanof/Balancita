import type { ForecastHorizon, TimestampMs } from '../../domain/contracts.ts'
import { contentHashFor } from '../forecasts/forecast-hashing.ts'
import type { CandleInterval } from '../market-data/intraday-candles.ts'
import type {
  FrozenReplayDataset,
  ReplayDatasetCandle,
} from './replay-contracts.ts'

export const REPLAY_RUN_SCHEMA_VERSION = 'replay-run.v1' as const
export const REPLAY_CHECKPOINT_VERSION = 'replay-checkpoint.v1' as const
export const REPLAY_REPORT_VERSION = 'replay-report.v1' as const

export type ReplayRunStatusKind = 'pending' | 'running' | 'completed' | 'failed'

export interface ReplayRunStart {
  readonly id: string
  readonly version: typeof REPLAY_RUN_SCHEMA_VERSION
  readonly instrumentId: 'BTC-EUR'
  readonly datasetHash: string
  readonly importVersion: string
  readonly interval: CandleInterval
  readonly horizon: ForecastHorizon
  readonly startedAt: TimestampMs
  readonly endedAt: TimestampMs
  readonly candleCount: number
  readonly contentHash: string
}

export interface ReplayRunSummary {
  readonly status: ReplayRunStatusKind
  readonly checkpointCount: number
  readonly forecastCount: number
  readonly outcomeCount: number
  readonly createdAt: TimestampMs
}

export type ReplayRunReference = ReplayRunStart & ReplayRunSummary

export interface ReplayCheckpoint {
  readonly id: string
  readonly version: typeof REPLAY_CHECKPOINT_VERSION
  readonly runId: string
  readonly index: number
  readonly virtualTime: TimestampMs
  readonly bucketStart: TimestampMs
  readonly bucketEnd: TimestampMs
  readonly forecastId: string
  readonly forecastHash: string
  readonly evaluatedOutcomeCount: number
  readonly contentHash: string
}

export interface ReplayInsertResult {
  readonly outcome: 'inserted' | 'duplicate'
  readonly id: string
  readonly contentHash: string
}

export class ReplayRunError extends Error {
  readonly code = 'invalid_replay_run' as const

  constructor(message: string) {
    super(message)
    this.name = 'ReplayRunError'
  }
}

export interface CreateReplayRunStartInput {
  readonly id: string
  readonly dataset: FrozenReplayDataset
  readonly horizon: ForecastHorizon
}

export function createReplayRunStart(
  input: CreateReplayRunStartInput,
): ReplayRunStart {
  if (input.id.trim().length === 0)
    throw new ReplayRunError('A replay run requires a non-empty id.')
  const first = input.dataset.candles[0]
  const last = input.dataset.candles[input.dataset.candles.length - 1]
  if (first === undefined || last === undefined)
    throw new ReplayRunError(
      'A replay run requires at least one closed candle.',
    )
  const body = {
    id: input.id,
    version: REPLAY_RUN_SCHEMA_VERSION,
    instrumentId: 'BTC-EUR' as const,
    datasetHash: input.dataset.datasetHash,
    importVersion: input.dataset.importVersion,
    interval: input.dataset.interval,
    horizon: input.horizon,
    startedAt: first.bucketStart,
    endedAt: last.bucketEnd,
    candleCount: input.dataset.candles.length,
  }
  return { ...body, contentHash: contentHashFor(body) }
}

export interface CreateReplayCheckpointInput {
  readonly runId: string
  readonly index: number
  readonly candle: ReplayDatasetCandle
  readonly forecastId: string
  readonly forecastHash: string
  readonly evaluatedOutcomeCount: number
}

export function createReplayCheckpoint(
  input: CreateReplayCheckpointInput,
): ReplayCheckpoint {
  const body = {
    version: REPLAY_CHECKPOINT_VERSION,
    runId: input.runId,
    index: input.index,
    virtualTime: input.candle.bucketEnd,
    bucketStart: input.candle.bucketStart,
    bucketEnd: input.candle.bucketEnd,
    forecastId: input.forecastId,
    forecastHash: input.forecastHash,
    evaluatedOutcomeCount: input.evaluatedOutcomeCount,
  }
  const contentHash = contentHashFor(body)
  return {
    id: `checkpoint:${input.runId}:${input.index}:${contentHash.slice(0, 16)}`,
    ...body,
    contentHash,
  }
}
