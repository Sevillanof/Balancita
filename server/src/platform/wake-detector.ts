import { performance } from 'node:perf_hooks'

/** The process stopped running for a while: the machine slept or the loop was frozen. */
export interface WakeEvent {
  /** Wall clock when the jump was noticed. */
  readonly at: number
  /** Wall-clock time that passed between two ticks. */
  readonly gapMs: number
  /** Part of the gap the monotonic clock did not count (time asleep); 0 for a plain stall. */
  readonly sleptMs: number
  readonly kind: 'sleep' | 'stall' | 'clock'
}

export interface WakeDetectorOptions {
  /** A gap between two ticks longer than this is a wake-up (default 2 min). */
  readonly gapMs?: number
  readonly tickMs?: number
  /** Wall clock (ms); a fake one in tests. */
  readonly wall?: () => number
  /** Monotonic clock (ms): it does not advance while the machine sleeps. */
  readonly monotonic?: () => number
  readonly onWake: (event: WakeEvent) => void
}

/**
 * Notices that the machine slept. Every tick compares how much the wall clock
 * advanced with how much the monotonic clock advanced: the monotonic one stops
 * while the Mac sleeps, so a big difference is time asleep. A gap between two
 * ticks above `gapMs` (default 2 min) counts too, even when both clocks agree
 * (a frozen process); a clock set backwards by more than that is reported as
 * `clock`. Timers do not fire while asleep, so the first tick after
 * waking is the one that sees the jump.
 */
export function createWakeDetector(options: WakeDetectorOptions) {
  const wall = options.wall ?? Date.now
  const mono = options.monotonic ?? (() => performance.now())
  const threshold = options.gapMs ?? 120_000
  let lastWall = wall()
  let lastMono = mono()
  let timer: ReturnType<typeof setInterval> | undefined

  const tick = (): WakeEvent | undefined => {
    const nowWall = wall()
    const nowMono = mono()
    const gapMs = nowWall - lastWall
    const drift = gapMs - (nowMono - lastMono)
    lastWall = nowWall
    lastMono = nowMono
    if (gapMs <= threshold && Math.abs(drift) <= threshold) return undefined
    const event: WakeEvent = {
      at: nowWall,
      gapMs,
      sleptMs: Math.round(Math.max(0, drift)),
      kind:
        drift > threshold ? 'sleep' : drift < -threshold ? 'clock' : 'stall',
    }
    options.onWake(event)
    return event
  }

  return {
    tick,
    start(): void {
      if (timer !== undefined) return
      lastWall = wall()
      lastMono = mono()
      timer = setInterval(tick, options.tickMs ?? 5_000)
      timer.unref()
    },
    stop(): void {
      if (timer !== undefined) clearInterval(timer)
      timer = undefined
    },
  }
}
