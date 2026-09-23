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
}

export interface SimulationsReportFile {
  readonly version: string
  readonly generatedAt: number
  readonly instrumentId: string
  readonly importVersion: string
  readonly datasetHash: string
  readonly manifestHash: string
  readonly selectionPct: number
  readonly reports: readonly SimulationsComparisonReport[]
}
