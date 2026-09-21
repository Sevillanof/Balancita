import type { ForecastHorizon } from './contracts.ts'
import { contentHashFor } from './forecast-hashing.ts'
import type {
  ComparisonDirection,
  DirectionalProbabilities,
} from './comparison.ts'

export const COMPARISON_METRICS_VERSION = 'comparison-metrics.v1' as const
export const NEUTRAL_BASELINE_RULE_VERSION = 'neutral-baseline.v1' as const

export interface EvaluatedSignal {
  readonly status: 'scored' | 'abstain'
  readonly probabilities?: DirectionalProbabilities
  readonly expectedReturn?: number
  readonly expectedRange?: { readonly lower: number; readonly upper: number }
  readonly abstentionReasons?: readonly string[]
}

export interface ComparativeMetricEntry {
  readonly horizon: ForecastHorizon
  readonly regime?: string
  readonly technical: EvaluatedSignal | null
  readonly news: EvaluatedSignal | null
  readonly outcome: {
    readonly label: 'up' | 'down' | 'flat'
    readonly realizedReturn: number
    readonly observedPrice?: number
  }
}

export interface CoverageMetrics {
  readonly total: number
  readonly issued: number
  readonly abstained: number
  readonly coverage: number | null
  readonly abstentionRate: number | null
}

export interface ComparisonCounts {
  readonly total: number
  readonly agreement: number
  readonly disagreement: number
  readonly abstention: number
  readonly agreementRate: number | null
  readonly disagreementRate: number | null
  readonly abstentionRate: number | null
}

export interface CalibrationBand {
  readonly lowerInclusive: number
  readonly upperExclusive: number
  readonly count: number
  readonly meanPredictedProbability: number | null
  readonly observedFrequency: number | null
}

export interface SourceComparativeMetrics {
  readonly coverage: CoverageMetrics
  readonly directionalAccuracy: number | null
  readonly brierScore: number | null
  readonly logLoss: number | null
  readonly calibration: readonly CalibrationBand[]
  readonly returnMae: number | null
  readonly rangeMae: number | null
  readonly incrementalVsNeutral: {
    readonly brierScoreDelta: number | null
    readonly logLossDelta: number | null
    readonly returnMaeDelta: number | null
    readonly rangeMaeDelta: number | null
  }
}

export interface ComparativeMetricsSegment {
  readonly key: string
  readonly horizon: ForecastHorizon
  readonly regime?: string
  readonly coverage: ComparisonCounts
  readonly sources: {
    readonly technical: SourceComparativeMetrics
    readonly news: SourceComparativeMetrics
  }
  readonly baselineNeutral: SourceComparativeMetrics
}

export interface ComparativeMetricsReport {
  readonly version: typeof COMPARISON_METRICS_VERSION
  readonly ruleVersion: typeof NEUTRAL_BASELINE_RULE_VERSION
  readonly coverage: ComparisonCounts
  readonly sources: {
    readonly technical: SourceComparativeMetrics
    readonly news: SourceComparativeMetrics
  }
  readonly baselineNeutral: SourceComparativeMetrics
  readonly segments: readonly ComparativeMetricsSegment[]
  readonly limitations: readonly string[]
  readonly contentHash: string
}

const DEFAULT_CALIBRATION_BANDS: readonly Omit<
  CalibrationBand,
  'count' | 'meanPredictedProbability' | 'observedFrequency'
>[] = [
  { lowerInclusive: 0, upperExclusive: 0.5 },
  { lowerInclusive: 0.5, upperExclusive: 0.7 },
  { lowerInclusive: 0.7, upperExclusive: 1.01 },
]

export function calculateComparativeMetrics(
  entries: readonly ComparativeMetricEntry[],
): ComparativeMetricsReport {
  entries.forEach(validateEntry)
  const technical = calculateSourceMetrics(entries, 'technical')
  const news = calculateSourceMetrics(entries, 'news')
  const baselineNeutral = calculateSourceMetrics(
    entries.map((entry) => ({
      ...entry,
      technical: neutralSignal(),
      news: neutralSignal(),
    })),
    'technical',
  )
  const reportWithoutHash = {
    version: COMPARISON_METRICS_VERSION,
    ruleVersion: NEUTRAL_BASELINE_RULE_VERSION,
    coverage: calculateComparisonCounts(entries),
    sources: {
      technical: withIncremental(technical, baselineNeutral),
      news: withIncremental(
        news,
        calculateSourceMetrics(
          entries.map((entry) => ({
            ...entry,
            technical: neutralSignal(),
            news: neutralSignal(),
          })),
          'news',
        ),
      ),
    },
    baselineNeutral,
    segments: segmentsFor(entries),
    limitations: [
      'Descriptive comparison only; it does not establish profitability.',
      'Association between a source score and an outcome is not causal evidence.',
      'No random backtest or random train/test split is performed.',
      'Metrics are meaningful only for outcomes evaluated after their valid horizon.',
    ],
  }
  return {
    ...reportWithoutHash,
    contentHash: contentHashFor(reportWithoutHash),
  }
}

function calculateSourceMetrics(
  entries: readonly ComparativeMetricEntry[],
  source: 'technical' | 'news',
): SourceComparativeMetrics {
  const selected = entries.map((entry) => ({
    entry,
    signal: entry[source],
  }))
  const issued = selected.filter(
    (candidate): candidate is typeof candidate & { signal: EvaluatedSignal } =>
      candidate.signal?.status === 'scored',
  )
  const coverage: CoverageMetrics = {
    total: entries.length,
    issued: issued.length,
    abstained: entries.length - issued.length,
    coverage: entries.length === 0 ? null : issued.length / entries.length,
    abstentionRate:
      entries.length === 0
        ? null
        : (entries.length - issued.length) / entries.length,
  }
  const brierScore = meanOrNull(
    issued.map(({ signal, entry }) => {
      const probabilities = requireProbabilities(signal)
      const target = oneHot(entry.outcome.label)
      return (
        (probabilities.probabilityUp - target[0]) ** 2 +
        (probabilities.probabilityDown - target[1]) ** 2 +
        (probabilities.probabilityFlat - target[2]) ** 2
      )
    }),
  )
  const logLoss = meanOrNull(
    issued.map(({ signal, entry }) => {
      const probabilities = requireProbabilities(signal)
      const targetProbability =
        entry.outcome.label === 'up'
          ? probabilities.probabilityUp
          : entry.outcome.label === 'down'
            ? probabilities.probabilityDown
            : probabilities.probabilityFlat
      return -Math.log(Math.max(targetProbability, Number.MIN_VALUE))
    }),
  )
  const returnCandidates = issued.filter(
    ({ signal }) => signal.expectedReturn !== undefined,
  )
  const rangeCandidates = issued.filter(
    ({ signal, entry }) =>
      signal.expectedRange !== undefined &&
      entry.outcome.observedPrice !== undefined,
  )
  const returnMae = meanOrNull(
    returnCandidates.map(({ signal, entry }) =>
      Math.abs(entry.outcome.realizedReturn - signal.expectedReturn!),
    ),
  )
  const rangeMae = meanOrNull(
    rangeCandidates.map(({ signal, entry }) => {
      const range = signal.expectedRange!
      const price = entry.outcome.observedPrice!
      if (price < range.lower) return range.lower - price
      if (price > range.upper) return price - range.upper
      return 0
    }),
  )
  return {
    coverage,
    directionalAccuracy: meanOrNull(
      issued.map(({ signal, entry }) =>
        predictedDirection(requireProbabilities(signal)) === entry.outcome.label
          ? 1
          : 0,
      ),
    ),
    brierScore,
    logLoss,
    calibration: calibrationFor(issued),
    returnMae,
    rangeMae,
    incrementalVsNeutral: {
      brierScoreDelta: null,
      logLossDelta: null,
      returnMaeDelta: null,
      rangeMaeDelta: null,
    },
  }
}

function withIncremental(
  metrics: SourceComparativeMetrics,
  neutral: SourceComparativeMetrics,
): SourceComparativeMetrics {
  return {
    ...metrics,
    incrementalVsNeutral: {
      brierScoreDelta: delta(metrics.brierScore, neutral.brierScore),
      logLossDelta: delta(metrics.logLoss, neutral.logLoss),
      returnMaeDelta: delta(metrics.returnMae, neutral.returnMae),
      rangeMaeDelta: delta(metrics.rangeMae, neutral.rangeMae),
    },
  }
}

function segmentsFor(
  entries: readonly ComparativeMetricEntry[],
): readonly ComparativeMetricsSegment[] {
  const grouped = new Map<string, ComparativeMetricEntry[]>()
  for (const entry of entries) {
    const key = segmentKey(entry)
    const current = grouped.get(key) ?? []
    current.push(entry)
    grouped.set(key, current)
  }
  return [...grouped.entries()].map(([key, segmentEntries]) => {
    const first = segmentEntries[0]!
    const technical = calculateSourceMetrics(segmentEntries, 'technical')
    const news = calculateSourceMetrics(segmentEntries, 'news')
    const neutral = calculateSourceMetrics(
      segmentEntries.map((entry) => ({
        ...entry,
        technical: neutralSignal(),
        news: neutralSignal(),
      })),
      'technical',
    )
    return {
      key,
      horizon: first.horizon,
      ...(first.regime === undefined ? {} : { regime: first.regime }),
      coverage: calculateComparisonCounts(segmentEntries),
      sources: {
        technical: withIncremental(technical, neutral),
        news: withIncremental(
          news,
          calculateSourceMetrics(
            segmentEntries.map((entry) => ({
              ...entry,
              technical: neutralSignal(),
              news: neutralSignal(),
            })),
            'news',
          ),
        ),
      },
      baselineNeutral: neutral,
    }
  })
}

function calculateComparisonCounts(
  entries: readonly ComparativeMetricEntry[],
): ComparisonCounts {
  let agreement = 0
  let disagreement = 0
  let abstention = 0
  entries.forEach((entry) => {
    const technical = scoredDirection(entry.technical)
    const news = scoredDirection(entry.news)
    if (technical === null || news === null) abstention += 1
    else if (technical === news) agreement += 1
    else disagreement += 1
  })
  return {
    total: entries.length,
    agreement,
    disagreement,
    abstention,
    agreementRate: entries.length === 0 ? null : agreement / entries.length,
    disagreementRate:
      entries.length === 0 ? null : disagreement / entries.length,
    abstentionRate: entries.length === 0 ? null : abstention / entries.length,
  }
}

function calibrationFor(
  entries: readonly {
    signal: EvaluatedSignal
    entry: ComparativeMetricEntry
  }[],
): readonly CalibrationBand[] {
  return DEFAULT_CALIBRATION_BANDS.map((definition) => {
    const selected = entries.filter(({ signal, entry }) => {
      const confidence = Math.max(
        ...Object.values(requireProbabilities(signal)),
      )
      return (
        confidence >= definition.lowerInclusive &&
        confidence < definition.upperExclusive &&
        predictedDirection(requireProbabilities(signal)) === entry.outcome.label
      )
    })
    const allInBand = entries.filter(({ signal }) => {
      const confidence = Math.max(
        ...Object.values(requireProbabilities(signal)),
      )
      return (
        confidence >= definition.lowerInclusive &&
        confidence < definition.upperExclusive
      )
    })
    return {
      ...definition,
      count: allInBand.length,
      meanPredictedProbability: meanOrNull(
        allInBand.map(({ signal }) =>
          Math.max(...Object.values(requireProbabilities(signal))),
        ),
      ),
      observedFrequency:
        allInBand.length === 0 ? null : selected.length / allInBand.length,
    }
  })
}

function validateEntry(entry: ComparativeMetricEntry): void {
  if (!Number.isFinite(entry.outcome.realizedReturn))
    throw new Error('Outcome realized return must be finite.')
  for (const signal of [entry.technical, entry.news]) {
    if (signal === null) continue
    if (signal.status === 'scored') {
      requireProbabilities(signal)
      if (
        signal.expectedReturn !== undefined &&
        !Number.isFinite(signal.expectedReturn)
      )
        throw new Error('Expected return must be finite.')
      if (signal.expectedRange !== undefined) {
        if (
          !Number.isFinite(signal.expectedRange.lower) ||
          !Number.isFinite(signal.expectedRange.upper) ||
          signal.expectedRange.lower > signal.expectedRange.upper
        )
          throw new Error('Expected range must be finite and ordered.')
      }
    } else if (signal.probabilities !== undefined) {
      throw new Error('Abstained signals cannot provide probabilities.')
    }
  }
}

function requireProbabilities(
  signal: EvaluatedSignal,
): DirectionalProbabilities {
  if (signal.probabilities === undefined)
    throw new Error('Scored signals require probabilities.')
  const probabilities = signal.probabilities
  const values = Object.values(probabilities)
  if (
    values.some((value) => !Number.isFinite(value) || value < 0 || value > 1) ||
    Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) > 1e-9
  )
    throw new Error(
      'Scored signal probabilities must be finite and sum to one.',
    )
  return probabilities
}

function predictedDirection(
  probabilities: DirectionalProbabilities,
): ComparisonDirection {
  const max = Math.max(
    probabilities.probabilityUp,
    probabilities.probabilityDown,
    probabilities.probabilityFlat,
  )
  if (probabilities.probabilityUp === max) return 'up'
  if (probabilities.probabilityDown === max) return 'down'
  return 'flat'
}

function scoredDirection(
  signal: EvaluatedSignal | null,
): ComparisonDirection | null {
  return signal?.status === 'scored'
    ? predictedDirection(requireProbabilities(signal))
    : null
}

function neutralSignal(): EvaluatedSignal {
  return {
    status: 'scored',
    probabilities: {
      probabilityUp: 1 / 3,
      probabilityDown: 1 / 3,
      probabilityFlat: 1 / 3,
    },
    expectedReturn: 0,
  }
}

function oneHot(
  label: 'up' | 'down' | 'flat',
): readonly [number, number, number] {
  return label === 'up' ? [1, 0, 0] : label === 'down' ? [0, 1, 0] : [0, 0, 1]
}

function meanOrNull(values: readonly number[]): number | null {
  return values.length === 0
    ? null
    : values.reduce((sum, value) => sum + value, 0) / values.length
}

function delta(left: number | null, right: number | null): number | null {
  return left === null || right === null ? null : left - right
}

function segmentKey(entry: ComparativeMetricEntry): string {
  return `${entry.horizon}:${entry.regime ?? 'unspecified'}`
}
