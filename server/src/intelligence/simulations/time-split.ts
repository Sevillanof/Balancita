import type { TimestampMs } from '../contracts.ts'

export interface TimeSplit<T> {
  readonly selection: readonly T[]
  readonly validation: readonly T[]
  readonly cutTimestamp: TimestampMs
}

/**
 * Walk-forward split of time-ordered entries. The first `selectionShare`
 * fraction is the selection slice; the rest is the locked validation slice.
 * Index-based on caller-ordered input (callers pass time-ascending data), so
 * no random partition of the time series is ever performed.
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
  const cutIndex = Math.floor(entries.length * selectionShare)
  if (cutIndex === 0 || cutIndex >= entries.length)
    throw new Error(
      'Selection share leaves an empty selection or validation slice.',
    )
  const selection = entries.slice(0, cutIndex)
  const validation = entries.slice(cutIndex)
  return { selection, validation, cutTimestamp: timestampOf(validation[0]!) }
}
