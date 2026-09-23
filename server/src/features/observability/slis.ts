import {
  parseTimestampMs,
  type DataFreshness,
  type TimestampMs,
} from '../../domain/contracts.ts'
import {
  invalid,
  issue,
  valid,
  type ValidationIssue,
  type ValidationResult,
} from '../../platform/validation.ts'

export type ClockSkewPolicy = 'reject' | 'clamp_to_zero'

export interface FreshnessInput {
  readonly eventTime: TimestampMs
  readonly displayTime: TimestampMs
  readonly staleAfterMs: number
  readonly clockSkewPolicy?: ClockSkewPolicy
}

export function deriveDataFreshness(
  input: FreshnessInput,
): ValidationResult<DataFreshness> {
  const eventTime = parseTimestampMs(input.eventTime, 'eventTime')
  const displayTime = parseTimestampMs(input.displayTime, 'displayTime')
  const issues: ValidationIssue[] = []
  if (!eventTime.valid) issues.push(...eventTime.issues)
  if (!displayTime.valid) issues.push(...displayTime.issues)
  if (!Number.isFinite(input.staleAfterMs) || input.staleAfterMs < 0) {
    issues.push(
      issue(
        'invalid_threshold',
        'staleAfterMs',
        'Stale threshold must be finite and non-negative.',
      ),
    )
  }
  if (issues.length > 0) return invalid(issues)

  const clockInverted = input.displayTime < input.eventTime
  if (clockInverted && (input.clockSkewPolicy ?? 'reject') === 'reject') {
    return invalid([
      issue(
        'clock_inverted',
        'displayTime',
        'Display time precedes event time.',
      ),
    ])
  }
  const ageMs = clockInverted ? 0 : input.displayTime - input.eventTime
  return valid({
    ageMs,
    isStale: ageMs > input.staleAfterMs,
    clockInverted,
  })
}

export function calculateReceiveLatency(input: {
  readonly eventTime: TimestampMs
  readonly receivedTime: TimestampMs
  readonly clockSkewPolicy?: ClockSkewPolicy
}): ValidationResult<number> {
  const eventTime = parseTimestampMs(input.eventTime, 'eventTime')
  const receivedTime = parseTimestampMs(input.receivedTime, 'receivedTime')
  if (!eventTime.valid || !receivedTime.valid) {
    return invalid([
      ...(!eventTime.valid ? eventTime.issues : []),
      ...(!receivedTime.valid ? receivedTime.issues : []),
    ])
  }
  if (receivedTime.value < eventTime.value) {
    if ((input.clockSkewPolicy ?? 'reject') === 'reject') {
      return invalid([
        issue(
          'clock_inverted',
          'receivedTime',
          'Received time precedes event time.',
        ),
      ])
    }
    return valid(0)
  }
  return valid(receivedTime.value - eventTime.value)
}

export interface PercentileSummary {
  readonly count: number
  readonly p50: number | null
  readonly p95: number | null
}

function nearestRank(
  sorted: readonly number[],
  percentile: number,
): number | null {
  if (sorted.length === 0) return null
  const rank = Math.ceil(percentile * sorted.length)
  return sorted[Math.max(0, rank - 1)] ?? null
}

export function summarizePercentiles(
  samples: readonly number[],
): ValidationResult<PercentileSummary> {
  const issues: ValidationIssue[] = []
  samples.forEach((sample, index) => {
    if (!Number.isFinite(sample) || sample < 0) {
      issues.push(
        issue(
          'invalid_sample',
          `samples[${index}]`,
          'Sample must be finite and non-negative.',
        ),
      )
    }
  })
  if (issues.length > 0) return invalid(issues)
  const sorted = [...samples].sort((left, right) => left - right)
  return valid({
    count: sorted.length,
    p50: nearestRank(sorted, 0.5),
    p95: nearestRank(sorted, 0.95),
  })
}

export interface StaleRateSummary {
  readonly staleCount: number
  readonly totalCount: number
  readonly rate: number | null
}

export function calculateStaleRate(
  staleSnapshots: readonly boolean[],
): ValidationResult<StaleRateSummary> {
  const staleCount = staleSnapshots.filter(Boolean).length
  const totalCount = staleSnapshots.length
  return valid({
    staleCount,
    totalCount,
    rate: totalCount === 0 ? null : staleCount / totalCount,
  })
}

export interface GapRateInput {
  readonly sequences: readonly number[]
  readonly expectedOpportunities: number
}

export interface GapRateSummary {
  readonly gapCount: number
  readonly expectedOpportunities: number
  readonly rate: number | null
  readonly sequenceAvailable: boolean
}

export interface PersistedGapRateInput {
  readonly gapCount: number
  readonly observedMessages: number
  readonly sequenceAvailable: boolean
}

/** Summarizes gaps already detected by the collector without reinterpreting sequence jumps. */
export function summarizeGapTransitions(
  input: PersistedGapRateInput,
): ValidationResult<GapRateSummary> {
  if (
    !Number.isSafeInteger(input.gapCount) ||
    input.gapCount < 0 ||
    !Number.isSafeInteger(input.observedMessages) ||
    input.observedMessages < 0
  ) {
    return invalid([
      issue(
        'invalid_gap_counts',
        'gaps',
        'Gap and observed message counts must be non-negative integers.',
      ),
    ])
  }
  const expectedOpportunities = input.observedMessages + input.gapCount
  return valid({
    gapCount: input.gapCount,
    expectedOpportunities,
    rate:
      expectedOpportunities === 0
        ? null
        : input.gapCount / expectedOpportunities,
    sequenceAvailable: input.sequenceAvailable,
  })
}

export function calculateGapRate(
  input: GapRateInput,
): ValidationResult<GapRateSummary> {
  const issues: ValidationIssue[] = []
  if (
    !Number.isSafeInteger(input.expectedOpportunities) ||
    input.expectedOpportunities < 0
  ) {
    issues.push(
      issue(
        'invalid_denominator',
        'expectedOpportunities',
        'Expected opportunities must be a non-negative integer.',
      ),
    )
  }
  input.sequences.forEach((sequence, index) => {
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      issues.push(
        issue(
          'invalid_sequence',
          `sequences[${index}]`,
          'Sequence must be a non-negative safe integer.',
        ),
      )
    }
  })
  if (issues.length > 0) return invalid(issues)
  if (input.sequences.length === 0) {
    if (input.expectedOpportunities !== 0) {
      return invalid([
        issue(
          'missing_sequence_denominator',
          'expectedOpportunities',
          'No sequence is available, so expected opportunities must be zero.',
        ),
      ])
    }
    return valid({
      gapCount: 0,
      expectedOpportunities: 0,
      rate: null,
      sequenceAvailable: false,
    })
  }
  if (input.expectedOpportunities < input.sequences.length) {
    return invalid([
      issue(
        'denominator_too_small',
        'expectedOpportunities',
        'Expected opportunities cannot be below observed sequence messages.',
      ),
    ])
  }
  let gapCount = 0
  for (let index = 1; index < input.sequences.length; index += 1) {
    const previous = input.sequences[index - 1]
    const current = input.sequences[index]
    if (current <= previous) {
      return invalid([
        issue(
          'sequence_not_increasing',
          `sequences[${index}]`,
          'Sequences must be strictly increasing.',
        ),
      ])
    }
    if (current > previous + 1) gapCount += 1
  }
  return valid({
    gapCount,
    expectedOpportunities: input.expectedOpportunities,
    rate: gapCount / input.expectedOpportunities,
    sequenceAvailable: true,
  })
}

export function validateMetricWindow(input: {
  readonly start: TimestampMs
  readonly end: TimestampMs
}): ValidationResult<{
  readonly start: TimestampMs
  readonly end: TimestampMs
}> {
  const start = parseTimestampMs(input.start, 'start')
  const end = parseTimestampMs(input.end, 'end')
  if (!start.valid || !end.valid) {
    return invalid([
      ...(!start.valid ? start.issues : []),
      ...(!end.valid ? end.issues : []),
    ])
  }
  if (start.value > end.value) {
    return invalid([
      issue(
        'invalid_window',
        'window',
        'Window start cannot be after window end.',
      ),
    ])
  }
  return valid({ start: start.value, end: end.value })
}
