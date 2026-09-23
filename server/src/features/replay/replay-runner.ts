import { resolve } from 'node:path'
import type { ForecastHorizon, TimestampMs } from '../../domain/contracts.ts'
import { MarketStore } from '../market-data/market-store.ts'
import {
  KRAKEN_OBSERVATIONS_IMPORT_VERSION,
  freezeDatasetFromObservations,
  openLiveMarketDbReadOnly,
  readKrakenObservationRows,
} from './kraken-observation-import.ts'
import { ReplayDatasetStore } from './replay-dataset-store.ts'
import { ReplayRunStore } from './replay-run-store.ts'
import { ReplayRunService } from './replay-service.ts'
import {
  summarizeReplayRun,
  type ReplayMetricsSummary,
} from './replay-metrics-summary.ts'
import type { FrozenReplayDataset } from './replay-contracts.ts'

export const REPLAY_RUNNER_HORIZONS: readonly ForecastHorizon[] = [
  '15m',
  '1h',
  '4h',
  '24h',
]

export interface ReplayRunnerOptions {
  /** Live market database. Opened strictly read-only, never written. */
  readonly marketDbPath: string
  /** Isolated replay dataset store. Must not be the live market database. */
  readonly datasetDbPath: string
  /** Isolated replay run store. Must not be the live market database. */
  readonly runsDbPath: string
  /** Isolated forecast/outcome ledger. Must not be the live market database. */
  readonly ledgerDbPath: string
  readonly horizons: readonly ForecastHorizon[]
  readonly since?: TimestampMs
  readonly until?: TimestampMs
  readonly clock?: () => TimestampMs
}

export interface HorizonReplayResult {
  readonly horizon: ForecastHorizon
  readonly runId: string
  readonly datasetOutcome: 'inserted' | 'duplicate'
  readonly forecastCount: number
  readonly outcomeCount: number
  readonly summary: ReplayMetricsSummary
}

export interface ReplayRunnerResult {
  readonly importVersion: string
  readonly datasetHash: string
  readonly asOfTimestamp: TimestampMs
  readonly candleCount: number
  readonly tradeCount: number
  readonly horizons: readonly HorizonReplayResult[]
}

/**
 * Minimal deterministic replay runner over already-collected Kraken BTC-EUR
 * 1m data. Refresh is idempotent: the dataset, runs, forecasts, outcomes, and
 * checkpoints all use deterministic ids/hashes, so re-running over unchanged
 * data returns `duplicate` from the existing stores without adding rows, and
 * only new data produces new hashes and runs.
 */
export function runReplayFromLiveDb(
  options: ReplayRunnerOptions,
): ReplayRunnerResult {
  if (options.horizons.length === 0) {
    throw new Error('At least one forecast horizon is required.')
  }
  const livePath = resolve(options.marketDbPath)
  for (const [name, path] of [
    ['dataset', options.datasetDbPath],
    ['runs', options.runsDbPath],
    ['ledger', options.ledgerDbPath],
  ] as const) {
    if (resolve(path) === livePath) {
      throw new Error(
        `Replay ${name} database must not be the live market database (${path}).`,
      )
    }
  }
  const clock = options.clock ?? (() => Date.now() as TimestampMs)

  const live = openLiveMarketDbReadOnly(options.marketDbPath)
  let observations
  try {
    observations = readKrakenObservationRows(live, {
      ...(options.since === undefined ? {} : { since: options.since }),
      ...(options.until === undefined ? {} : { until: options.until }),
    })
  } finally {
    live.close()
  }
  const dataset = freezeDatasetFromObservations(observations)

  const datasetStore = new ReplayDatasetStore({
    path: options.datasetDbPath,
    clock,
  })
  const datasetOutcome = saveDatasetOnce(datasetStore, dataset, clock())

  const ledger = new MarketStore({ path: options.ledgerDbPath, clock })
  const runStore = new ReplayRunStore({ path: options.runsDbPath, clock })
  try {
    const service = new ReplayRunService({ store: ledger, runStore, clock })
    const horizons: HorizonReplayResult[] = []
    for (const horizon of options.horizons) {
      const runId = `replay:${dataset.importVersion}:${dataset.datasetHash.slice(0, 16)}:${horizon}`
      const result = service.run({ dataset, horizon, runId })
      horizons.push({
        horizon,
        runId,
        datasetOutcome,
        forecastCount: result.forecasts.length,
        outcomeCount: result.outcomes.length,
        summary: summarizeReplayRun(result),
      })
    }
    return {
      importVersion: dataset.importVersion,
      datasetHash: dataset.datasetHash,
      asOfTimestamp: dataset.asOfTimestamp,
      candleCount: dataset.candles.length,
      tradeCount: dataset.candles.reduce(
        (total, candle) => total + candle.tradeCount,
        0,
      ),
      horizons,
    }
  } finally {
    runStore.close()
    ledger.close()
  }
}

export { KRAKEN_OBSERVATIONS_IMPORT_VERSION }

function saveDatasetOnce(
  store: ReplayDatasetStore,
  dataset: FrozenReplayDataset,
  createdAt: TimestampMs,
): 'inserted' | 'duplicate' {
  try {
    return store.saveDataset(dataset, createdAt).outcome
  } finally {
    store.close()
  }
}
