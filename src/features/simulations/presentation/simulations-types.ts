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
  readonly fillCount?: number
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
  readonly microCandidateDiagnostics?: {
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
    readonly selectionBaselines: SimulationsMicroDiagnosticBaselines
    readonly validationBaselines: SimulationsMicroDiagnosticBaselines
  } | null
}

export interface SimulationsMicroDiagnosticBaselines {
  readonly uniform: { readonly brier: number | null; readonly count: number }
  readonly noChange: { readonly brier: number | null; readonly count: number }
  readonly momentum: { readonly brier: number | null; readonly count: number }
}

export interface SimulationsReportFile {
  readonly version: string
  readonly generatedAt: number
  readonly instrumentId: string
  readonly importVersion: string
  readonly datasetHash: string
  readonly manifestHash: string
  readonly selectionPct: number
  readonly marketDataCoverage?: {
    readonly measuredAt: number
    readonly staleAfterMs: number
    readonly minimumCoverageMs: number
    readonly observations: {
      readonly source: 'kraken_market_observations'
      readonly count: number
      readonly firstEventTime: number | null
      readonly lastEventTime: number | null
      readonly firstReceivedTime: number | null
      readonly maxReceivedTime: number | null
      readonly ageMs: number | null
      readonly receiveAgeMs: number | null
      readonly timeSpanMs: number
      readonly clockInverted: boolean
      readonly gaps: {
        readonly status: 'not_measured'
        readonly reason: string
      }
      readonly spanAdequacy: 'insufficient' | 'sufficient'
      readonly completeness: 'unknown'
      readonly coverageAdequacy: 'missing' | 'insufficient' | 'unknown'
      readonly freshnessStatus: 'unknown' | 'fresh' | 'stale' | 'future_dated'
      readonly status:
        | 'missing'
        | 'insufficient'
        | 'unverified'
        | 'available'
        | 'stale'
        | 'future_dated'
      readonly reason: string | null
    }
    readonly ohlc: {
      readonly source: 'kraken_rest_ohlc_1m'
      readonly count: number
      readonly firstEventTime: number | null
      readonly lastEventTime: number | null
      readonly ageMs: number | null
      readonly timeSpanMs: number
      readonly gapCount: number | null
      readonly clockInverted: boolean
      readonly spanAdequacy: 'insufficient' | 'sufficient'
      readonly coverageAdequacy:
        'missing' | 'insufficient' | 'adequate' | 'unknown'
      readonly freshnessStatus: 'unknown' | 'fresh' | 'stale' | 'future_dated'
      readonly status:
        | 'missing'
        | 'insufficient'
        | 'unverified'
        | 'available'
        | 'stale'
        | 'future_dated'
      readonly reason: string | null
    }
  }
  readonly window?: { readonly since: number; readonly until: number }
  readonly sample?: {
    readonly stage: 'smoke' | 'confirm'
    readonly seed: number
    readonly since: number
    readonly until: number
    readonly candidateIds: readonly string[]
    readonly horizons: readonly string[]
    readonly smokeReportHash?: string
  }
  readonly reports: readonly SimulationsComparisonReport[]
}

export interface SimulationsHistoryEntry {
  readonly id: string
  readonly generatedAt: number
  readonly datasetHash: string
  readonly manifestHash: string
  readonly sample?: { readonly stage: string; readonly seed: number }
  readonly window?: { readonly since: number; readonly until: number }
}
