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

/**
 * Gentle cleanup: one cycle every 30 s that works for at most 6 s, that is 20 %
 * of the time (below the 25 % ceiling), in short transactions of a few hundred
 * rows. The capture never spends more than a fifth of its time deleting.
 */
export const RETENTION_INTERVAL_MS = 30_000
export const RETENTION_CYCLE_BUDGET_MS = 6_000

export interface RetentionRunnerOptions {
  readonly store: Pick<FuturesMarketStore, 'trimRawEvents'>
  /** Folds the WAL back during a cycle (PASSIVE, never blocks); called every `checkpointEverySteps` steps and when a cycle ends. */
  readonly checkpoint?: () => void
  readonly checkpointEverySteps?: number
  /** False while something else needs the database quiet (a backup, a failed integrity check, a wake-up check). */
  readonly canRun?: () => boolean
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
  const minBatch = options.minBatch ?? 100
  const maxBatch = options.maxBatch ?? 1_000
  const budget = options.cycleBudgetMs ?? RETENTION_CYCLE_BUDGET_MS
  const checkpointEvery = options.checkpointEverySteps ?? 20
  const mode = options.mode ?? 'incremental'
  let batch = Math.min(maxBatch, Math.max(minBatch, options.startBatch ?? 500))
  let running = false
  let stopped = false
  let pausedUntil = Number.NEGATIVE_INFINITY
  const paused = (): boolean => clock() < pausedUntil
  const allowed = (): boolean => !paused() && (options.canRun?.() ?? true)
  const checkpoint = (): void => {
    try {
      options.checkpoint?.()
    } catch {
      // A busy WAL is retried at the next step; the cleanup is not the place to fail on it.
    }
  }

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
    while (!stopped && allowed()) {
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
      if (steps % checkpointEvery === 0) checkpoint()
      if (done || now() - cycleStart > budget) break
      await yieldLoop()
    }
    if (deleted > 0 || slimmed > 0) checkpoint()
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
      if (running || stopped || !allowed()) return undefined
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
    /** No cleanup for `ms` (a wake-up from sleep): a running cycle ends at its next step. */
    pauseFor(ms: number): void {
      pausedUntil = Math.max(pausedUntil, clock() + ms)
    },
    get paused(): boolean {
      return paused()
    },
    get running(): boolean {
      return running
    },
    get batchSize(): number {
      return batch
    },
  }
}
