import { appendFileSync } from 'node:fs'
import { monitorEventLoopDelay } from 'node:perf_hooks'

export interface LoopSample {
  readonly at: number
  readonly windowMs: number
  readonly p50Ms: number
  readonly p99Ms: number
  readonly maxMs: number
}

/**
 * Samples how late the event loop runs its timers, one JSON line per window. A synchronous call (a
 * SQLite delete, a long JSON parse) or a sleeping machine shows up as a large `maxMs`; a healthy
 * network with a blocked process does not. Used to tell "the capture was stopped" from "the network
 * was down" when sources go quiet together.
 */
export function createLoopMonitor(options: {
  file?: string
  windowMs?: number
  clock?: () => number
  /** Windows whose worst delay exceeds this are logged too (default 1 s). */
  warnMs?: number
  log?: (line: string) => void
  onSample?: (sample: LoopSample) => void
}) {
  const clock = options.clock ?? Date.now
  const windowMs = options.windowMs ?? 60_000
  const warnMs = options.warnMs ?? 1_000
  const histogram = monitorEventLoopDelay({ resolution: 10 })
  histogram.enable()
  const toMs = (nanoseconds: number): number =>
    Math.round((nanoseconds / 1e6) * 10) / 10
  const flush = (): LoopSample => {
    const sample: LoopSample = {
      at: clock(),
      windowMs,
      p50Ms: toMs(histogram.percentile(50)),
      p99Ms: toMs(histogram.percentile(99)),
      maxMs: toMs(histogram.max),
    }
    histogram.reset()
    if (options.file !== undefined) {
      try {
        appendFileSync(options.file, `${JSON.stringify(sample)}\n`)
      } catch {
        // Diagnostics never take the capture down.
      }
    }
    if (sample.maxMs > warnMs)
      options.log?.(
        `event loop blocked up to ${sample.maxMs} ms in the last window`,
      )
    options.onSample?.(sample)
    return sample
  }
  const timer = setInterval(flush, windowMs)
  timer.unref()
  return {
    flush,
    stop(): void {
      clearInterval(timer)
      histogram.disable()
    },
  }
}
