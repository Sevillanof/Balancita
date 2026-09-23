import type {
  SupportedInstrumentId,
  TimestampMs,
} from '../../domain/contracts.ts'
import { contentHashFor } from '../forecasts/forecast-hashing.ts'
import type {
  ShadowRunStatusKind,
  ShadowSourceConstraints,
  ShadowVersions,
} from './shadow-contracts.ts'
import {
  SHADOW_RUN_SCHEMA_VERSION,
  SHADOW_STATUS_VERSION,
} from './shadow-contracts.ts'

export const SHADOW_DURATION_MS = 30 * 24 * 60 * 60 * 1000
const TECHNICAL_FRESHNESS_TOLERANCE_MS = 60_000

const DEFAULT_VERSIONS: ShadowVersions = {
  policyVersion: 'shadow-policy.v1',
  aggregationRuleVersion: 'shadow-aggregation.v1',
  baselineRuleVersion: 'shadow-baseline.v1',
  regimeRuleVersion: 'shadow-regime.v1',
  reportVersion: 'shadow-report.v1',
  decisionVersion: 'shadow-decision.v1',
}

const DEFAULT_SOURCE_CONSTRAINTS: ShadowSourceConstraints = {
  realtimeOnly: true,
  technicalFreshnessToleranceMs: TECHNICAL_FRESHNESS_TOLERANCE_MS,
  newsScoresNotPersisted: true,
}

export interface ShadowRunStart {
  readonly id: string
  readonly version: typeof SHADOW_RUN_SCHEMA_VERSION
  readonly instrumentId: SupportedInstrumentId
  readonly startedAt: TimestampMs
  readonly plannedEndAt: TimestampMs
  readonly status: 'collecting'
  readonly versions: ShadowVersions
  readonly sourceConstraints: ShadowSourceConstraints
  readonly contentHash: string
}

export interface ShadowRunReference {
  readonly id: string
  readonly version: typeof SHADOW_RUN_SCHEMA_VERSION
  readonly instrumentId: SupportedInstrumentId
  readonly startedAt: TimestampMs
  readonly plannedEndAt: TimestampMs
  readonly status: ShadowRunStatusKind
  readonly versions: ShadowVersions
  readonly sourceConstraints: ShadowSourceConstraints
  readonly createdAt: TimestampMs
  readonly contentHash: string
}

export interface ShadowInsertResult {
  readonly outcome: 'inserted' | 'duplicate'
  readonly id: string
  readonly contentHash: string
}

export interface ShadowRunStatus {
  readonly id: string
  readonly version: typeof SHADOW_STATUS_VERSION
  readonly runId: string
  readonly status: ShadowRunStatusKind
  readonly recordedAt: TimestampMs
  readonly reportHash?: string
  readonly reason: string
  readonly contentHash: string
}

function canonicalRunId(instrumentId: string): string {
  const sanitized = instrumentId.replace(/[^A-Z0-9-]/g, '')
  return `shadow:${sanitized.length === 0 ? 'unknown' : sanitized}`
}

export function createShadowRunStart(
  startedAt: number,
  instrumentId: SupportedInstrumentId,
  overrides: { readonly id?: string } = {},
): ShadowRunStart {
  const id = overrides.id ?? canonicalRunId(instrumentId)
  const body = {
    id,
    version: SHADOW_RUN_SCHEMA_VERSION,
    instrumentId,
    startedAt: startedAt as TimestampMs,
    plannedEndAt: (startedAt + SHADOW_DURATION_MS) as TimestampMs,
    status: 'collecting' as const,
    versions: DEFAULT_VERSIONS,
    sourceConstraints: DEFAULT_SOURCE_CONSTRAINTS,
  }
  return { ...body, contentHash: contentHashFor(body) }
}

export function defaultShadowRunStart(
  startedAt: number,
  instrumentId: SupportedInstrumentId,
): ShadowRunStart {
  return createShadowRunStart(startedAt, instrumentId)
}

const VALID_STATUSES: readonly ShadowRunStatusKind[] = [
  'collecting',
  'ready_for_review',
  'insufficient_evidence',
  'go',
  'no_go',
]

export function createShadowStatusRecord(
  runId: string,
  status: ShadowRunStatusKind,
  recordedAt: number,
  overrides: { readonly reportHash?: string; readonly reason?: string } = {},
): ShadowRunStatus {
  if (!VALID_STATUSES.includes(status))
    throw new Error(`Unknown shadow status: ${status}`)
  const reason = overrides.reason ?? 'shadow_run_event'
  const body = {
    id: `status:${runId}:${contentHashFor({
      runId,
      status,
      recordedAt,
      reportHash: overrides.reportHash ?? null,
      reason,
    }).slice(0, 16)}`,
    version: SHADOW_STATUS_VERSION,
    runId,
    status,
    recordedAt: recordedAt as TimestampMs,
    ...(overrides.reportHash === undefined
      ? {}
      : { reportHash: overrides.reportHash }),
    reason,
  }
  return { ...body, contentHash: contentHashFor(body) }
}
