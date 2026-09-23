import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { ForecastHorizon, TimestampMs } from '../contracts.ts'
import { MarketStore } from '../market/market-store.ts'
import {
  freezeDatasetFromObservations,
  openLiveMarketDbReadOnly,
  readKrakenObservationRows,
} from '../replay/kraken-observation-import.ts'
import { ReplayDatasetStore } from '../replay/replay-dataset-store.ts'
import { ReplayRunStore } from '../replay/replay-run-store.ts'
import { ReplayRunService } from '../replay/replay-service.ts'
import type { FrozenReplayDataset } from '../replay/replay-contracts.ts'
import {
  SIMULATION_CANDIDATES,
  simulationManifestHash,
} from './candidate-manifest.ts'
import {
  buildComparisonReport,
  type SimulationComparisonReport,
  type SimulationScoredEntry,
} from './comparison-report.ts'
import { splitByTime } from './time-split.ts'

export const SIMULATIONS_DEFAULT_HORIZON: ForecastHorizon = '15m'
export const SIMULATIONS_DEFAULT_SELECTION_PCT = 0.7
export const SIMULATIONS_REPORT_FILE_VERSION =
  'simulations-report-file.v1' as const

export interface SimulationsRunnerOptions {
  /** Live market database. Opened strictly read-only, never written. */
  readonly marketDbPath: string
  /** Isolated replay dataset store. Must not be the live market database. */
  readonly datasetDbPath: string
  /** Isolated replay run store. Must not be the live market database. */
  readonly runsDbPath: string
  /** Isolated forecast/outcome ledger. Must not be the live market database. */
  readonly ledgerDbPath: string
  /** JSON file receiving the latest persisted comparison report. */
  readonly reportPath: string
  readonly horizons: readonly ForecastHorizon[]
  readonly selectionPct?: number
  readonly since?: TimestampMs
  readonly until?: TimestampMs
  readonly clock?: () => TimestampMs
}

export interface HorizonSimulationResult {
  readonly horizon: ForecastHorizon
  readonly report: SimulationComparisonReport
}

export interface SimulationsRunnerResult {
  readonly importVersion: string
  readonly datasetHash: string
  readonly manifestHash: string
  readonly asOfTimestamp: TimestampMs
  readonly candleCount: number
  readonly selectionPct: number
  readonly horizons: readonly HorizonSimulationResult[]
}

export interface SimulationsReportFile {
  readonly version: typeof SIMULATIONS_REPORT_FILE_VERSION
  readonly generatedAt: TimestampMs
  readonly instrumentId: 'BTC-EUR'
  readonly importVersion: string
  readonly datasetHash: string
  readonly manifestHash: string
  readonly selectionPct: number
  readonly reports: readonly SimulationComparisonReport[]
}

/**
 * Honest strategy comparison over already-collected Kraken BTC-EUR data.
 * Every manifest candidate replays the same frozen dataset; forecasts only
 * ever use evidence at or before their own cutoff (walk-forward, no
 * look-ahead). Evaluated pairs are partitioned by forecast time into a
 * selection slice (default first 70%) and a locked validation slice; the
 * selection winner is validated exactly once on that locked slice.
 */
export function runSimulationsFromLiveDb(
  options: SimulationsRunnerOptions,
): SimulationsRunnerResult {
  if (options.horizons.length === 0) {
    throw new Error('At least one forecast horizon is required.')
  }
  const selectionPct = options.selectionPct ?? SIMULATIONS_DEFAULT_SELECTION_PCT
  if (!Number.isFinite(selectionPct) || selectionPct <= 0 || selectionPct >= 1)
    throw new Error(
      'Selection share must be a finite fraction strictly between 0 and 1.',
    )
  const livePath = resolve(options.marketDbPath)
  for (const [name, path] of [
    ['dataset', options.datasetDbPath],
    ['runs', options.runsDbPath],
    ['ledger', options.ledgerDbPath],
    ['report', options.reportPath],
  ] as const) {
    if (resolve(path) === livePath) {
      throw new Error(
        `Simulation ${name} database must not be the live market database (${path}).`,
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
  try {
    datasetStore.saveDataset(dataset, clock())
  } finally {
    datasetStore.close()
  }

  const manifestHash = simulationManifestHash()
  const ledger = new MarketStore({ path: options.ledgerDbPath, clock })
  const runStore = new ReplayRunStore({ path: options.runsDbPath, clock })
  try {
    const service = new ReplayRunService({ store: ledger, runStore, clock })
    const horizons: HorizonSimulationResult[] = []
    for (const horizon of options.horizons) {
      const scored: SimulationScoredEntry[] = []
      const candidates = SIMULATION_CANDIDATES.map((candidate) => {
        const runId = [
          'sim',
          dataset.importVersion,
          dataset.datasetHash.slice(0, 16),
          horizon,
          candidate.candidateId,
        ].join(':')
        const result = service.run({
          dataset,
          horizon,
          runId,
          candidateId: candidate.candidateId,
        })
        const byId = new Map(
          result.forecasts.map((forecast) => [forecast.id, forecast]),
        )
        for (const outcome of result.outcomes) {
          const forecast = byId.get(outcome.forecastId)
          if (forecast === undefined) continue
          scored.push({
            candidateId: candidate.candidateId,
            asOfTimestamp: forecast.asOfTimestamp,
            forecast: {
              probabilityUp: forecast.probabilityUp,
              probabilityDown: forecast.probabilityDown,
              probabilityFlat: forecast.probabilityFlat,
              abstained: forecast.abstained,
              horizon: forecast.horizon,
            },
            outcome: {
              label: outcome.label,
              realizedReturn: outcome.realizedReturn,
            },
          })
        }
        return {
          candidateId: candidate.candidateId,
          ruleVersion: candidate.ruleVersion,
          paramSetVersion: candidate.paramSetVersion,
          runId,
        }
      })
      const ordered = [...scored].sort(
        (left, right) => left.asOfTimestamp - right.asOfTimestamp,
      )
      const { selection, validation, cutTimestamp } = splitByTime(
        ordered,
        selectionPct,
        (entry) => entry.asOfTimestamp,
      )
      const report = buildComparisonReport({
        horizon,
        datasetHash: dataset.datasetHash,
        manifestHash,
        selectionPct,
        selectionCutTimestamp: cutTimestamp,
        selection,
        validation,
        candidates,
      })
      horizons.push({ horizon, report })
    }

    const file: SimulationsReportFile = {
      version: SIMULATIONS_REPORT_FILE_VERSION,
      generatedAt: clock(),
      instrumentId: 'BTC-EUR',
      importVersion: dataset.importVersion,
      datasetHash: dataset.datasetHash,
      manifestHash,
      selectionPct,
      reports: horizons.map((entry) => entry.report),
    }
    mkdirSync(dirname(resolve(options.reportPath)), { recursive: true })
    writeFileSync(
      resolve(options.reportPath),
      `${JSON.stringify(file, null, 2)}\n`,
    )

    return {
      importVersion: dataset.importVersion,
      datasetHash: dataset.datasetHash,
      manifestHash,
      asOfTimestamp: dataset.asOfTimestamp,
      candleCount: dataset.candles.length,
      selectionPct,
      horizons,
    }
  } finally {
    runStore.close()
    ledger.close()
  }
}

export type { FrozenReplayDataset }
