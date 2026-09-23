import type {
  ForecastHorizon,
  ForecastOutcomeLabel,
  TimestampMs,
} from '../contracts.ts'
import { contentHashFor } from '../forecast-hashing.ts'
import {
  calculateBrierScore,
  calculateCalibrationByBand,
  calculateCoverage,
  calculateDirectionalAccuracy,
  calculateLogLoss,
  type CalibrationBand,
  type CalibrationBandDefinition,
  type ForecastMetricEntry,
} from '../forecast-metrics.ts'
import {
  SIMULATION_NEUTRAL_BAND,
  type SimulationCandidate,
} from './candidate-manifest.ts'
import {
  momentumBaseline,
  noChangeBaseline,
  uniformBaseline,
  type BaselineProbabilities,
} from './baselines.ts'

export const SIMULATION_COMPARISON_VERSION =
  'simulations-comparison.v1' as const

const CALIBRATION_BANDS: readonly CalibrationBandDefinition[] = [
  { lowerInclusive: 0, upperExclusive: 0.5 },
  { lowerInclusive: 0.5, upperExclusive: 0.7 },
  { lowerInclusive: 0.7, upperExclusive: 1.01 },
]

/**
 * Parallel shape for scored simulation pairs. The inner forecast/outcome
 * reuses the existing `ForecastMetricEntry` contract untouched; the
 * candidate id travels alongside, never inside the shared entry.
 */
export interface SimulationScoredEntry {
  readonly candidateId: string
  readonly asOfTimestamp: TimestampMs
  readonly forecast: ForecastMetricEntry['forecast']
  readonly outcome: ForecastMetricEntry['outcome']
}

export interface SimulationCandidateRow {
  readonly candidateId: string
  readonly ruleVersion: string
  readonly paramSetVersion: string
  readonly runId: string
  readonly forecastCount: number
  readonly issuedCount: number
  readonly coverage: number | null
  readonly brier: number | null
  readonly accuracy: number | null
  readonly logLoss: number | null
  readonly calibration: readonly CalibrationBand[]
  /** Set only for the selection winner; every other row stays null. */
  readonly validationBrier: number | null
  readonly validationCoverage: number | null
}

export interface SimulationBaselineMetrics {
  readonly brier: number | null
  readonly accuracy: number | null
}

export interface SimulationComparisonReport {
  readonly version: typeof SIMULATION_COMPARISON_VERSION
  readonly instrumentId: 'BTC-EUR'
  readonly horizon: ForecastHorizon
  readonly datasetHash: string
  readonly manifestHash: string
  readonly neutralBand: typeof SIMULATION_NEUTRAL_BAND
  readonly selectionPct: number
  readonly selectionCutTimestamp: TimestampMs
  readonly selectionCount: number
  readonly validationCount: number
  readonly rows: readonly SimulationCandidateRow[]
  readonly baselines: {
    readonly uniform: SimulationBaselineMetrics
    readonly noChange: SimulationBaselineMetrics
    readonly momentum: SimulationBaselineMetrics
  }
  readonly winner: {
    readonly candidateId: string
    readonly selectionBrier: number
    readonly validationBrier: number | null
    readonly validationCount: number
  } | null
  readonly limitations: readonly string[]
  readonly contentHash: string
}

export interface SimulationReportCandidate {
  readonly candidateId: string
  readonly ruleVersion: string
  readonly paramSetVersion: string
  readonly runId: string
}

export function buildComparisonReport(args: {
  readonly horizon: ForecastHorizon
  readonly datasetHash: string
  readonly manifestHash: string
  readonly selectionPct: number
  readonly selectionCutTimestamp: TimestampMs
  readonly selection: readonly SimulationScoredEntry[]
  readonly validation: readonly SimulationScoredEntry[]
  readonly candidates: readonly SimulationReportCandidate[]
}): SimulationComparisonReport {
  const byCandidate = new Map<string, SimulationScoredEntry[]>()
  for (const scored of args.selection) {
    const current = byCandidate.get(scored.candidateId) ?? []
    current.push(scored)
    byCandidate.set(scored.candidateId, current)
  }
  const rows = args.candidates.map((candidate) =>
    buildRow(candidate, byCandidate.get(candidate.candidateId) ?? [], []),
  )
  rows.sort((left, right) => {
    if (left.brier === null && right.brier === null)
      return left.candidateId < right.candidateId ? -1 : 1
    if (left.brier === null) return 1
    if (right.brier === null) return -1
    return (
      left.brier - right.brier ||
      (left.candidateId < right.candidateId ? -1 : 1)
    )
  })

  const winnerRow = rows.find((row) => row.brier !== null) ?? null
  const winnerValidation =
    winnerRow === null
      ? []
      : args.validation.filter(
          (scored) => scored.candidateId === winnerRow.candidateId,
        )
  const validatedRows =
    winnerRow === null
      ? rows
      : rows.map((row) =>
          row.candidateId === winnerRow.candidateId
            ? withValidation(row, winnerValidation)
            : row,
        )

  const orderedSelection = [...args.selection].sort(
    (left, right) => left.asOfTimestamp - right.asOfTimestamp,
  )
  const reportWithoutHash = {
    version: SIMULATION_COMPARISON_VERSION,
    instrumentId: 'BTC-EUR' as const,
    horizon: args.horizon,
    datasetHash: args.datasetHash,
    manifestHash: args.manifestHash,
    neutralBand: SIMULATION_NEUTRAL_BAND,
    selectionPct: args.selectionPct,
    selectionCutTimestamp: args.selectionCutTimestamp,
    selectionCount: args.selection.length,
    validationCount: args.validation.length,
    rows: validatedRows,
    baselines: {
      uniform: baselineMetrics(
        orderedSelection.map((scored) => ({
          scored,
          probabilities: uniformBaseline(),
        })),
      ),
      noChange: baselineMetrics(
        orderedSelection.map((scored) => ({
          scored,
          probabilities: noChangeBaseline(),
        })),
      ),
      momentum: baselineMetrics(
        orderedSelection.map((scored, index) => ({
          scored,
          probabilities: momentumBaseline(
            index === 0 ? null : orderedSelection[index - 1]!.outcome.label,
          ),
        })),
      ),
    },
    winner:
      winnerRow === null
        ? null
        : {
            candidateId: winnerRow.candidateId,
            selectionBrier: winnerRow.brier!,
            validationBrier:
              winnerValidation.length === 0
                ? null
                : calculateBrierScore(toMetricEntries(winnerValidation)),
            validationCount: winnerValidation.length,
          },
    limitations: [
      'Descriptive comparison only; it does not establish profitability.',
      'Association between a candidate score and an outcome is not causal evidence.',
      'Selection on the selection slice introduces selection bias: the winner is chosen because it scored best there, so its selection metrics are optimistic and only the locked validation slice gives an unbiased read.',
      'No random backtest or random train/test split is performed; the split is strictly by time.',
      'Metrics are meaningful only for outcomes evaluated after their valid horizon.',
      'Results depend on thin historical data and must not drive trading decisions.',
    ],
  }
  return {
    ...reportWithoutHash,
    contentHash: contentHashFor(reportWithoutHash),
  }
}

function toMetricEntries(
  scored: readonly SimulationScoredEntry[],
): ForecastMetricEntry[] {
  return scored.map((entry) => ({
    forecast: entry.forecast,
    outcome: entry.outcome,
  }))
}

function buildRow(
  candidate: SimulationReportCandidate,
  selection: readonly SimulationScoredEntry[],
  validation: readonly SimulationScoredEntry[],
): SimulationCandidateRow {
  const entries = toMetricEntries(selection)
  const coverage = calculateCoverage(entries)
  const base: SimulationCandidateRow = {
    candidateId: candidate.candidateId,
    ruleVersion: candidate.ruleVersion,
    paramSetVersion: candidate.paramSetVersion,
    runId: candidate.runId,
    forecastCount: selection.length,
    issuedCount: coverage.issued,
    coverage: coverage.coverage,
    brier: calculateBrierScore(entries),
    accuracy: calculateDirectionalAccuracy(entries),
    logLoss: calculateLogLoss(entries),
    calibration: calculateCalibrationByBand(entries, CALIBRATION_BANDS),
    validationBrier: null,
    validationCoverage: null,
  }
  return withValidation(base, validation)
}

function withValidation(
  row: SimulationCandidateRow,
  validation: readonly SimulationScoredEntry[],
): SimulationCandidateRow {
  if (validation.length === 0) return row
  const entries = toMetricEntries(validation)
  return {
    ...row,
    validationBrier: calculateBrierScore(entries),
    validationCoverage: calculateCoverage(entries).coverage,
  }
}

function baselineMetrics(
  scored: readonly {
    readonly scored: SimulationScoredEntry
    readonly probabilities: BaselineProbabilities
  }[],
): SimulationBaselineMetrics {
  const entries: ForecastMetricEntry[] = scored.map(
    ({ scored, probabilities }) => ({
      forecast: {
        probabilityUp: probabilities.probabilityUp,
        probabilityDown: probabilities.probabilityDown,
        probabilityFlat: probabilities.probabilityFlat,
        abstained: false,
        horizon: scored.forecast.horizon,
      },
      outcome: scored.outcome,
    }),
  )
  return {
    brier: calculateBrierScore(entries),
    accuracy: calculateDirectionalAccuracy(entries),
  }
}

export type { ForecastOutcomeLabel, SimulationCandidate }
