import type {
  ForecastHorizon,
  ForecastOutcomeLabel,
  TimestampMs,
} from '../../domain/contracts.ts'
import { contentHashFor } from '../forecasts/forecast-hashing.ts'
import { HORIZON_MS } from '../forecasts/forecast-evaluator.ts'
import {
  assessBacktestReadiness,
  type BacktestReadiness,
} from './backtest-readiness.ts'
import {
  calculateBrierScore,
  calculateCalibrationByBand,
  calculateCoverage,
  calculateDirectionalAccuracy,
  calculateLogLoss,
  type CalibrationBand,
  type CalibrationBandDefinition,
  type ForecastMetricEntry,
} from '../forecasts/forecast-metrics.ts'
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
import {
  STRATEGY_RULE_VERSION,
  TRADE_COSTS_VERSION,
  momentumSignalsFor,
  simulateBuyAndHold,
  simulateFlatCash,
  simulateLongFlat,
  uniformSignalsFor,
  type TradeSimBar,
  type TradeSimCosts,
  type TradeSimEquityPoint,
  type TradeSimMetrics,
  type TradeSimSignal,
  type TradeSimResult,
} from './trade-simulation.ts'

export const SIMULATION_COMPARISON_VERSION =
  'simulations-comparison.v4' as const

/**
 * Maximum equity-curve points stored per candidate per slice. Longer
 * windows are stride-downsampled (first and last points always kept), so
 * the report stays small while the UI can still draw candidate vs.
 * buy-and-hold curves on the same window.
 */
export const MAX_PROFITABILITY_EQUITY_POINTS = 60 as const

export const KRAKEN_PRO_SPOT_TIER1_TAKER_FEE_SCENARIO = {
  version: 'kraken-pro-spot-btc-eur-tier1-taker.v1',
  venue: 'Kraken Pro Spot',
  pair: 'BTC-EUR',
  tier: 'Tier 1 (0+ USD qualifying 30-day volume)',
  role: 'taker',
  sourceUrl: 'https://www.kraken.com/features/fee-schedule',
  verifiedAt: '2026-09-26',
  commissionRate: 0.008,
  slippageRate: 0.0005,
  accountTier: 'unknown',
  classification: 'model-scenario-not-account-fee',
} as const

export type FeeScenario = typeof KRAKEN_PRO_SPOT_TIER1_TAKER_FEE_SCENARIO

export interface SimulationProfitabilitySlice {
  readonly metrics: TradeSimMetrics
  readonly readiness?: BacktestReadiness
  readonly equityCurve: readonly TradeSimEquityPoint[]
  readonly ledgerHash: string
}

export interface SimulationProfitabilityEntry {
  readonly candidateId: string
  readonly entryThreshold?: number
  readonly exitThreshold?: number
  readonly selection: SimulationProfitabilitySlice
  readonly validation: SimulationProfitabilitySlice
}

export interface SimulationProfitabilityBaselines {
  readonly flatCash: SimulationProfitabilityEntry
  readonly uniform: SimulationProfitabilityEntry
  readonly noChange: SimulationProfitabilityEntry
  readonly momentum: SimulationProfitabilityEntry
}

export interface SimulationProfitabilityBlock {
  readonly ruleVersion: typeof STRATEGY_RULE_VERSION
  readonly costsVersion: typeof TRADE_COSTS_VERSION
  readonly costs: TradeSimCosts
  readonly feeScenario?: FeeScenario
  readonly startingCash: number
  readonly entryThreshold: number
  readonly exitUpThreshold: number
  readonly exitDownThreshold: number
  readonly equityPointsDownsampledTo: typeof MAX_PROFITABILITY_EQUITY_POINTS
  readonly candidates: readonly SimulationProfitabilityEntry[]
  readonly baselines: SimulationProfitabilityBaselines
  /** Alias of the no-change (buy-and-hold) curves for the visual comparison. */
  readonly buyAndHoldEquity: {
    readonly selection: readonly TradeSimEquityPoint[]
    readonly validation: readonly TradeSimEquityPoint[]
  }
}

export interface SimulationProfitabilityInput {
  readonly selectionBars: readonly TradeSimBar[]
  readonly validationBars: readonly TradeSimBar[]
  readonly signalsByCandidate: Readonly<
    Record<string, readonly TradeSimSignal[]>
  >
  readonly candidateThresholds?: Readonly<
    Record<string, { readonly entry: number; readonly exit: number }>
  >
  /** Keys are times when the horizon outcome became observable, not forecast times. */
  readonly outcomeLabelsByTime: Readonly<Record<number, ForecastOutcomeLabel>>
  readonly startingCash: number
  readonly entryThreshold: number
  readonly exitUpThreshold: number
  readonly exitDownThreshold: number
  readonly costs: TradeSimCosts
  readonly feeScenario?: FeeScenario
}

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
  /** Null for callers that only score forecasts without trade simulation. */
  readonly profitability: SimulationProfitabilityBlock | null
  readonly microCandidateDiagnostics: MicroCandidateDiagnostics | null
}

export interface MicroCandidateDiagnostics {
  readonly version: 'micro-candidate-diagnostics.v1'
  readonly holdoutConsumed: true
  readonly holdoutNotice: string
  readonly candidates: readonly {
    readonly candidateId: string
    readonly selectionBrier: number | null
    readonly selectionMaturedCount: number
    readonly validationBrier: number | null
    readonly validationMaturedCount: number
    readonly priorReadyCount: number
    readonly forecastOrigins: number
    readonly forecastCoverage: number | null
    readonly selectionFillCount: number
    readonly selectionRoundTripCount: number
    readonly selectionNetReturnPct: number
    readonly selectionDrawdownPct: number
    readonly validationFillCount: number
    readonly validationRoundTripCount: number
    readonly validationNetReturnPct: number
    readonly validationDrawdownPct: number
  }[]
  readonly selectionBaselines: MicroDiagnosticBaselines
  readonly validationBaselines: MicroDiagnosticBaselines
}

export interface MicroDiagnosticBaselines {
  readonly uniform: { readonly brier: number | null; readonly count: number }
  readonly noChange: { readonly brier: number | null; readonly count: number }
  readonly momentum: { readonly brier: number | null; readonly count: number }
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
  readonly profitability?: SimulationProfitabilityInput
  readonly microReadiness?: Readonly<
    Record<
      string,
      { readonly priorReadyCount: number; readonly forecastOrigins: number }
    >
  >
}): SimulationComparisonReport {
  const isMicro = (candidateId: string) =>
    MICRO_CANDIDATE_IDS.includes(
      candidateId as (typeof MICRO_CANDIDATE_IDS)[number],
    )
  const legacySelection = args.selection.filter(
    (entry) => !isMicro(entry.candidateId),
  )
  const legacyValidation = args.validation.filter(
    (entry) => !isMicro(entry.candidateId),
  )
  const legacyCandidates = args.candidates.filter(
    (candidate) => !isMicro(candidate.candidateId),
  )
  const byCandidate = new Map<string, SimulationScoredEntry[]>()
  for (const scored of legacySelection) {
    const current = byCandidate.get(scored.candidateId) ?? []
    current.push(scored)
    byCandidate.set(scored.candidateId, current)
  }
  const rows = legacyCandidates.map((candidate) =>
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

  const winnerRow =
    rows.find(
      (row) =>
        row.brier !== null &&
        !MICRO_CANDIDATE_IDS.includes(
          row.candidateId as (typeof MICRO_CANDIDATE_IDS)[number],
        ),
    ) ?? null
  const winnerValidation =
    winnerRow === null
      ? []
      : legacyValidation.filter(
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

  const orderedSelection = [...legacySelection].sort(
    (left, right) => left.asOfTimestamp - right.asOfTimestamp,
  )
  const maturedSelectionLabels = maturedLabelsForTimes(
    orderedSelection,
    orderedSelection.map((entry) => entry.asOfTimestamp),
    args.horizon,
  )
  const profitability =
    args.profitability === undefined
      ? null
      : buildProfitabilityBlock(
          args.profitability,
          args.candidates.map((candidate) => candidate.candidateId),
        )
  const microCandidateDiagnostics = buildMicroDiagnostics({
    selection: args.selection,
    validation: args.validation,
    candidates: args.candidates,
    microReadiness: args.microReadiness ?? {},
    profitability,
    horizon: args.horizon,
  })
  const reportWithoutHash = {
    version: SIMULATION_COMPARISON_VERSION,
    instrumentId: 'BTC-EUR' as const,
    horizon: args.horizon,
    datasetHash: args.datasetHash,
    manifestHash: args.manifestHash,
    neutralBand: SIMULATION_NEUTRAL_BAND,
    selectionPct: args.selectionPct,
    selectionCutTimestamp: args.selectionCutTimestamp,
    selectionCount: legacySelection.length,
    validationCount: legacyValidation.length,
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
            maturedSelectionLabels[index] ?? null,
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
      ...(microCandidateDiagnostics === null
        ? []
        : [microCandidateDiagnostics.holdoutNotice]),
      ...(profitability === null
        ? []
        : [
            'Simulated profitability is descriptive only: fills are hypothetical next-open executions with estimated costs, and no order is previewed or submitted.',
            'Simulated returns are not predictive and are regime-dependent: past slices do not imply future performance.',
          ]),
    ],
    profitability,
    microCandidateDiagnostics,
  }
  return {
    ...reportWithoutHash,
    contentHash: contentHashFor(reportWithoutHash),
  }
}

const MICRO_CANDIDATE_IDS = [
  'micro-trend-pullback',
  'micro-bollinger-reversion',
  'micro-donchian-breakout',
  'micro-regime-adapter',
] as const

function buildMicroDiagnostics(args: {
  readonly selection: readonly SimulationScoredEntry[]
  readonly validation: readonly SimulationScoredEntry[]
  readonly candidates: readonly SimulationReportCandidate[]
  readonly microReadiness: Readonly<
    Record<
      string,
      { readonly priorReadyCount: number; readonly forecastOrigins: number }
    >
  >
  readonly profitability: SimulationProfitabilityBlock | null
  readonly horizon: ForecastHorizon
}): MicroCandidateDiagnostics | null {
  const present = new Set(args.candidates.map(({ candidateId }) => candidateId))
  if (!MICRO_CANDIDATE_IDS.some((id) => present.has(id))) return null
  const microSelection = args.selection.filter(
    (entry) =>
      present.has(entry.candidateId) &&
      MICRO_CANDIDATE_IDS.includes(
        entry.candidateId as (typeof MICRO_CANDIDATE_IDS)[number],
      ),
  )
  const microValidation = args.validation.filter(
    (entry) =>
      present.has(entry.candidateId) &&
      MICRO_CANDIDATE_IDS.includes(
        entry.candidateId as (typeof MICRO_CANDIDATE_IDS)[number],
      ),
  )
  const uniqueByTime = (entries: readonly SimulationScoredEntry[]) =>
    [
      ...new Map(entries.map((entry) => [entry.asOfTimestamp, entry])).values(),
    ].sort((a, b) => a.asOfTimestamp - b.asOfTimestamp)
  const selectionMatched = uniqueByTime(microSelection)
  const validationMatched = uniqueByTime(microValidation)
  const baselineSet = (
    entries: readonly SimulationScoredEntry[],
    history: readonly SimulationScoredEntry[],
  ): MicroDiagnosticBaselines => {
    const times = entries.map(({ asOfTimestamp }) => asOfTimestamp)
    const matured = maturedLabelsForTimes(history, times, args.horizon)
    const scored = entries.map((entry) => ({
      scored: entry,
      probabilities: uniformBaseline(),
    }))
    const calculate = (mode: 'uniform' | 'noChange' | 'momentum') => {
      const mapped = scored.map(({ scored }, index) => ({
        scored,
        probabilities:
          mode === 'uniform'
            ? uniformBaseline()
            : mode === 'noChange'
              ? noChangeBaseline()
              : momentumBaseline(matured[index] ?? null),
      }))
      return { brier: baselineMetrics(mapped).brier, count: mapped.length }
    }
    return {
      uniform: calculate('uniform'),
      noChange: calculate('noChange'),
      momentum: calculate('momentum'),
    }
  }
  const selectionBaselines = baselineSet(selectionMatched, [...args.selection])
  const validationBaselines = baselineSet(validationMatched, [
    ...args.selection,
    ...args.validation,
  ])
  const diagnostics = MICRO_CANDIDATE_IDS.filter((id) => present.has(id)).map(
    (candidateId) => {
      const selection = args.selection.filter(
        (entry) => entry.candidateId === candidateId,
      )
      const validation = args.validation.filter(
        (entry) => entry.candidateId === candidateId,
      )
      const profit = args.profitability?.candidates.find(
        (entry) => entry.candidateId === candidateId,
      )
      const readiness = args.microReadiness[candidateId] ?? {
        priorReadyCount: 0,
        forecastOrigins: 0,
      }
      const sliceDefaults = {
        fillCount: 0,
        tradeCount: 0,
        netReturnPct: 0,
        maxDrawdownPct: 0,
      }
      const selectionTrade = profit?.selection.metrics ?? sliceDefaults
      const validationTrade = profit?.validation.metrics ?? sliceDefaults
      return {
        candidateId,
        selectionBrier: calculateBrierScore(toMetricEntries(selection)),
        selectionMaturedCount: selection.length,
        validationBrier: calculateBrierScore(toMetricEntries(validation)),
        validationMaturedCount: validation.length,
        priorReadyCount: readiness.priorReadyCount,
        forecastOrigins: readiness.forecastOrigins,
        forecastCoverage: calculateCoverage(toMetricEntries(validation))
          .coverage,
        selectionFillCount: selectionTrade.fillCount,
        selectionRoundTripCount: selectionTrade.tradeCount,
        selectionNetReturnPct: selectionTrade.netReturnPct,
        selectionDrawdownPct: selectionTrade.maxDrawdownPct,
        validationFillCount: validationTrade.fillCount,
        validationRoundTripCount: validationTrade.tradeCount,
        validationNetReturnPct: validationTrade.netReturnPct,
        validationDrawdownPct: validationTrade.maxDrawdownPct,
      }
    },
  )
  return {
    version: 'micro-candidate-diagnostics.v1',
    holdoutConsumed: true,
    holdoutNotice:
      'Testing all four pre-registered micro candidates consumes this holdout; do not reuse it for further parameter selection.',
    candidates: diagnostics,
    selectionBaselines,
    validationBaselines,
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

/** An outcome enters the baseline's information set only after its horizon. */
export function maturedLabelsForTimes(
  scored: readonly SimulationScoredEntry[],
  times: readonly TimestampMs[],
  horizon: ForecastHorizon,
): readonly (ForecastOutcomeLabel | null)[] {
  const unique = new Map<number, ForecastOutcomeLabel>()
  for (const entry of scored) {
    if (!unique.has(entry.asOfTimestamp))
      unique.set(entry.asOfTimestamp, entry.outcome.label)
  }
  const matured = [...unique]
    .map(([asOf, label]) => ({
      availableAt: asOf + HORIZON_MS[horizon],
      label,
    }))
    .sort((a, b) => a.availableAt - b.availableAt)
  let cursor = 0
  let latest: ForecastOutcomeLabel | null = null
  return times.map((time) => {
    while (cursor < matured.length && matured[cursor]!.availableAt < time) {
      latest = matured[cursor]!.label
      cursor += 1
    }
    return latest
  })
}

/**
 * Simulate every candidate plus the baseline trio on both slices with the
 * same strategy rule, thresholds, cash, and versioned costs. Uniform stays
 * flat (0 trades); no-change is buy-and-hold; momentum repeats the last
 * observed outcome label with certainty (first bar has no past label and
 * falls back to uniform).
 */
export function buildProfitabilityBlock(
  input: SimulationProfitabilityInput,
  candidateIds: readonly string[],
): SimulationProfitabilityBlock {
  const shared = {
    startingCash: input.startingCash,
    entryThreshold: input.entryThreshold,
    exitUpThreshold: input.exitUpThreshold,
    exitDownThreshold: input.exitDownThreshold,
    costs: input.costs,
  }
  const slice = (result: TradeSimResult) =>
    toProfitabilitySlice(result, input.costs.commissionRate)
  const candidates = candidateIds.map((candidateId) => ({
    candidateId,
    ...(input.candidateThresholds?.[candidateId] === undefined
      ? {}
      : {
          entryThreshold: input.candidateThresholds[candidateId]!.entry,
          exitThreshold: input.candidateThresholds[candidateId]!.exit,
        }),
    selection: slice(
      simulateLongFlat({
        ...shared,
        entryThreshold:
          input.candidateThresholds?.[candidateId]?.entry ??
          shared.entryThreshold,
        exitUpThreshold:
          input.candidateThresholds?.[candidateId]?.exit ??
          shared.exitUpThreshold,
        bars: input.selectionBars,
        signals: input.signalsByCandidate[candidateId] ?? [],
      }),
    ),
    validation: slice(
      simulateLongFlat({
        ...shared,
        entryThreshold:
          input.candidateThresholds?.[candidateId]?.entry ??
          shared.entryThreshold,
        exitUpThreshold:
          input.candidateThresholds?.[candidateId]?.exit ??
          shared.exitUpThreshold,
        bars: input.validationBars,
        signals: input.signalsByCandidate[candidateId] ?? [],
      }),
    ),
  }))
  const baselines: SimulationProfitabilityBaselines = {
    flatCash: {
      candidateId: 'flatCash',
      selection: slice(
        simulateFlatCash({
          bars: input.selectionBars,
          startingCash: input.startingCash,
        }),
      ),
      validation: slice(
        simulateFlatCash({
          bars: input.validationBars,
          startingCash: input.startingCash,
        }),
      ),
    },
    uniform: {
      candidateId: 'uniform',
      selection: slice(
        simulateLongFlat({
          ...shared,
          bars: input.selectionBars,
          signals: uniformSignalsFor(input.selectionBars),
        }),
      ),
      validation: slice(
        simulateLongFlat({
          ...shared,
          bars: input.validationBars,
          signals: uniformSignalsFor(input.validationBars),
        }),
      ),
    },
    noChange: {
      candidateId: 'noChange',
      selection: slice(
        simulateBuyAndHold({
          bars: input.selectionBars,
          startingCash: input.startingCash,
          costs: input.costs,
        }),
      ),
      validation: slice(
        simulateBuyAndHold({
          bars: input.validationBars,
          startingCash: input.startingCash,
          costs: input.costs,
        }),
      ),
    },
    momentum: {
      candidateId: 'momentum',
      selection: slice(
        simulateLongFlat({
          ...shared,
          bars: input.selectionBars,
          signals: momentumSignalsFor(
            input.selectionBars,
            labelsFor(input.selectionBars, input.outcomeLabelsByTime),
          ),
        }),
      ),
      validation: slice(
        simulateLongFlat({
          ...shared,
          bars: input.validationBars,
          signals: momentumSignalsFor(
            input.validationBars,
            labelsFor(input.validationBars, input.outcomeLabelsByTime),
          ),
        }),
      ),
    },
  }
  return {
    ruleVersion: STRATEGY_RULE_VERSION,
    costsVersion: TRADE_COSTS_VERSION,
    costs: input.costs,
    ...(input.feeScenario === undefined
      ? {}
      : { feeScenario: input.feeScenario }),
    startingCash: input.startingCash,
    entryThreshold: input.entryThreshold,
    exitUpThreshold: input.exitUpThreshold,
    exitDownThreshold: input.exitDownThreshold,
    equityPointsDownsampledTo: MAX_PROFITABILITY_EQUITY_POINTS,
    candidates,
    baselines,
    buyAndHoldEquity: {
      selection: baselines.noChange.selection.equityCurve,
      validation: baselines.noChange.validation.equityCurve,
    },
  }
}

function labelsFor(
  bars: readonly TradeSimBar[],
  labelsByTime: Readonly<Record<number, ForecastOutcomeLabel>>,
): readonly (ForecastOutcomeLabel | null)[] {
  const available = Object.entries(labelsByTime)
    .map(([time, label]) => ({ time: Number(time), label }))
    .sort((a, b) => a.time - b.time)
  let cursor = 0
  let latest: ForecastOutcomeLabel | null = null
  return bars.map((bar) => {
    while (cursor < available.length && available[cursor]!.time < bar.time) {
      latest = available[cursor]!.label
      cursor += 1
    }
    return latest
  })
}

function toProfitabilitySlice(
  result: TradeSimResult,
  commissionRate: number,
): SimulationProfitabilitySlice {
  const start = result.equityCurve[0]?.time
  const end = result.equityCurve.at(-1)?.time
  const windowDays =
    start === undefined || end === undefined ? 0 : (end - start) / 86_400_000
  return {
    metrics: result.metrics,
    readiness: assessBacktestReadiness({
      tradeCount: result.metrics.tradeCount,
      windowDays,
      profitFactor: result.metrics.profitFactor,
      maxDrawdownPct: result.metrics.maxDrawdownPct,
      commissionRate,
      regimeCoverage: 'not_evaluated',
    }),
    equityCurve: downsampleEquityCurve(
      result.equityCurve,
      MAX_PROFITABILITY_EQUITY_POINTS,
    ),
    ledgerHash: result.ledgerHash,
  }
}

function downsampleEquityCurve(
  points: readonly TradeSimEquityPoint[],
  maxPoints: number,
): readonly TradeSimEquityPoint[] {
  if (points.length <= maxPoints) return points
  const stride = (points.length - 1) / (maxPoints - 1)
  const sampled: TradeSimEquityPoint[] = []
  for (let index = 0; index < maxPoints - 1; index += 1) {
    sampled.push(points[Math.floor(index * stride)]!)
  }
  sampled.push(points.at(-1)!)
  return sampled
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
