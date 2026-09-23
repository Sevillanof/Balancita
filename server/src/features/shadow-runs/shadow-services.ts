import type {
  SupportedInstrumentId,
  TimestampMs,
} from '../../domain/contracts.ts'
import type { MarketStore } from '../market-data/market-store.ts'
import { shadowAggregationFor } from './shadow-aggregation.ts'
import type { ShadowDecisionRecord } from './shadow-decision.ts'
import { createShadowDecisionInput } from './shadow-decision.ts'
import {
  buildShadowReport,
  MIN_SHADOW_EVALUATED_OUTCOMES,
} from './shadow-report.ts'
import type { ShadowReport } from './shadow-report.ts'
import { createShadowRunStart } from './shadow-run.ts'
import type { ShadowRunReference } from './shadow-run.ts'
import type {
  ShadowRunStatusKind,
  ShadowDecisionType,
} from './shadow-contracts.ts'

export class ShadowRunNotFoundError extends Error {
  readonly code = 'shadow_run_not_found' as const

  constructor(runId: string) {
    super(`No shadow run exists for id ${runId}.`)
    this.name = 'ShadowRunNotFoundError'
  }
}

export interface ShadowRunServiceOptions {
  readonly store: MarketStore
  readonly instrumentId: SupportedInstrumentId
  readonly runId?: string
  readonly clock?: () => TimestampMs
}

export interface ShadowStatusView {
  readonly run: ShadowRunReference
  readonly computedStatus: ShadowRunStatusKind
  readonly status: ShadowRunStatusKind
  readonly decidedAt?: TimestampMs
  readonly decision?: ShadowDecisionRecord
  readonly evaluatedOutcomeCount: number
  readonly minimumEvidence: number
  readonly now: TimestampMs
}

export type ShadowBuildReportResult = {
  readonly outcome: 'created' | 'duplicate'
  readonly report: ShadowReport
}

export type ShadowDecideResult =
  | {
      readonly outcome: 'inserted' | 'duplicate'
      readonly decision: ShadowDecisionRecord
    }
  | {
      readonly outcome: 'rejected'
      readonly reason:
        'no_report' | 'report_hash_mismatch' | 'report_not_reviewable'
    }

export interface ShadowDecideInput {
  readonly decision: ShadowDecisionType
  readonly actor: string
  readonly reason?: string
  readonly reportHash?: string
  readonly at?: number
}

export class ShadowRunService {
  private readonly store: MarketStore
  private readonly instrumentId: SupportedInstrumentId
  private readonly runId: string
  private readonly clock: () => TimestampMs

  constructor(options: ShadowRunServiceOptions) {
    this.store = options.store
    this.instrumentId = options.instrumentId
    this.runId = options.runId ?? `shadow:${options.instrumentId}`
    this.clock = options.clock ?? (() => Date.now() as TimestampMs)
  }

  start(at: number = this.clock()): {
    readonly outcome: 'inserted' | 'duplicate'
    readonly run: ShadowRunReference
  } {
    const start = createShadowRunStart(at, this.instrumentId, {
      id: this.runId,
    })
    const result = this.store.createShadowRun(start, at as TimestampMs)
    const run = this.store.getShadowRun(this.runId)
    if (run === undefined)
      throw new Error('Shadow run could not be recovered after creation.')
    return { outcome: result.outcome, run }
  }

  status(at: number = this.clock()): ShadowStatusView {
    const run = this.store.getShadowRun(this.runId)
    if (run === undefined) throw new ShadowRunNotFoundError(this.runId)
    const persisted = this.store.getShadowStatus(this.runId)
    const decision = this.store.getShadowDecision(this.runId)
    const evaluated = this.evaluatedOutcomeCount(at)
    let computedStatus: ShadowRunStatusKind
    if (persisted?.status === 'go' || persisted?.status === 'no_go')
      computedStatus = persisted.status
    else if (at < run.plannedEndAt) computedStatus = 'collecting'
    else
      computedStatus =
        evaluated >= MIN_SHADOW_EVALUATED_OUTCOMES
          ? 'ready_for_review'
          : 'insufficient_evidence'
    return {
      run,
      computedStatus,
      status: persisted?.status ?? 'collecting',
      ...(decision?.decidedAt === undefined
        ? {}
        : { decidedAt: decision.decidedAt }),
      ...(decision === undefined ? {} : { decision }),
      evaluatedOutcomeCount: evaluated,
      minimumEvidence: MIN_SHADOW_EVALUATED_OUTCOMES,
      now: at as TimestampMs,
    }
  }

  buildReport(at: number = this.clock()): ShadowBuildReportResult {
    const run = this.store.getShadowRun(this.runId)
    if (run === undefined) throw new ShadowRunNotFoundError(this.runId)
    const windowed = this.windowedForecasts(at)
    const forecastKeys = new Set(
      windowed.map((forecast) => `${forecast.id}:${forecast.version}`),
    )
    const outcomes = this.store
      .listOutcomes()
      .filter((outcome) =>
        forecastKeys.has(`${outcome.forecastId}:${outcome.forecastVersion}`),
      )
    const newsEvidence = this.store
      .listNewsEvidence({})
      .filter(
        (evidence) =>
          evidence.publishedAt >= run.startedAt && evidence.publishedAt <= at,
      )
    const metrics = shadowAggregationFor({
      run,
      inputs: {
        forecasts: windowed,
        outcomes,
        asOfTimestamp: at,
        now: at,
        storedNewsEvidenceCount: newsEvidence.length,
      },
    })
    const report = buildShadowReport({
      run,
      metrics,
      now: at,
      storedNewsEvidenceCount: newsEvidence.length,
    })
    const latest = this.store.getShadowReport(this.runId)
    if (latest?.contentHash === report.contentHash)
      return { outcome: 'duplicate', report }
    this.store.saveShadowReport(report, at as TimestampMs)
    return { outcome: 'created', report }
  }

  decide(input: ShadowDecideInput): ShadowDecideResult {
    const at = input.at ?? this.clock()
    const run = this.store.getShadowRun(this.runId)
    if (run === undefined) throw new ShadowRunNotFoundError(this.runId)
    const report = this.store.getShadowReport(this.runId)
    if (report === undefined)
      return { outcome: 'rejected' as const, reason: 'no_report' as const }
    if (
      input.reportHash !== undefined &&
      input.reportHash !== report.contentHash
    )
      return {
        outcome: 'rejected' as const,
        reason: 'report_hash_mismatch' as const,
      }
    if (
      report.status !== 'ready_for_review' &&
      report.status !== 'insufficient_evidence'
    )
      return {
        outcome: 'rejected' as const,
        reason: 'report_not_reviewable' as const,
      }
    const decision = createShadowDecisionInput({
      runId: this.runId,
      decision: input.decision,
      reportId: report.id,
      reportHash: report.contentHash,
      actor: input.actor,
      reason: input.reason,
      decidedAt: at,
    })
    const result = this.store.recordShadowDecision(decision, at as TimestampMs)
    return {
      outcome: result.outcome,
      decision,
    }
  }

  private evaluatedOutcomeCount(at: number): number {
    const windowed = this.windowedForecasts(at)
    const forecastKeys = new Set(
      windowed.map((forecast) => `${forecast.id}:${forecast.version}`),
    )
    return this.store
      .listOutcomes()
      .filter((outcome) =>
        forecastKeys.has(`${outcome.forecastId}:${outcome.forecastVersion}`),
      ).length
  }

  private windowedForecasts(at: number) {
    const run = this.store.getShadowRun(this.runId)
    if (run === undefined) throw new ShadowRunNotFoundError(this.runId)
    return this.store
      .listForecasts({
        instrumentId: this.instrumentId,
        sourceMode: 'shadow_live',
      })
      .filter(
        (forecast) =>
          forecast.asOfTimestamp >= run.startedAt &&
          forecast.asOfTimestamp <= at,
      )
  }
}
