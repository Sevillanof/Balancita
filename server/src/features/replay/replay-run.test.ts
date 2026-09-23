import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MINUTE_MS,
  REPLAY_T0,
  makeScenarioDataset,
} from './__fixtures__/replay-scenario.ts'
import { createReplayCheckpoint, createReplayRunStart } from './replay-run.ts'
import { ReplayRunStore } from './replay-run-store.ts'
import {
  ReplayClockError,
  ReplayVirtualClock,
  virtualClockFromDataset,
} from './replay-virtual-clock.ts'

const directories: string[] = []

function makePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'balancita-replay-run-'))
  directories.push(directory)
  return join(directory, 'replay-runs.sqlite')
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

describe('replay virtual clock', () => {
  it('starts at the first closed candle and only advances on closed buckets', () => {
    const dataset = makeScenarioDataset({ candles: 5 })
    const clock = virtualClockFromDataset(dataset)

    expect(clock.now()).toBe(REPLAY_T0)
    const first = dataset.candles[0]
    expect(first).toBeDefined()
    clock.advanceTo(first!.bucketEnd)
    expect(clock.now()).toBe(REPLAY_T0 + MINUTE_MS)
    clock.advanceTo(dataset.candles[4]!.bucketEnd)
    expect(clock.now()).toBe(REPLAY_T0 + 5 * MINUTE_MS)
  })

  it('rejects a backwards advance so no checkpoint can look ahead', () => {
    const clock = new ReplayVirtualClock(REPLAY_T0 + MINUTE_MS)
    expect(() => clock.advanceTo(REPLAY_T0)).toThrow(ReplayClockError)
    expect(clock.now()).toBe(REPLAY_T0 + MINUTE_MS)
  })
})

describe('replay run contracts', () => {
  it('derives the run window and candle count from the frozen dataset', () => {
    const dataset = makeScenarioDataset({ candles: 6 })
    const run = createReplayRunStart({ id: 'run-1', dataset, horizon: '15m' })

    expect(run.version).toBe('replay-run.v1')
    expect(run.instrumentId).toBe('BTC-EUR')
    expect(run.datasetHash).toBe(dataset.datasetHash)
    expect(run.importVersion).toBe(dataset.importVersion)
    expect(run.interval).toBe(dataset.interval)
    expect(run.horizon).toBe('15m')
    expect(run.startedAt).toBe(dataset.candles[0]!.bucketStart)
    expect(run.endedAt).toBe(dataset.candles.at(-1)!.bucketEnd)
    expect(run.candleCount).toBe(6)
    expect(run.contentHash).toHaveLength(64)
  })

  it('derives a checkpoint whose virtual time is the closed candle bucket end', () => {
    const dataset = makeScenarioDataset({ candles: 3 })
    const candle = dataset.candles[1]!
    const checkpoint = createReplayCheckpoint({
      runId: 'run-1',
      index: 1,
      candle,
      forecastId: 'forecast-1',
      forecastHash: 'a'.repeat(64),
      evaluatedOutcomeCount: 0,
    })

    expect(checkpoint.version).toBe('replay-checkpoint.v1')
    expect(checkpoint.virtualTime).toBe(candle.bucketEnd)
    expect(checkpoint.bucketStart).toBe(candle.bucketStart)
    expect(checkpoint.bucketEnd).toBe(candle.bucketEnd)
    expect(checkpoint.contentHash).toHaveLength(64)
  })
})

describe('replay run store', () => {
  it('persists runs and ordered checkpoints without touching the live database', () => {
    const path = makePath()
    const dataset = makeScenarioDataset({ candles: 4 })
    const start = createReplayRunStart({ id: 'run-1', dataset, horizon: '15m' })

    const store = new ReplayRunStore({ path })
    expect(store.saveRun(start, 111).outcome).toBe('inserted')
    expect(store.saveRun(start, 111).outcome).toBe('duplicate')
    expect(store.getRun('run-1')?.status).toBe('running')
    expect(store.runCount()).toBe(1)

    for (const [index, candle] of dataset.candles.entries()) {
      const checkpoint = createReplayCheckpoint({
        runId: 'run-1',
        index,
        candle,
        forecastId: `forecast-${index}`,
        forecastHash: 'b'.repeat(64),
        evaluatedOutcomeCount: index,
      })
      expect(store.saveCheckpoint(checkpoint, 111).outcome).toBe('inserted')
    }
    expect(store.checkpointCount('run-1')).toBe(4)
    expect(store.listCheckpoints('run-1').map((entry) => entry.index)).toEqual([
      0, 1, 2, 3,
    ])

    store.finalizeRun('run-1', {
      status: 'completed',
      checkpointCount: 4,
      forecastCount: 4,
      outcomeCount: 2,
    })
    expect(store.getRun('run-1')).toMatchObject({
      status: 'completed',
      checkpointCount: 4,
      forecastCount: 4,
      outcomeCount: 2,
    })
    store.close()

    const reopened = new ReplayRunStore({ path })
    expect(reopened.getRun('run-1')?.status).toBe('completed')
    expect(reopened.listCheckpoints('run-1')).toHaveLength(4)
    reopened.close()
  })

  it('supports an in-memory store for replay tests', () => {
    const store = new ReplayRunStore({ path: ':memory:' })
    const dataset = makeScenarioDataset({ candles: 2 })
    store.saveRun(
      createReplayRunStart({ id: 'run-mem', dataset, horizon: '15m' }),
      1,
    )
    expect(store.listRuns()).toHaveLength(1)
    store.close()
  })
})
