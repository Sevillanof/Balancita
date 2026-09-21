import type { TimestampMs } from '../contracts.ts'
import type { FrozenReplayDataset } from './replay-contracts.ts'

export const REPLAY_CLOCK_VERSION = 'replay-virtual-clock.v1' as const

export class ReplayClockError extends Error {
  readonly code = 'clock_regression' as const

  constructor(message: string) {
    super(message)
    this.name = 'ReplayClockError'
  }
}

/**
 * Monotonic virtual clock for a replay run. Time only ever comes from closed
 * candles: the initial instant is the first frozen bucket and every advance is
 * the end of a bucket that has already closed. A backwards advance would mean
 * a checkpoint looked ahead, so it fails loudly instead of silently rewinding.
 */
export class ReplayVirtualClock {
  private current: TimestampMs

  constructor(initial: number) {
    if (!Number.isSafeInteger(initial) || initial < 0)
      throw new ReplayClockError(
        'Virtual clock initial time must be a non-negative epoch millisecond.',
      )
    this.current = initial as TimestampMs
  }

  now(): TimestampMs {
    return this.current
  }

  advanceTo(next: number): TimestampMs {
    if (!Number.isSafeInteger(next) || next < 0)
      throw new ReplayClockError(
        'Virtual clock target must be a non-negative epoch millisecond.',
      )
    if (next < this.current)
      throw new ReplayClockError(
        'Virtual clock cannot move backwards to a time before the last closed candle.',
      )
    this.current = next as TimestampMs
    return this.current
  }
}

export function virtualClockFromDataset(
  dataset: FrozenReplayDataset,
): ReplayVirtualClock {
  const first = dataset.candles[0]
  return new ReplayVirtualClock(first === undefined ? 0 : first.bucketStart)
}
