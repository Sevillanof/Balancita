import { describe, expect, it } from 'vitest'
import {
  createRetentionRunner,
  RETENTION_CYCLE_BUDGET_MS,
  RETENTION_INTERVAL_MS,
  type RetentionPolicy,
} from './retention-runner.ts'
import { createWakeGuard } from './wake-guard.ts'

const policy: RetentionPolicy = {
  tickerRetentionMs: 1,
  eventRetentionMs: 1,
  rawKeepMs: 1,
}

/** A store with `rows` old rows that deletes `batchSize` of them per call. */
function fakeStore(rows: number) {
  const calls: { batchSize: number | undefined; at: number }[] = []
  let left = rows
  return {
    calls,
    get left() {
      return left
    },
    trimRawEvents: (
      _policy: unknown,
      _maxBatches?: number,
      options: { batchSize?: number } = {},
    ) => {
      const size = options.batchSize ?? 5_000
      const deleted = Math.min(left, size)
      left -= deleted
      calls.push({ batchSize: options.batchSize, at: 0 })
      return { deleted, slimmed: 0, done: left === 0, batches: 1 }
    },
  }
}

describe('gentle retention', () => {
  it('works at most 20 % of the time and in transactions of at most 1 000 rows', async () => {
    expect(RETENTION_CYCLE_BUDGET_MS / RETENTION_INTERVAL_MS).toBeLessThan(0.25)
    const store = fakeStore(50_000)
    const runner = createRetentionRunner({
      store,
      policy,
      yieldLoop: () => Promise.resolve(),
      targetStepMs: 1_000_000, // every step looks fast, so the batch grows to its cap
    })
    await runner.run()
    expect(
      Math.max(...store.calls.map((c) => c.batchSize ?? 0)),
    ).toBeLessThanOrEqual(1_000)
    expect(
      Math.min(...store.calls.map((c) => c.batchSize ?? 0)),
    ).toBeGreaterThanOrEqual(100)
    expect(runner.batchSize).toBeLessThanOrEqual(1_000)
  })

  it('stops a cycle at the 6 s window even if there is more to delete', async () => {
    let t = 0
    const store = fakeStore(1_000_000)
    const runner = createRetentionRunner({
      store,
      policy,
      now: () => (t += 1_000), // every step "takes" one second of the window
      yieldLoop: () => Promise.resolve(),
    })
    const cycle = await runner.run()
    expect(cycle?.done).toBe(false)
    expect(cycle?.steps).toBeLessThanOrEqual(8)
    expect(cycle?.steps).toBeGreaterThanOrEqual(2)
  })

  it('folds the WAL back every 20 steps and when a cycle that deleted something ends', async () => {
    let checkpoints = 0
    const store = fakeStore(100 * 45)
    const runner = createRetentionRunner({
      store,
      policy,
      startBatch: 100,
      maxBatch: 100,
      minBatch: 100,
      cycleBudgetMs: 1e9,
      checkpoint: () => (checkpoints += 1),
      yieldLoop: () => Promise.resolve(),
    })
    const cycle = await runner.run()
    expect(cycle?.steps).toBe(45)
    // steps 20 and 40, plus the one at the end.
    expect(checkpoints).toBe(3)
  })

  it('does not run while something else needs the database quiet', async () => {
    let allowed = false
    const store = fakeStore(500)
    const runner = createRetentionRunner({
      store,
      policy,
      canRun: () => allowed,
      yieldLoop: () => Promise.resolve(),
    })
    expect(await runner.run()).toBeUndefined()
    expect(store.calls).toHaveLength(0)
    allowed = true
    expect((await runner.run())?.done).toBe(true)
  })
})

describe('cleanup around a wake-up (fake clock)', () => {
  it('pauses for 10 minutes after the machine wakes up, ends a running cycle and resumes by itself', async () => {
    let now = 1_000_000
    const store = fakeStore(10_000)
    const runner = createRetentionRunner({
      store,
      policy,
      clock: () => now,
      startBatch: 100,
      maxBatch: 100,
      minBatch: 100,
      cycleBudgetMs: 1e9,
      yieldLoop: async () => {
        // The Mac sleeps after the third step: the wake-up arrives during the cycle.
        if (store.calls.length === 3)
          guardEvents.push(
            guard.onWake({
              at: now,
              gapMs: 8 * 3_600_000,
              sleptMs: 8 * 3_600_000,
              kind: 'sleep',
            }),
          )
      },
    })
    const reports: unknown[] = []
    const checks: string[] = []
    const guard = createWakeGuard({
      retention: runner,
      dbHealth: {
        afterWake: async () => {
          checks.push('truncate+integrity')
        },
      },
      connections: {
        report: (event) => reports.push(event),
        markGeneral: () => checks.push('fresh-connections'),
      },
      log: () => undefined,
    })
    const guardEvents: Promise<void>[] = []

    const first = await runner.run()
    await Promise.all(guardEvents)
    // The cycle stopped at its next step, well before everything was deleted.
    expect(first?.done).toBe(false)
    expect(store.calls.length).toBeLessThan(10)
    expect(runner.paused).toBe(true)
    expect(checks).toEqual(['fresh-connections', 'truncate+integrity'])
    expect(reports[0]).toMatchObject({ reason: 'despertar', result: 'info' })

    const callsAtWake = store.calls.length
    now += 9 * 60_000
    expect(await runner.run()).toBeUndefined() // still paused at 9 minutes
    expect(store.calls).toHaveLength(callsAtWake)
    now += 2 * 60_000
    const resumed = await runner.run() // 11 minutes: it resumes by itself
    expect(resumed?.done).toBe(true)
    expect(store.left).toBe(0)
  })

  it('does not resume the cleanup while the wake-up check says the database is damaged', async () => {
    let damaged = true
    const store = fakeStore(300)
    const runner = createRetentionRunner({
      store,
      policy,
      canRun: () => !damaged,
      yieldLoop: () => Promise.resolve(),
    })
    expect(await runner.run()).toBeUndefined()
    damaged = false
    expect((await runner.run())?.done).toBe(true)
  })
})
