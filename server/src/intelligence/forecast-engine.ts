import {
  type DataFreshness,
  type ForecastRecord,
  type ForecastHorizon,
  type ForecastSourceMode,
  type GapMetrics,
  type NewsEvidenceReference,
  type TechnicalFeatureSnapshot,
  type TimestampMs,
} from './contracts.ts'
import { contentHashFor } from './forecast-hashing.ts'
import { assertKnownSimulationRule } from './simulations/candidate-manifest.ts'
import {
  simulationRule,
  type SimulationRuleConfig,
} from './simulations/rule-registry.ts'

export const FORECAST_MODEL_VERSION = 'deterministic-baseline.v1'
export const FORECAST_RULE_VERSION = 'technical-direction.v1'

const ABSTENTION_PROBABILITY = 1 / 3
const REQUIRED_FEATURES = [
  'sma',
  'rsi',
  'macdHistogram',
  'structuralSlope',
] as const

export interface ForecastCandleEvidence {
  readonly eventTimeEnd: TimestampMs
  readonly bucketEnd: TimestampMs
  readonly close: number
  readonly isClosed: boolean
  readonly status: 'live' | 'stale' | 'invalid' | 'gap'
}

export interface ForecastEngineInput {
  readonly id: string
  readonly version: string
  readonly createdAt: TimestampMs
  readonly asOfTimestamp: TimestampMs
  readonly eventCutoff: TimestampMs
  readonly horizon: ForecastHorizon
  readonly referencePrice: number
  readonly candles: readonly ForecastCandleEvidence[]
  readonly technicalFeatureSnapshot: TechnicalFeatureSnapshot
  readonly dataFreshness: DataFreshness
  readonly dataGaps: GapMetrics
  readonly newsEvidenceReferences: readonly NewsEvidenceReference[]
  readonly sourceMode?: ForecastSourceMode
  readonly replayRunId?: string | null
  /**
   * Additive simulation dispatch. Absent on the production path, which keeps
   * the hard-coded rule version and probability mapping exactly as before.
   * When present, both fields are required and the version must be
   * pre-registered in the simulations manifest.
   */
  readonly ruleVersion?: string
  readonly ruleConfig?: SimulationRuleConfig
}

export function generateForecast(input: ForecastEngineInput): ForecastRecord {
  const safeNews = input.newsEvidenceReferences.filter(
    (reference) => reference.ingestedAt <= input.eventCutoff,
  )
  const futureNews = safeNews.length !== input.newsEvidenceReferences.length
  const eligibleCandles = input.candles.filter(
    (candle) =>
      candle.isClosed &&
      candle.bucketEnd <= input.eventCutoff &&
      candle.eventTimeEnd <= input.eventCutoff,
  )
  const sourceMode: ForecastSourceMode = input.sourceMode ?? 'shadow_live'
  const replayRunId =
    sourceMode === 'historical_replay' ? (input.replayRunId ?? null) : null
  const dispatchRule =
    input.ruleVersion !== undefined || input.ruleConfig !== undefined
  if (
    dispatchRule &&
    (input.ruleVersion === undefined || input.ruleConfig === undefined)
  )
    throw new Error(
      'Simulation rule dispatch requires both ruleVersion and ruleConfig.',
    )
  if (input.ruleVersion !== undefined)
    assertKnownSimulationRule(input.ruleVersion)
  const ruleVersion = input.ruleVersion ?? FORECAST_RULE_VERSION

  const engineAbstention = futureNews
    ? 'future_news_evidence'
    : determineAbstentionReason(input, eligibleCandles)
  let abstentionReason = engineAbstention
  let probabilities: {
    readonly up: number
    readonly down: number
    readonly flat: number
  }
  if (abstentionReason !== undefined) {
    probabilities = neutralProbabilities()
  } else if (input.ruleConfig === undefined) {
    probabilities = probabilitiesForFeatures(
      input.referencePrice,
      input.technicalFeatureSnapshot,
    )
  } else {
    const ruleOutput = simulationRule(
      input.referencePrice,
      input.technicalFeatureSnapshot,
      input.ruleConfig,
    )
    if (ruleOutput.abstentionReason !== undefined) {
      abstentionReason = ruleOutput.abstentionReason
      probabilities = neutralProbabilities()
    } else {
      probabilities = {
        up: ruleOutput.up,
        down: ruleOutput.down,
        flat: ruleOutput.flat,
      }
    }
  }
  const abstained = abstentionReason !== undefined
  const withoutHash: Omit<ForecastRecord, 'contentHash'> = {
    id: input.id,
    version: input.version,
    instrumentId: 'BTC-EUR',
    createdAt: input.createdAt,
    asOfTimestamp: input.asOfTimestamp,
    eventCutoff: input.eventCutoff,
    horizon: input.horizon,
    referencePrice: input.referencePrice,
    probabilityUp: probabilities.up,
    probabilityDown: probabilities.down,
    probabilityFlat: probabilities.flat,
    technicalFeatureSnapshot: input.technicalFeatureSnapshot,
    newsEvidenceReferences: safeNews,
    dataFreshness: input.dataFreshness,
    dataGaps: input.dataGaps,
    modelVersion: FORECAST_MODEL_VERSION,
    ruleVersion,
    sourceMode,
    replayRunId,
    abstained,
    ...(abstentionReason === undefined ? {} : { abstentionReason }),
  }
  return {
    ...withoutHash,
    contentHash: contentHashFor(withoutHash),
  }
}

function determineAbstentionReason(
  input: ForecastEngineInput,
  eligibleCandles: readonly ForecastCandleEvidence[],
): string | undefined {
  if (input.asOfTimestamp !== input.eventCutoff) return 'cutoff_mismatch'
  if (input.createdAt < input.eventCutoff) return 'created_before_cutoff'
  if (!Number.isFinite(input.referencePrice) || input.referencePrice <= 0)
    return 'invalid_reference_price'
  if (eligibleCandles.length === 0) return 'missing_closed_candle'
  const latestCandle = [...eligibleCandles].sort(
    (left, right) => right.eventTimeEnd - left.eventTimeEnd,
  )[0]
  if (latestCandle !== undefined && latestCandle.close !== input.referencePrice)
    return 'reference_price_mismatch'
  if (!input.technicalFeatureSnapshot.isClosed) return 'open_feature_snapshot'
  if (!input.technicalFeatureSnapshot.ready) return 'warmup_incomplete'
  if (input.technicalFeatureSnapshot.warmUp.missingCandles > 0)
    return 'warmup_incomplete'
  if (input.technicalFeatureSnapshot.asOfTimestamp > input.eventCutoff)
    return 'future_feature_snapshot'
  if (
    !Number.isFinite(input.dataFreshness.ageMs) ||
    input.dataFreshness.ageMs < 0
  )
    return 'invalid_freshness'
  if (input.dataFreshness.isStale || input.dataFreshness.clockInverted)
    return 'stale_or_inverted_freshness'
  if (
    input.dataGaps.gapCount > 0 ||
    (input.dataGaps.rate !== null && input.dataGaps.rate > 0)
  )
    return 'market_gaps'
  if (!input.dataGaps.sequenceAvailable) return 'gap_metrics_unavailable'
  if (eligibleCandles.some((candle) => candle.status !== 'live'))
    return 'unreliable_candle_status'
  if (
    REQUIRED_FEATURES.some(
      (key) => !Number.isFinite(input.technicalFeatureSnapshot.values[key]),
    )
  )
    return 'unreliable_features'
  return undefined
}

function probabilitiesForFeatures(
  referencePrice: number,
  snapshot: TechnicalFeatureSnapshot,
): { readonly up: number; readonly down: number; readonly flat: number } {
  const values = snapshot.values
  let score = 0
  score += referencePrice > values.sma ? 1 : -1
  score += values.rsi > 55 ? 1 : values.rsi < 45 ? -1 : 0
  score += values.macdHistogram > 0 ? 1 : values.macdHistogram < 0 ? -1 : 0
  score += values.structuralSlope > 0 ? 1 : values.structuralSlope < 0 ? -1 : 0
  if (score === 0) return { up: 0.3, down: 0.3, flat: 0.4 }
  const strength = Math.min(Math.abs(score) / REQUIRED_FEATURES.length, 1)
  const winner = 0.45 + 0.1 * strength
  const loser = 0.25 - 0.05 * strength
  const flat = 1 - winner - loser
  return score > 0
    ? { up: winner, down: loser, flat }
    : { up: loser, down: winner, flat }
}

function neutralProbabilities(): {
  readonly up: number
  readonly down: number
  readonly flat: number
} {
  return {
    up: ABSTENTION_PROBABILITY,
    down: ABSTENTION_PROBABILITY,
    flat: ABSTENTION_PROBABILITY,
  }
}
