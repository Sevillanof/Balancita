import type {
  ForecastHorizon,
  ForecastOutcome,
  ForecastRecord,
  TimestampMs,
} from '../contracts.ts'
import { contentHashFor } from '../forecast-hashing.ts'
import type { CandleInterval } from '../market/intraday-candles.ts'
import {
  REPLAY_REPORT_VERSION,
  type ReplayRunReference,
  type ReplayRunStatusKind,
} from './replay-run.ts'

export { REPLAY_REPORT_VERSION } from './replay-run.ts'

export interface ReplayReport {
  readonly version: typeof REPLAY_REPORT_VERSION
  readonly id: string
  readonly runId: string
  readonly stream: 'replay'
  readonly instrumentId: 'BTC-EUR'
  readonly datasetHash: string
  readonly importVersion: string
  readonly interval: CandleInterval
  readonly horizon: ForecastHorizon
  readonly virtualClock: {
    readonly startedAt: TimestampMs
    readonly endedAt: TimestampMs
  }
  readonly candles: {
    readonly total: number
    readonly replayed: number
  }
  readonly outcome: {
    readonly forecastCount: number
    readonly evaluatedOutcomeCount: number
    readonly missingOutcomeCount: number
  }
  readonly checkpointCount: number
  readonly status: ReplayRunStatusKind
  readonly contentHash: string
}

export interface ReplayReportInput {
  readonly run: ReplayRunReference
  readonly forecasts: readonly ForecastRecord[]
  readonly outcomes: readonly ForecastOutcome[]
}

/**
 * Build a replay report that can only ever see `historical_replay` forecasts
 * bound to its own run. The filter is applied here (not only at the call site)
 * so a mixed store can never leak live evidence into a replay report.
 */
export function buildReplayReport(input: ReplayReportInput): ReplayReport {
  const forecasts = input.forecasts.filter(
    (forecast) =>
      forecast.sourceMode === 'historical_replay' &&
      forecast.replayRunId === input.run.id,
  )
  const forecastKeys = new Set(
    forecasts.map((forecast) => `${forecast.id}:${forecast.version}`),
  )
  const outcomes = input.outcomes.filter((outcome) =>
    forecastKeys.has(`${outcome.forecastId}:${outcome.forecastVersion}`),
  )
  const body = {
    version: REPLAY_REPORT_VERSION,
    runId: input.run.id,
    stream: 'replay' as const,
    instrumentId: 'BTC-EUR' as const,
    datasetHash: input.run.datasetHash,
    importVersion: input.run.importVersion,
    interval: input.run.interval,
    horizon: input.run.horizon,
    virtualClock: {
      startedAt: input.run.startedAt,
      endedAt: input.run.endedAt,
    },
    candles: {
      total: input.run.candleCount,
      replayed: forecasts.length,
    },
    outcome: {
      forecastCount: forecasts.length,
      evaluatedOutcomeCount: outcomes.length,
      missingOutcomeCount: Math.max(0, forecasts.length - outcomes.length),
    },
    checkpointCount: input.run.checkpointCount,
    status: input.run.status,
  }
  const contentHash = contentHashFor(body)
  return {
    id: `report:${input.run.id}:${contentHash.slice(0, 16)}`,
    ...body,
    contentHash,
  }
}
