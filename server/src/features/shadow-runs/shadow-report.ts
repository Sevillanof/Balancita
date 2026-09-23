import type { TimestampMs } from '../../domain/contracts.ts'
import { contentHashFor } from '../forecasts/forecast-hashing.ts'
import type { ShadowMetrics } from './shadow-aggregation.ts'
import type { ShadowRunStatusKind, ShadowVersions } from './shadow-contracts.ts'
import { SHADOW_REPORT_VERSION } from './shadow-contracts.ts'

export const MIN_SHADOW_EVALUATED_OUTCOMES = 10

export interface ShadowReport {
  readonly version: typeof SHADOW_REPORT_VERSION
  readonly id: string
  readonly runId: string
  readonly stream: 'shadow'
  readonly instrumentId: string
  readonly snapshotTimestampMs: TimestampMs
  readonly status: Exclude<ShadowRunStatusKind, 'go' | 'no_go'>
  readonly enoughData: boolean
  readonly insufficientReason:
    'shadow_ended' | 'minimum_evidence_not_reached' | null
  readonly outcome: {
    readonly forecastCount: number
    readonly evaluatedOutcomeCount: number
    readonly missingOutcomeCount: number
    readonly newsEvidenceCount: number
    readonly minimumEvidence: number
  }
  readonly metrics: ShadowMetrics
  readonly dataSources: readonly {
    readonly source: 'market_data' | 'news_evidence'
    readonly status: string
  }[]
  readonly rules: {
    readonly ruleVersion: typeof SHADOW_REPORT_VERSION
  }
  readonly contentHash: string
}

export interface ShadowReportInput {
  readonly run: Readonly<{
    readonly id: string
    readonly instrumentId: string
    readonly plannedEndAt: number
    readonly versions: ShadowVersions
    readonly sourceConstraints: Readonly<{
      readonly realtimeOnly: boolean
      readonly technicalFreshnessToleranceMs: number
      readonly newsScoresNotPersisted: boolean
    }>
  }>
  readonly metrics: ShadowMetrics
  readonly now: number
  readonly storedNewsEvidenceCount: number
  readonly minimumEvidence?: number
}

export function buildShadowReport(input: ShadowReportInput): ShadowReport {
  const minimumEvidence = input.minimumEvidence ?? MIN_SHADOW_EVALUATED_OUTCOMES
  const evaluated = input.metrics.coverage.evaluatedOutcomeCount
  const ended = input.now >= input.run.plannedEndAt
  const status: ShadowReport['status'] = ended
    ? evaluated >= minimumEvidence
      ? 'ready_for_review'
      : 'insufficient_evidence'
    : 'collecting'
  const enoughData = status === 'ready_for_review'
  const insufficientReason =
    status === 'collecting'
      ? ('shadow_ended' as const)
      : status === 'insufficient_evidence'
        ? ('minimum_evidence_not_reached' as const)
        : null

  const withoutHash = {
    version: SHADOW_REPORT_VERSION,
    id: reportIdFor(
      input.run.id,
      contentHashFor({
        runId: input.run.id,
        instrumentId: input.run.instrumentId,
        snapshotTimestampMs: input.now,
        status,
        enoughData,
        insufficientReason,
        outcome: {
          ...input.metrics.coverage,
          evaluatedOutcomeCount: evaluated,
        },
      }).slice(0, 16),
    ),
    runId: input.run.id,
    stream: 'shadow' as const,
    instrumentId: input.run.instrumentId,
    snapshotTimestampMs: input.now as TimestampMs,
    status,
    enoughData,
    insufficientReason,
    outcome: {
      forecastCount: input.metrics.coverage.forecastCount,
      evaluatedOutcomeCount: evaluated,
      missingOutcomeCount: input.metrics.missingness.missingOutcomeCount,
      newsEvidenceCount: input.storedNewsEvidenceCount,
      minimumEvidence,
    },
    metrics: input.metrics,
    dataSources: [
      {
        source: 'market_data' as const,
        status: input.run.sourceConstraints.realtimeOnly
          ? 'realtime_only'
          : 'any_source',
      },
      {
        source: 'news_evidence' as const,
        status: input.run.sourceConstraints.newsScoresNotPersisted
          ? 'scores_not_persisted'
          : 'scores_persisted',
      },
    ],
    rules: { ruleVersion: SHADOW_REPORT_VERSION },
  }
  return { ...withoutHash, contentHash: contentHashFor(withoutHash) }
}

export function restoreShadowReport(persisted: ShadowReport): ShadowReport {
  const { contentHash, ...body } = persisted
  if (contentHashFor(body) !== contentHash)
    throw new Error('Shadow report content hash does not match its body.')
  return persisted
}

function reportIdFor(runId: string, discriminator: string): string {
  return `report:${runId}:${discriminator}`
}
