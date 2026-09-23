import type {
  ForecastHorizon,
  ForecastOutcome,
  ForecastRecord,
  TechnicalFeatureSnapshot,
  TimestampMs,
} from '../../domain/contracts.ts'
import { contentHashFor } from '../forecasts/forecast-hashing.ts'
import {
  generateForecast,
  type ForecastCandleEvidence,
  type ForecastEngineInput,
} from '../forecasts/forecast-engine.ts'
import {
  evaluateForecast,
  HORIZON_MS,
} from '../forecasts/forecast-evaluator.ts'
import type { MarketStore } from '../market-data/market-store.ts'
import {
  computeTechnicalFeatures,
  type TechnicalCandle,
} from '../technical-analysis/technical-features.ts'
import type {
  FrozenReplayDataset,
  ReplayDatasetCandle,
} from './replay-contracts.ts'
import { buildReplayReport, type ReplayReport } from './replay-report.ts'
import {
  ReplayRunError,
  createReplayCheckpoint,
  createReplayRunStart,
  type ReplayCheckpoint,
  type ReplayRunReference,
} from './replay-run.ts'
import type { ReplayRunStore } from './replay-run-store.ts'
import {
  candidateForId,
  type SimulationCandidate,
} from '../simulations/candidate-manifest.ts'
import { virtualClockFromDataset } from './replay-virtual-clock.ts'

const DEFAULT_REPLAY_HORIZON: ForecastHorizon = '15m'
const FORECAST_VERSION = '1'

export interface ReplayRunServiceOptions {
  /**
   * Forecasts and outcomes are persisted through this injected store. The
   * service never constructs a store itself, so it can never open the live
   * `server/data/market.sqlite` path on its own.
   */
  readonly store: MarketStore
  /**
   * Runs and checkpoints live in their own injected store, fully independent
   * from the live market database.
   */
  readonly runStore: ReplayRunStore
  /**
   * Wall clock used only for bookkeeping columns such as `created_at`. It is
   * never used for a forecast's domain `createdAt`: that always comes from the
   * virtual clock derived from closed candles.
   */
  readonly clock?: () => TimestampMs
}

export interface ReplayRunInput {
  readonly dataset: FrozenReplayDataset
  readonly horizon?: ForecastHorizon
  readonly runId?: string
  /**
   * Additive simulation wiring. Absent means the production default
   * candidate: params, rule version and forecast output stay exactly as
   * before. A manifest candidate id switches features and rule dispatch to
   * that candidate and is encoded in the default run id.
   */
  readonly candidateId?: string
}

export interface ReplayRunResult {
  readonly run: ReplayRunReference
  readonly checkpoints: readonly ReplayCheckpoint[]
  readonly forecasts: readonly ForecastRecord[]
  readonly outcomes: readonly ForecastOutcome[]
  readonly report: ReplayReport
}

interface PendingForecast {
  readonly forecast: ForecastRecord
  readonly dueAt: TimestampMs
  evaluated: boolean
}

export class ReplayRunService {
  private readonly store: MarketStore
  private readonly runStore: ReplayRunStore
  private readonly clock: () => TimestampMs

  constructor(options: ReplayRunServiceOptions) {
    this.store = options.store
    this.runStore = options.runStore
    this.clock = options.clock ?? (() => Date.now() as TimestampMs)
  }

  /**
   * Replay a frozen dataset candle by candle. Each closed candle becomes a
   * checkpoint that advances a monotonic virtual clock; forecasts are created
   * at that virtual instant and are evaluated by the existing evaluator once
   * their horizon has fully elapsed inside the same data.
   */
  run(input: ReplayRunInput): ReplayRunResult {
    const horizon = input.horizon ?? DEFAULT_REPLAY_HORIZON
    const candidate: SimulationCandidate | undefined =
      input.candidateId === undefined
        ? undefined
        : candidateForId(input.candidateId)
    const runId =
      input.runId ?? defaultReplayRunId(input.dataset, candidate?.candidateId)
    const start = createReplayRunStart({
      id: runId,
      dataset: input.dataset,
      horizon,
    })
    this.runStore.saveRun(start, this.clock())

    const virtualClock = virtualClockFromDataset(input.dataset)
    const forecasts: ForecastRecord[] = []
    const outcomes: ForecastOutcome[] = []
    const checkpoints: ReplayCheckpoint[] = []
    const pending: PendingForecast[] = []

    const candles = input.dataset.candles
    for (const [index, candle] of candles.entries()) {
      const now = virtualClock.advanceTo(candle.bucketEnd)

      for (const entry of pending) {
        if (entry.evaluated || now < entry.dueAt) continue
        const outcome = evaluateForecast(entry.forecast, {
          now,
          eventTime: candle.bucketEnd,
          price: candle.close,
          contentHash: replayCandleHash(candle),
          isClosed: true,
        })
        this.store.insertOutcome(outcome)
        outcomes.push(outcome)
        entry.evaluated = true
      }

      const forecast = this.generateAt({
        runId,
        horizon,
        now,
        candle,
        candlesUpTo: candles.slice(0, index + 1),
        dataset: input.dataset,
        candidate,
      })
      this.store.insertForecast(forecast)
      forecasts.push(forecast)
      pending.push({
        forecast,
        dueAt: (now + HORIZON_MS[horizon]) as TimestampMs,
        evaluated: false,
      })

      const checkpoint = createReplayCheckpoint({
        runId,
        index,
        candle,
        forecastId: forecast.id,
        forecastHash: forecast.contentHash,
        evaluatedOutcomeCount: outcomes.length,
      })
      this.runStore.saveCheckpoint(checkpoint, this.clock())
      checkpoints.push(checkpoint)
    }

    this.runStore.finalizeRun(runId, {
      status: 'completed',
      checkpointCount: checkpoints.length,
      forecastCount: forecasts.length,
      outcomeCount: outcomes.length,
    })
    const run = this.requireRun(runId)
    const report = buildReplayReport({ run, forecasts, outcomes })
    return { run, checkpoints, forecasts, outcomes, report }
  }

  buildReport(runId: string): ReplayReport {
    const run = this.requireRun(runId)
    const forecasts = this.store
      .listForecasts({ sourceMode: 'historical_replay' })
      .filter((forecast) => forecast.replayRunId === runId)
    const forecastKeys = new Set(
      forecasts.map((forecast) => `${forecast.id}:${forecast.version}`),
    )
    const outcomes = this.store
      .listOutcomes()
      .filter((outcome) =>
        forecastKeys.has(`${outcome.forecastId}:${outcome.forecastVersion}`),
      )
    return buildReplayReport({ run, forecasts, outcomes })
  }

  getRun(runId: string): ReplayRunReference | undefined {
    return this.runStore.getRun(runId)
  }

  private requireRun(runId: string): ReplayRunReference {
    const run = this.runStore.getRun(runId)
    if (run === undefined)
      throw new ReplayRunError(`No replay run exists for id ${runId}.`)
    return run
  }

  private generateAt(args: {
    readonly runId: string
    readonly horizon: ForecastHorizon
    readonly now: TimestampMs
    readonly candle: ReplayDatasetCandle
    readonly candlesUpTo: readonly ReplayDatasetCandle[]
    readonly dataset: FrozenReplayDataset
    readonly candidate?: SimulationCandidate
  }): ForecastRecord {
    const features = computeTechnicalFeatures({
      candles: args.candlesUpTo.map(toTechnicalCandle),
      asOfTimestamp: args.candle.bucketEnd,
      // Additive lineage: the default path passes no params (exactly as
      // before); a manifest candidate injects its pre-registered periods.
      ...(args.candidate === undefined
        ? {}
        : { params: args.candidate.params }),
    })
    const snapshot: TechnicalFeatureSnapshot = {
      version: features.technicalFeatureVersion,
      asOfTimestamp: features.asOfTimestamp,
      isClosed: true,
      ready: features.ready,
      warmUp: features.warmUp,
      values: features.values,
      // Additive lineage only: absent on the default path so existing
      // records and tests are untouched.
      ...(args.candidate === undefined
        ? {}
        : { paramSetVersion: args.candidate.paramSetVersion }),
    }
    const engineInput: ForecastEngineInput = {
      id: `${args.runId}:${args.candle.bucketEnd}`,
      version: FORECAST_VERSION,
      createdAt: args.now,
      asOfTimestamp: args.now,
      eventCutoff: args.now,
      horizon: args.horizon,
      referencePrice: args.candle.close,
      candles: args.candlesUpTo.map(toForecastCandle),
      technicalFeatureSnapshot: snapshot,
      dataFreshness: {
        ageMs: Math.max(0, args.now - args.candle.eventTimeEnd),
        isStale: false,
        clockInverted: false,
      },
      dataGaps: gapMetricsFor(args.dataset),
      newsEvidenceReferences: [],
      sourceMode: 'historical_replay',
      replayRunId: args.runId,
      // Additive dispatch: absent on the default path.
      ...(args.candidate === undefined
        ? {}
        : {
            ruleVersion: args.candidate.ruleVersion,
            ruleConfig: args.candidate.rule,
          }),
    }
    return generateForecast(engineInput)
  }
}

function defaultReplayRunId(
  dataset: FrozenReplayDataset,
  candidateId?: string,
): string {
  const base = `replay:${dataset.importVersion}:${dataset.datasetHash.slice(0, 16)}`
  return candidateId === undefined ? base : `${base}:${candidateId}`
}

function toForecastCandle(candle: ReplayDatasetCandle): ForecastCandleEvidence {
  return {
    eventTimeEnd: candle.eventTimeEnd,
    bucketEnd: candle.bucketEnd,
    close: candle.close,
    isClosed: candle.isClosed,
    status: 'live',
  }
}

function toTechnicalCandle(candle: ReplayDatasetCandle): TechnicalCandle {
  return {
    interval: candle.interval,
    bucketStart: candle.bucketStart,
    bucketEnd: candle.bucketEnd,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume,
    eventTimeStart: candle.eventTimeStart,
    eventTimeEnd: candle.eventTimeEnd,
    receivedTimeStart: candle.eventTimeStart,
    receivedTimeEnd: candle.eventTimeEnd,
    displayTimeStart: candle.eventTimeStart,
    displayTimeEnd: candle.eventTimeEnd,
    freshnessAgeMs: 0,
    freshnessIsStale: false,
    freshnessClockInverted: false,
    status: 'live',
    source: 'kraken',
    instrumentId: 'BTC-EUR',
    observationCount: candle.tradeCount,
    isClosed: true,
  }
}

/**
 * Canonical hash of a frozen candle. It deliberately excludes local receive
 * and detection timestamps so the same candle hashes identically across runs
 * and across wall clocks.
 */
export function replayCandleHash(candle: ReplayDatasetCandle): string {
  return contentHashFor({
    interval: candle.interval,
    bucketStart: candle.bucketStart,
    bucketEnd: candle.bucketEnd,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume,
    tradeCount: candle.tradeCount,
    firstTradeId: candle.firstTradeId,
    lastTradeId: candle.lastTradeId,
    eventTimeStart: candle.eventTimeStart,
    eventTimeEnd: candle.eventTimeEnd,
  })
}

function gapMetricsFor(dataset: FrozenReplayDataset) {
  const unresolved = dataset.gapEvidence.filter((gap) => !gap.resolved).length
  const expected = dataset.candles.length
  return {
    gapCount: unresolved,
    expectedOpportunities: expected,
    rate: unresolved === 0 ? 0 : unresolved / expected,
    sequenceAvailable: true,
  }
}
