/** Wire mirror of the server simulations report. Read-only; never computed here. */

export type SimulationsStatus = 'loading' | 'ready' | 'empty' | 'error'

export interface SimulationsCalibrationBand {
  readonly lowerInclusive: number
  readonly upperExclusive: number
  readonly count: number
  readonly meanPredictedProbability: number | null
  readonly observedFrequency: number | null
}

export interface SimulationsCandidateRow {
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
  readonly calibration: readonly SimulationsCalibrationBand[]
  readonly validationBrier: number | null
  readonly validationCoverage: number | null
}

export interface SimulationsBaselineMetrics {
  readonly brier: number | null
  readonly accuracy: number | null
}

export interface SimulationsEquityPoint {
  readonly time: number
  readonly equity: number
}

export interface SimulationsProfitabilityMetrics {
  readonly netReturnPct: number
  readonly tradeCount: number
  readonly winRate: number | null
  readonly profitFactor?: number | null
  readonly maxDrawdownPct: number
  readonly exposurePct: number | null
  readonly finalEquity: number
}

export interface SimulationsProfitabilitySlice {
  readonly metrics: SimulationsProfitabilityMetrics
  readonly readiness?: {
    readonly status: 'insufficient' | 'review'
    readonly windowDays: number
    readonly reasons: readonly string[]
  }
  readonly equityCurve: readonly SimulationsEquityPoint[]
  readonly ledgerHash: string
}

export interface SimulationsProfitabilityEntry {
  readonly candidateId: string
  readonly entryThreshold?: number
  readonly exitThreshold?: number
  readonly selection: SimulationsProfitabilitySlice
  readonly validation: SimulationsProfitabilitySlice
}

export interface SimulationsProfitabilityBlock {
  readonly ruleVersion: string
  readonly costsVersion: string
  readonly costs: {
    readonly commissionRate: number
    readonly slippageRate: number
  }
  readonly startingCash: number
  readonly entryThreshold: number
  readonly exitUpThreshold: number
  readonly exitDownThreshold: number
  readonly equityPointsDownsampledTo: number
  readonly candidates: readonly SimulationsProfitabilityEntry[]
  readonly baselines: {
    readonly uniform: SimulationsProfitabilityEntry
    readonly noChange: SimulationsProfitabilityEntry
    readonly momentum: SimulationsProfitabilityEntry
  }
  readonly buyAndHoldEquity: {
    readonly selection: readonly SimulationsEquityPoint[]
    readonly validation: readonly SimulationsEquityPoint[]
  }
}

export interface SimulationsComparisonReport {
  readonly version: string
  readonly instrumentId: string
  readonly horizon: string
  readonly datasetHash: string
  readonly manifestHash: string
  readonly neutralBand: number
  readonly selectionPct: number
  readonly selectionCutTimestamp: number
  readonly selectionCount: number
  readonly validationCount: number
  readonly rows: readonly SimulationsCandidateRow[]
  readonly baselines: {
    readonly uniform: SimulationsBaselineMetrics
    readonly noChange: SimulationsBaselineMetrics
    readonly momentum: SimulationsBaselineMetrics
  }
  readonly winner: {
    readonly candidateId: string
    readonly selectionBrier: number
    readonly validationBrier: number | null
    readonly validationCount: number
  } | null
  readonly limitations: readonly string[]
  readonly contentHash: string
  readonly profitability: SimulationsProfitabilityBlock | null
}

export interface SimulationsReportFile {
  readonly version: string
  readonly generatedAt: number
  readonly instrumentId: string
  readonly importVersion: string
  readonly datasetHash: string
  readonly manifestHash: string
  readonly selectionPct: number
  readonly window?: { readonly since: number; readonly until: number }
  readonly reports: readonly SimulationsComparisonReport[]
}
