import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { FuturesMarketStore } from './futures-market-store.ts'
import { createRetentionRunner } from './retention-runner.ts'

const H = 3_600_000
const DAY = 24 * H
const NOW = 100 * DAY
const policy = {
  tickerRetentionMs: 24 * H,
  eventRetentionMs: 7 * DAY,
  rawKeepMs: 24 * H,
}
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

function ticker(seq: number, receivedAt: number) {
  return {
    type: 'ticker',
    productId: 'PF_XBTUSD',
    seq,
    eventTime: receivedAt - 5,
    receivedAt,
    persistedAt: receivedAt + 5,
    epoch: 1,
    bid: '1',
    ask: '2',
    mark: '1.5',
    raw: { bid_size: '1' },
  }
}

function seeded(oldTickers: number, freshTickers: number) {
  const dir = mkdtempSync(join(tmpdir(), 'balancita-retention-'))
  dirs.push(dir)
  const path = join(dir, 'market.sqlite')
  const store = new FuturesMarketStore(path)
  for (let i = 0; i < oldTickers; i += 1)
    store.append(ticker(i + 1, NOW - 3 * DAY + i))
  for (let i = 0; i < freshTickers; i += 1)
    store.append(ticker(oldTickers + i + 1, NOW - 1000 + i))
  return { store, path }
}

const count = (path: string): number => {
  const db = new DatabaseSync(path)
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM paper_futures_market_events')
    .get() as { n: number }
  db.close()
  return Number(row.n)
}

describe('retention runner', () => {
  it('deletes everything past the retention in small steps and keeps what is recent', async () => {
    const { store, path } = seeded(1_200, 50)
    const cycles: unknown[] = []
    const runner = createRetentionRunner({
      store,
      policy,
      clock: () => NOW,
      startBatch: 100,
      maxBatch: 100,
      yieldLoop: () => Promise.resolve(),
      onCycle: (cycle) => cycles.push(cycle),
    })
    const cycle = await runner.run()
    expect(cycle?.done).toBe(true)
    expect(cycle?.deleted).toBe(1_200)
    expect(cycle?.steps).toBeGreaterThanOrEqual(12) // 1 200 rows in batches of 100, never one big call
    expect(cycles).toHaveLength(1)
    store.close()
    expect(count(path)).toBe(50)
    const db = new DatabaseSync(path)
    expect(() => db.exec('DELETE FROM paper_futures_market_events')).toThrow(
      /immutable/,
    ) // the guard is back after every step
    db.close()
  })

  it('gives the event loop a turn between steps', async () => {
    const { store } = seeded(600, 10)
    let turns = 0
    let stepsBeforeTurn = 0
    let maxRun = 0
    const runner = createRetentionRunner({
      store,
      policy,
      clock: () => NOW,
      startBatch: 100,
      maxBatch: 100,
      yieldLoop: () => {
        turns += 1
        maxRun = Math.max(maxRun, stepsBeforeTurn)
        stepsBeforeTurn = 0
        return Promise.resolve()
      },
      now: (() => {
        // every call to now() is one half of a step
        return () => {
          stepsBeforeTurn += 0.5
          return stepsBeforeTurn
        }
      })(),
    })
    await runner.run()
    expect(turns).toBeGreaterThanOrEqual(5)
    store.close()
  })

  it('shrinks the batch when a step is slow and grows it when steps are fast', async () => {
    const { store } = seeded(3_000, 0)
    let clockMs = 0
    let stepMs = 200 // slow
    const runner = createRetentionRunner({
      store,
      policy,
      clock: () => NOW,
      targetStepMs: 40,
      startBatch: 800,
      minBatch: 50,
      maxBatch: 5_000,
      yieldLoop: () => Promise.resolve(),
      cycleBudgetMs: 1_000_000,
      now: () => {
        clockMs += stepMs / 2 // two reads per step
        return clockMs
      },
    })
    await runner.run()
    expect(runner.batchSize).toBeLessThan(800)
    const { store: second } = seeded(3_000, 0)
    stepMs = 1 // fast
    const fast = createRetentionRunner({
      store: second,
      policy,
      clock: () => NOW,
      targetStepMs: 40,
      startBatch: 100,
      maxBatch: 5_000,
      yieldLoop: () => Promise.resolve(),
      now: () => {
        clockMs += stepMs / 2
        return clockMs
      },
    })
    await fast.run()
    expect(fast.batchSize).toBeGreaterThan(100)
    store.close()
    second.close()
  })

  it('stops a cycle at its time budget and continues in the next one', async () => {
    const { store, path } = seeded(2_000, 5)
    let clockMs = 0
    const runner = createRetentionRunner({
      store,
      policy,
      clock: () => NOW,
      startBatch: 100,
      maxBatch: 100,
      cycleBudgetMs: 25,
      yieldLoop: () => Promise.resolve(),
      now: () => (clockMs += 10),
    })
    const first = await runner.run()
    expect(first?.done).toBe(false)
    while (!(await runner.run())?.done) {
      // keep going cycle by cycle
    }
    store.close()
    expect(count(path)).toBe(5)
  })

  it('ignores a call while a cycle is still running', async () => {
    const { store } = seeded(500, 0)
    const runner = createRetentionRunner({
      store,
      policy,
      clock: () => NOW,
      startBatch: 50,
      maxBatch: 50,
      yieldLoop: () => new Promise((resolve) => setTimeout(resolve, 2)),
    })
    const first = runner.run()
    expect(await runner.run()).toBeUndefined()
    expect((await first)?.done).toBe(true)
    store.close()
  })

  it('keeps ingesting while old rows are deleted: the loop is free between steps', async () => {
    const { store, path } = seeded(4_000, 0)
    let ingested = 0
    const feeder = setInterval(() => {
      store.append(ticker(100_000 + ingested, NOW + ingested))
      ingested += 1
    }, 1)
    const runner = createRetentionRunner({
      store,
      policy,
      clock: () => NOW,
      startBatch: 200,
      maxBatch: 200,
      yieldLoop: () => new Promise((resolve) => setTimeout(resolve, 3)),
    })
    const cycle = await runner.run()
    clearInterval(feeder)
    expect(cycle?.done).toBe(true)
    expect(ingested).toBeGreaterThan(5) // rows arrived during the cycle
    store.close()
    expect(count(path)).toBe(ingested) // every old row gone, every new row kept
  })

  it('legacy mode makes the former single call and reports its duration', async () => {
    const { store } = seeded(300, 5)
    const runner = createRetentionRunner({
      store,
      policy,
      clock: () => NOW,
      mode: 'legacy',
    })
    const cycle = await runner.run()
    expect(cycle).toMatchObject({ mode: 'legacy', steps: 1, deleted: 300 })
    store.close()
  })
})
