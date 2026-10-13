import type { FuturesMarketStore } from './futures-market-store.ts'

export interface RetentionPolicy {
  readonly tickerRetentionMs: number
  readonly eventRetentionMs: number
  readonly rawKeepMs: number
}

export interface RetentionCycle {
  readonly at: number
  readonly mode: 'incremental' | 'legacy'
  readonly steps: number
  readonly deleted: number
  readonly slimmed: number
  readonly done: boolean
  readonly totalMs: number
  /** Longest single synchronous call: how long the event loop was held at worst. */
  readonly maxStepMs: number
  readonly batchSize: number
}

export interface RetentionRunnerOptions {
  readonly store: Pick<FuturesMarketStore, 'trimRawEvents'>
  readonly policy: RetentionPolicy
  readonly clock?: () => number
  /** Wall clock in ms with sub-millisecond precision, to time a step. */
  readonly now?: () => number
  /** Gives the event loop a turn between two steps (default `setImmediate` plus a short pause). */
  readonly yieldLoop?: () => Promise<void>
  /** A step should hold the loop no longer than this; the batch shrinks or grows to stay near it (default 40 ms). */
  readonly targetStepMs?: number
  readonly minBatch?: number
  readonly maxBatch?: number
  readonly startBatch?: number
  /** Stop a cycle after this much wall time even if not caught up; the next cycle continues (default 20 s). */
  readonly cycleBudgetMs?: number
  /** `legacy` reproduces the former single call of 20 batches of 5 000 rows (for before/after measurement). */
  readonly mode?: 'incremental' | 'legacy'
  readonly onCycle?: (cycle: RetentionCycle) => void
}

const defaultYield = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 5))

/**
 * Runs the capture's online retention without holding its event loop. `trimRawEvents` is synchronous
 * (node:sqlite), so one call deletes a batch of rows and returns; the runner makes many small calls
 * and lets the loop run between them. The batch size adapts to keep each call near `targetStepMs`.
 * One cycle at a time: a cycle that is still running makes the next `run()` a no-op.
 */
export function createRetentionRunner(options: RetentionRunnerOptions) {
  const clock = options.clock ?? Date.now
  const now = options.now ?? (() => performance.now())
  const yieldLoop = options.yieldLoop ?? defaultYield
  const target = options.targetStepMs ?? 40
  const minBatch = options.minBatch ?? 50
  const maxBatch = options.maxBatch ?? 5_000
  const budget = options.cycleBudgetMs ?? 20_000
  const mode = options.mode ?? 'incremental'
  let batch = Math.min(maxBatch, Math.max(minBatch, options.startBatch ?? 500))
  let running = false
  let stopped = false

  const legacyCycle = (): RetentionCycle => {
    const at = clock()
    const started = now()
    const result = options.store.trimRawEvents({ now: at, ...options.policy })
    const elapsed = now() - started
    return {
      at,
      mode: 'legacy',
      steps: 1,
      deleted: result.deleted,
      slimmed: result.slimmed,
      done: result.done,
      totalMs: elapsed,
      maxStepMs: elapsed,
      batchSize: 5_000,
    }
  }

  const incrementalCycle = async (): Promise<RetentionCycle> => {
    const at = clock()
    const cycleStart = now()
    let steps = 0
    let deleted = 0
    let slimmed = 0
    let maxStepMs = 0
    let done = false
    while (!stopped) {
      const started = now()
      // A small pass over the freed pages per step (no-op unless auto_vacuum=INCREMENTAL).
      const result = options.store.trimRawEvents(
        { now: clock(), ...options.policy },
        1,
        { batchSize: batch, vacuumPages: 200 },
      )
      const elapsed = now() - started
      steps += 1
      deleted += result.deleted
      slimmed += result.slimmed
      maxStepMs = Math.max(maxStepMs, elapsed)
      if (elapsed > target * 1.5)
        batch = Math.max(minBatch, Math.floor(batch / 2))
      else if (elapsed < target / 4)
        batch = Math.min(maxBatch, Math.ceil(batch * 1.5))
      done = result.done
      if (done || now() - cycleStart > budget) break
      await yieldLoop()
    }
    return {
      at,
      mode: 'incremental',
      steps,
      deleted,
      slimmed,
      done,
      totalMs: now() - cycleStart,
      maxStepMs,
      batchSize: batch,
    }
  }

  return {
    /** One cycle; `undefined` when another is still running or the runner was stopped. */
    async run(): Promise<RetentionCycle | undefined> {
      if (running || stopped) return undefined
      running = true
      try {
        const cycle =
          mode === 'legacy' ? legacyCycle() : await incrementalCycle()
        options.onCycle?.(cycle)
        return cycle
      } finally {
        running = false
      }
    },
    stop(): void {
      stopped = true
    },
    get batchSize(): number {
      return batch
    },
  }
}
