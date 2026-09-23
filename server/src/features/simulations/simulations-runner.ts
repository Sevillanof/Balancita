import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { ForecastHorizon, TimestampMs } from '../../domain/contracts.ts'
import { HORIZON_MS } from '../forecasts/forecast-evaluator.ts'
import { MarketStore } from '../market-data/market-store.ts'
import type { StoredMarketObservation } from '../market-data/market-store.ts'
import {
  freezeDatasetFromObservations,
  openLiveMarketDbReadOnly,
  readKrakenObservationRows,
  mapObservationToReplayTrade,
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
  type SimulationProfitabilityInput,
  type SimulationScoredEntry,
} from './comparison-report.ts'
import type { ForecastOutcomeLabel } from '../../domain/contracts.ts'
import {
  DEFAULT_ENTRY_THRESHOLD,
  DEFAULT_EXIT_DOWN_THRESHOLD,
  DEFAULT_EXIT_UP_THRESHOLD,
  DEFAULT_STARTING_CASH,
  DEFAULT_TRADE_COSTS,
  STRATEGY_RULE_VERSION,
  TRADE_COSTS_VERSION,
  type TradeSimBar,
  type TradeSimSignal,
} from './trade-simulation.ts'
import { splitByTime } from './time-split.ts'

export const SIMULATIONS_DEFAULT_HORIZON: ForecastHorizon = '15m'
export const SIMULATIONS_DEFAULT_SELECTION_PCT = 0.7
export const SIMULATIONS_REPORT_FILE_VERSION =
  'simulations-report-file.v2' as const

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
  /** Select only the latest contiguous trade window; never bridge a detected hole. */
  readonly latestContiguous?: boolean
  readonly clock?: () => TimestampMs
  /** Hypothetical starting cash in EUR for the LONG/FLAT trade simulation. */
  readonly startingCash?: number
  /** Enter-long threshold on probabilityUp (default 0.55). */
  readonly entryThreshold?: number
  /** Exit-to-flat threshold on probabilityUp (default 0.45). */
  readonly exitThreshold?: number
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
  readonly window: { readonly since: TimestampMs; readonly until: TimestampMs }
  readonly request: SimulationRequestIdentity
  readonly reports: readonly SimulationComparisonReport[]
}

export interface SimulationRequestIdentity {
  readonly horizons: readonly ForecastHorizon[]
  readonly selectionPct: number
  readonly since: TimestampMs | null
  readonly until: TimestampMs | null
  readonly latestContiguous: boolean
  readonly startingCash: number
  readonly entryThreshold: number
  readonly exitThreshold: number
  readonly exitDownThreshold: number
  readonly strategyRuleVersion: string
  readonly tradeCostsVersion: string
  readonly commissionRate: number
  readonly slippageRate: number
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
  const startingCash = options.startingCash ?? DEFAULT_STARTING_CASH
  if (!Number.isFinite(startingCash) || startingCash <= 0) {
    throw new Error('Starting cash must be a finite positive amount.')
  }
  const entryThreshold = options.entryThreshold ?? DEFAULT_ENTRY_THRESHOLD
  const exitThreshold = options.exitThreshold ?? DEFAULT_EXIT_UP_THRESHOLD
  for (const [name, value] of [
    ['entry', entryThreshold],
    ['exit', exitThreshold],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0 || value >= 1) {
      throw new Error(
        `Trade ${name} threshold must be a finite fraction strictly between 0 and 1.`,
      )
    }
  }
  if (!(exitThreshold < entryThreshold)) {
    throw new Error('Trade exit threshold must be below the entry threshold.')
  }

  const live = openLiveMarketDbReadOnly(options.marketDbPath)
  let observations
  try {
    const rows = readKrakenObservationRows(live, {
      ...(options.since === undefined ? {} : { since: options.since }),
      ...(options.until === undefined ? {} : { until: options.until }),
    })
    observations = options.latestContiguous
      ? latestCleanObservations(rows)
      : rows
  } finally {
    live.close()
  }
  const dataset = freezeDatasetFromObservations(observations)
  const manifestHash = simulationManifestHash()
  const request = simulationRequestIdentity({
    options,
    selectionPct,
    startingCash,
    entryThreshold,
    exitThreshold,
  })

  const cached = readCachedReport(options.reportPath)
  if (
    cached !== null &&
    cached.datasetHash === dataset.datasetHash &&
    cached.importVersion === dataset.importVersion &&
    cached.manifestHash === manifestHash &&
    sameSimulationRequest(cached.request, request)
  ) {
    return {
      importVersion: cached.importVersion,
      datasetHash: cached.datasetHash,
      manifestHash: cached.manifestHash,
      asOfTimestamp: dataset.asOfTimestamp,
      candleCount: dataset.candles.length,
      selectionPct: cached.selectionPct,
      horizons: cached.reports.map((report) => ({
        horizon: report.horizon,
        report,
      })),
    }
  }

  const datasetStore = new ReplayDatasetStore({
    path: options.datasetDbPath,
    clock,
  })
  try {
    datasetStore.saveDataset(dataset, clock())
  } finally {
    datasetStore.close()
  }

  const ledger = new MarketStore({ path: options.ledgerDbPath, clock })
  const runStore = new ReplayRunStore({ path: options.runsDbPath, clock })
  try {
    const service = new ReplayRunService({ store: ledger, runStore, clock })
    const horizons: HorizonSimulationResult[] = []
    for (const horizon of options.horizons) {
      const scored: SimulationScoredEntry[] = []
      const signalsByCandidate: Record<string, TradeSimSignal[]> = {}
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
        signalsByCandidate[candidate.candidateId] = result.forecasts.map(
          (forecast) => ({
            time: forecast.asOfTimestamp,
            probabilityUp: forecast.probabilityUp,
            probabilityDown: forecast.probabilityDown,
            abstained: forecast.abstained,
          }),
        )
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
        profitability: profitabilityInputFor({
          candles: dataset.candles,
          cutTimestamp,
          scored: ordered,
          signalsByCandidate,
          startingCash,
          entryThreshold,
          exitThreshold,
          horizon,
        }),
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
      request,
      window: {
        since: dataset.candles[0]!.bucketStart,
        until: dataset.candles.at(-1)!.bucketEnd,
      },
      reports: horizons.map((entry) => entry.report),
    }
    mkdirSync(dirname(resolve(options.reportPath)), { recursive: true })
    // Retain the earlier manifest/dataset report before replacing the latest
    // pointer. Never erase poor performers or rewrite a frozen comparison.
    try {
      const oldRaw = readFileSync(resolve(options.reportPath), 'utf8')
      const old = JSON.parse(oldRaw) as {
        manifestHash?: string
        datasetHash?: string
      }
      if (old.manifestHash !== undefined && old.datasetHash !== undefined) {
        const archive = `${resolve(options.reportPath)}.${old.manifestHash.slice(0, 16)}.${old.datasetHash.slice(0, 16)}.json`
        try {
          writeFileSync(archive, oldRaw, { flag: 'wx' })
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const pendingReport = `${resolve(options.reportPath)}.${process.pid}.tmp`
    writeFileSync(pendingReport, `${JSON.stringify(file, null, 2)}\n`)
    renameSync(pendingReport, resolve(options.reportPath))

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

function simulationRequestIdentity(args: {
  readonly options: SimulationsRunnerOptions
  readonly selectionPct: number
  readonly startingCash: number
  readonly entryThreshold: number
  readonly exitThreshold: number
}): SimulationRequestIdentity {
  return {
    horizons: [...args.options.horizons],
    selectionPct: args.selectionPct,
    since: args.options.since ?? null,
    until: args.options.until ?? null,
    latestContiguous: args.options.latestContiguous ?? false,
    startingCash: args.startingCash,
    entryThreshold: args.entryThreshold,
    exitThreshold: args.exitThreshold,
    exitDownThreshold: DEFAULT_EXIT_DOWN_THRESHOLD,
    strategyRuleVersion: STRATEGY_RULE_VERSION,
    tradeCostsVersion: TRADE_COSTS_VERSION,
    commissionRate: DEFAULT_TRADE_COSTS.commissionRate,
    slippageRate: DEFAULT_TRADE_COSTS.slippageRate,
  }
}

function readCachedReport(path: string): SimulationsReportFile | null {
  try {
    const value: unknown = JSON.parse(readFileSync(resolve(path), 'utf8'))
    if (typeof value !== 'object' || value === null) return null
    const report = value as Partial<SimulationsReportFile>
    if (
      report.version !== SIMULATIONS_REPORT_FILE_VERSION ||
      typeof report.datasetHash !== 'string' ||
      typeof report.importVersion !== 'string' ||
      typeof report.manifestHash !== 'string' ||
      !Array.isArray(report.reports) ||
      report.request === undefined
    )
      return null
    return report as SimulationsReportFile
  } catch {
    return null
  }
}

function sameSimulationRequest(
  left: SimulationRequestIdentity,
  right: SimulationRequestIdentity,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/** Fail closed when the most recent continuous stream cannot support even a 1h evaluation. */
export function latestCleanObservations(
  rows: readonly StoredMarketObservation[],
): StoredMarketObservation[] {
  let start = 0
  let previous: ReturnType<typeof mapObservationToReplayTrade> = null
  for (const [index, row] of rows.entries()) {
    const trade = mapObservationToReplayTrade(row)
    if (trade === null) continue
    if (previous !== null && trade.tradeId !== previous.tradeId) {
      if (
        trade.tradeId !== previous.tradeId + 1 ||
        trade.eventTime - previous.eventTime > 120_000
      )
        start = index
    }
    previous = trade
  }
  const segment = rows.slice(start)
  const trades = segment
    .map(mapObservationToReplayTrade)
    .filter((trade) => trade !== null)
  if (
    trades.length < 120 ||
    trades.at(-1)!.eventTime - trades[0]!.eventTime < 2 * 3_600_000
  ) {
    throw new Error(
      'The latest contiguous Kraken window has fewer than two hours of trades. Wait for more clean data or choose an explicit --since/--until window.',
    )
  }
  return segment
}

export type { FrozenReplayDataset }

/**
 * Build the trade-simulation input for one horizon: closed 1m bars split
 * at the same time cut as the scored selection/validation slices, one
 * signal stream per candidate, and the shared outcome-label stream the
 * momentum baseline repeats.
 */
function profitabilityInputFor(args: {
  readonly candles: FrozenReplayDataset['candles']
  readonly cutTimestamp: TimestampMs
  readonly scored: readonly SimulationScoredEntry[]
  readonly signalsByCandidate: Readonly<Record<string, TradeSimSignal[]>>
  readonly startingCash: number
  readonly entryThreshold: number
  readonly exitThreshold: number
  readonly horizon: ForecastHorizon
}): SimulationProfitabilityInput {
  const toBar = (
    candle: FrozenReplayDataset['candles'][number],
  ): TradeSimBar => ({
    time: candle.bucketEnd,
    open: candle.open,
    close: candle.close,
  })
  const selectionBars = args.candles
    .filter((candle) => candle.bucketEnd < args.cutTimestamp)
    .map(toBar)
  const validationBars = args.candles
    .filter((candle) => candle.bucketEnd >= args.cutTimestamp)
    .map(toBar)
  const outcomeLabelsByTime: Record<number, ForecastOutcomeLabel> = {}
  for (const entry of args.scored) {
    // A historical outcome is not observable at forecast creation time.
    const availableAt = entry.asOfTimestamp + HORIZON_MS[args.horizon]
    outcomeLabelsByTime[availableAt] ??= entry.outcome.label
  }
  return {
    selectionBars,
    validationBars,
    signalsByCandidate: args.signalsByCandidate,
    candidateThresholds: Object.fromEntries(
      SIMULATION_CANDIDATES.filter(
        (candidate) =>
          candidate.entryThreshold !== undefined &&
          candidate.exitThreshold !== undefined,
      ).map((candidate) => [
        candidate.candidateId,
        {
          entry: candidate.entryThreshold!,
          exit: candidate.exitThreshold!,
        },
      ]),
    ),
    outcomeLabelsByTime,
    startingCash: args.startingCash,
    entryThreshold: args.entryThreshold,
    exitUpThreshold: args.exitThreshold,
    exitDownThreshold: DEFAULT_EXIT_DOWN_THRESHOLD,
    costs: { ...DEFAULT_TRADE_COSTS },
  }
}
