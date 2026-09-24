import type { TimestampMs } from '../../domain/contracts.ts'

export interface TimeSplit<T> {
  readonly selection: readonly T[]
  readonly validation: readonly T[]
  readonly cutTimestamp: TimestampMs
}

/**
 * Walk-forward split of time-ordered entries, keeping every entry with the
 * same timestamp together. The first `selectionShare` fraction of unique
 * chronological timestamps is selection; the rest is locked validation.
 * Caller-ordered input remains chronological, and no random partition occurs.
 */
export function splitByTime<T>(
  entries: readonly T[],
  selectionShare: number,
  timestampOf: (entry: T) => TimestampMs = (entry) =>
    (entry as unknown as { asOfTimestamp: TimestampMs }).asOfTimestamp,
): TimeSplit<T> {
  if (
    !Number.isFinite(selectionShare) ||
    selectionShare <= 0 ||
    selectionShare >= 1
  )
    throw new Error(
      'Selection share must be a finite fraction strictly between 0 and 1.',
    )
  if (entries.length === 0) throw new Error('Cannot split an empty entry list.')
  const timestamps = [...new Set(entries.map(timestampOf))]
  const selectionTimestampCount = Math.floor(timestamps.length * selectionShare)
  if (
    selectionTimestampCount === 0 ||
    selectionTimestampCount >= timestamps.length
  )
    throw new Error(
      'Selection share leaves an empty selection or validation slice.',
    )
  const cutTimestamp = timestamps[selectionTimestampCount]!
  const selection = entries.filter((entry) => timestampOf(entry) < cutTimestamp)
  const validation = entries.filter(
    (entry) => timestampOf(entry) >= cutTimestamp,
  )
  return { selection, validation, cutTimestamp }
}
