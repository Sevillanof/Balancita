import {
  type DataFreshness,
  type ForecastHorizon,
  type ForecastOutcome,
  type ForecastRecord,
  type GapMetrics,
  type TechnicalFeatureSnapshot,
  type TimestampMs,
} from '../../domain/contracts.ts'
import { contentHashFor } from './forecast-hashing.ts'
import {
  generateForecast,
  type ForecastCandleEvidence,
  type ForecastEngineInput,
} from './forecast-engine.ts'
import { evaluateForecast, HORIZON_MS } from './forecast-evaluator.ts'
import {
  buildIntradayCandles,
  INTERVAL_MS,
  type CandleInterval,
  type IntradayCandle,
} from '../market-data/intraday-candles.ts'
import { KRAKEN_MARKET_SOURCE } from '../market-data/market-sources.ts'
import type {
  MarketStore,
  StoredMarketObservation,
} from '../market-data/market-store.ts'
import { computeTechnicalFeatures } from '../technical-analysis/technical-features.ts'

const DEFAULT_INTERVAL: CandleInterval = '15m'
const DEFAULT_HORIZON: ForecastHorizon = '15m'
const FORECAST_VERSION = '1'
const DEFAULT_MAX_CANDLES = 500

export interface LiveForecastServiceOptions {
  /**
   * Forecasts and outcomes are persisted through this injected store. The
   * service never constructs a store itself, so it can never open the live
   * `server/data/market.sqlite` path on its own.
   */
  readonly store: MarketStore
  readonly instrumentId: 'BTC-EUR'
  readonly interval?: CandleInterval
  readonly horizon?: ForecastHorizon
  readonly clock?: () => TimestampMs
  readonly maxCandles?: number
}

export type LiveForecastOutcomeKind =
  'generated' | 'duplicate' | 'no_closed_candle'

export interface LiveForecastRunResult {
  readonly outcome: LiveForecastOutcomeKind
  readonly forecastId: string | null
  readonly forecastAbstained: boolean | null
  readonly evaluatedOutcomeCount: number
}

export class LiveForecastService {
  private readonly store: MarketStore
  private readonly instrumentId: 'BTC-EUR'
  private readonly interval: CandleInterval
  private readonly horizon: ForecastHorizon
  private readonly clock: () => TimestampMs
  private readonly maxCandles: number

  constructor(options: LiveForecastServiceOptions) {
    this.store = options.store
    this.instrumentId = options.instrumentId
    this.interval = options.interval ?? DEFAULT_INTERVAL
    this.horizon = options.horizon ?? DEFAULT_HORIZON
    this.clock = options.clock ?? (() => Date.now() as TimestampMs)
    this.maxCandles = options.maxCandles ?? DEFAULT_MAX_CANDLES
  }

  /**
   * Produce at most one forecast for the latest closed candle and evaluate any
   * pending shadow-live forecast whose horizon has elapsed. Only fresh
   * observations from the current source feed the live candle, and only
   * `shadow_live` forecasts are considered for evaluation.
   */
  runOnce(now: TimestampMs = this.clock()): LiveForecastRunResult {
    const observations = this.freshObservations()
    const gapMetrics = this.gapMetricsFor(observations, now)
    const build = buildIntradayCandles({
      interval: this.interval,
      asOfTimestamp: now,
      observations,
      gapMetrics,
    })
    const latest = latestClosedCandle(build.closed)
    if (latest === null)
      return {
        outcome: 'no_closed_candle',
        forecastId: null,
        forecastAbstained: null,
        evaluatedOutcomeCount: 0,
      }

    const forecastId = this.forecastIdFor(latest)
    const existing = this.store.getForecast(forecastId, FORECAST_VERSION)
    let outcomeKind: LiveForecastOutcomeKind = 'duplicate'
    let forecastAbstained: boolean | null = existing?.abstained ?? null
    if (existing === null) {
      const forecast = this.generateAt(now, latest, build.closed, gapMetrics)
      this.store.insertForecast(forecast)
      outcomeKind = 'generated'
      forecastAbstained = forecast.abstained
    }

    const evaluatedOutcomeCount = this.evaluatePending(now, build.closed)
    return {
      outcome: outcomeKind,
      forecastId,
      forecastAbstained,
      evaluatedOutcomeCount,
    }
  }

  private freshObservations(): readonly StoredMarketObservation[] {
    return this.store
      .listObservations()
      .filter(
        (observation) =>
          observation.instrumentId === this.instrumentId &&
          observation.source === KRAKEN_MARKET_SOURCE &&
          observation.status === 'live',
      )
  }

  private forecastIdFor(candle: IntradayCandle): string {
    return `shadow:${this.instrumentId}:${candle.bucketEnd}`
  }

  private generateAt(
    now: TimestampMs,
    latest: IntradayCandle,
    closed: readonly IntradayCandle[],
    gapMetrics: GapMetrics,
  ): ForecastRecord {
    const candles = closed.slice(-this.maxCandles)
    const features = computeTechnicalFeatures({
      candles,
      asOfTimestamp: latest.bucketEnd,
    })
    const snapshot: TechnicalFeatureSnapshot = {
      version: features.technicalFeatureVersion,
      asOfTimestamp: features.asOfTimestamp,
      isClosed: true,
      ready: features.ready,
      warmUp: features.warmUp,
      values: features.values,
    }
    const input: ForecastEngineInput = {
      id: this.forecastIdFor(latest),
      version: FORECAST_VERSION,
      createdAt: now,
      asOfTimestamp: now,
      eventCutoff: now,
      horizon: this.horizon,
      referencePrice: latest.close,
      candles: candles.map(toForecastCandle),
      technicalFeatureSnapshot: snapshot,
      dataFreshness: freshnessFrom(now, latest),
      dataGaps: gapMetrics,
      newsEvidenceReferences: [],
      sourceMode: 'shadow_live',
      replayRunId: null,
    }
    return generateForecast(input)
  }

  private evaluatePending(
    now: TimestampMs,
    closed: readonly IntradayCandle[],
  ): number {
    const forecasts = this.store.listForecasts({
      instrumentId: this.instrumentId,
      sourceMode: 'shadow_live',
    })
    const evaluated = new Set(
      this.store
        .listOutcomes()
        .map((outcome) => `${outcome.forecastId}:${outcome.forecastVersion}`),
    )
    let count = 0
    for (const forecast of forecasts) {
      const key = `${forecast.id}:${forecast.version}`
      if (evaluated.has(key)) continue
      const dueAt = (forecast.asOfTimestamp +
        HORIZON_MS[forecast.horizon]) as TimestampMs
      if (now < dueAt) continue
      const candle = latestClosedCandle(
        closed.filter((item) => item.bucketEnd >= dueAt),
      )
      if (candle === null) continue
      const outcome: ForecastOutcome = evaluateForecast(forecast, {
        now,
        eventTime: candle.bucketEnd,
        price: candle.close,
        contentHash: liveCandleHash(candle),
        isClosed: true,
      })
      this.store.insertOutcome(outcome)
      evaluated.add(key)
      count += 1
    }
    return count
  }

  private gapMetricsFor(
    observations: readonly StoredMarketObservation[],
    now: TimestampMs,
  ): GapMetrics {
    if (observations.length === 0)
      return {
        gapCount: 0,
        expectedOpportunities: 0,
        rate: null,
        sequenceAvailable: true,
      }
    const windowStart = Math.min(
      ...observations.map((observation) => observation.eventTime),
    ) as TimestampMs
    // Scope gaps to the current source and the live observation window. The
    // store keeps an all-time ledger; feeding that to the engine would abstain
    // every forecast with `market_gaps`.
    const gaps = this.store
      .listGaps()
      .filter(
        (gap) =>
          gap.source === KRAKEN_MARKET_SOURCE &&
          gap.instrumentId === this.instrumentId &&
          gap.detectedAt >= windowStart &&
          gap.detectedAt <= now,
      )
    const expectedOpportunities = new Set(
      observations.map((observation) =>
        Math.floor(observation.eventTime / INTERVAL_MS[this.interval]),
      ),
    ).size
    return {
      gapCount: gaps.length,
      expectedOpportunities,
      rate:
        gaps.length === 0
          ? 0
          : expectedOpportunities === 0
            ? null
            : gaps.length / expectedOpportunities,
      sequenceAvailable: observations.every(
        (observation) => observation.sequence !== undefined,
      ),
    }
  }
}

function latestClosedCandle(
  candles: readonly IntradayCandle[],
): IntradayCandle | null {
  let latest: IntradayCandle | null = null
  for (const candle of candles) {
    if (latest === null || candle.bucketEnd > latest.bucketEnd) latest = candle
  }
  return latest
}

function freshnessFrom(
  now: TimestampMs,
  candle: IntradayCandle,
): DataFreshness {
  return {
    ageMs: Math.max(0, now - candle.eventTimeEnd),
    isStale: candle.freshnessIsStale,
    clockInverted: candle.freshnessClockInverted,
  }
}

function toForecastCandle(candle: IntradayCandle): ForecastCandleEvidence {
  return {
    eventTimeEnd: candle.eventTimeEnd,
    bucketEnd: candle.bucketEnd,
    close: candle.close,
    isClosed: candle.isClosed,
    status: candle.status,
  }
}

/**
 * Canonical hash of a live candle. It deliberately excludes local receive and
 * detection timestamps so the same candle hashes identically regardless of the
 * wall clock that observed it.
 */
function liveCandleHash(candle: IntradayCandle): string {
  return contentHashFor({
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
    observationCount: candle.observationCount,
  })
}
