import { describe, expect, it } from 'vitest'
import type { TimestampMs } from '../../domain/contracts.ts'
import { MarketStore } from '../market-data/market-store.ts'
import {
  REPLAY_T0,
  makeScenarioDataset,
} from './__fixtures__/replay-scenario.ts'
import { ReplayRunStore } from './replay-run-store.ts'
import { ReplayRunService } from './replay-service.ts'

const WRONG_WALL_CLOCK = 42

function makeService() {
  const store = new MarketStore({
    path: ':memory:',
    clock: () => WRONG_WALL_CLOCK as TimestampMs,
  })
  const runStore = new ReplayRunStore({
    path: ':memory:',
    clock: () => WRONG_WALL_CLOCK as TimestampMs,
  })
  const service = new ReplayRunService({
    store,
    runStore,
    clock: () => WRONG_WALL_CLOCK as TimestampMs,
  })
  return { store, runStore, service }
}

describe('replay run orchestration', () => {
  it('advances over the frozen dataset one closed candle at a time', () => {
    const { service, runStore } = makeService()
    const dataset = makeScenarioDataset({ candles: 90 })
    const result = service.run({
      dataset,
      horizon: '15m',
      runId: 'run-test',
    })

    expect(result.checkpoints).toHaveLength(dataset.candles.length)
    result.checkpoints.forEach((checkpoint, index) => {
      const candle = dataset.candles[index]!
      expect(checkpoint.index).toBe(index)
      expect(checkpoint.virtualTime).toBe(candle.bucketEnd)
      expect(checkpoint.forecastId).toBe(result.forecasts[index]!.id)
    })
    expect(result.run.status).toBe('completed')
    expect(runStore.getRun('run-test')?.status).toBe('completed')
    expect(runStore.getRun('run-test')?.checkpointCount).toBe(
      dataset.candles.length,
    )
  })

  it('derives every forecast createdAt from the virtual clock, never Date.now()', () => {
    const { service } = makeService()
    const dataset = makeScenarioDataset({ candles: 90 })
    const result = service.run({ dataset, horizon: '15m', runId: 'run-clock' })

    expect(result.forecasts).toHaveLength(dataset.candles.length)
    result.forecasts.forEach((forecast, index) => {
      const candle = dataset.candles[index]!
      expect(forecast.createdAt).toBe(candle.bucketEnd)
      expect(forecast.createdAt).not.toBe(WRONG_WALL_CLOCK)
      expect(forecast.asOfTimestamp).toBe(candle.bucketEnd)
      expect(forecast.eventCutoff).toBe(candle.bucketEnd)
      expect(forecast.sourceMode).toBe('historical_replay')
      expect(forecast.replayRunId).toBe('run-clock')
    })
    expect(result.report.virtualClock).toEqual({
      startedAt: REPLAY_T0,
      endedAt: dataset.candles.at(-1)!.bucketEnd,
    })
  })

  it('produces deterministic, run-scoped outcomes with the existing evaluator', () => {
    const { store, service } = makeService()
    const dataset = makeScenarioDataset({ candles: 90 })
    const result = service.run({ dataset, horizon: '15m', runId: 'run-out' })

    expect(result.outcomes.length).toBeGreaterThan(0)
    const forecastIds = new Set(result.forecasts.map((forecast) => forecast.id))
    for (const outcome of result.outcomes) {
      expect(forecastIds.has(outcome.forecastId)).toBe(true)
      expect(outcome.observedDataIsClosed).toBe(true)
      expect(['up', 'down', 'flat']).toContain(outcome.label)
      expect(store.getForecast(outcome.forecastId)).not.toBeNull()
    }
    const warm = result.forecasts.filter((forecast) => !forecast.abstained)
    expect(warm.length).toBeGreaterThan(0)
    const evaluatedWarm = result.outcomes.filter(
      (outcome) =>
        result.forecasts.find((forecast) => forecast.id === outcome.forecastId)
          ?.abstained === false,
    )
    expect(evaluatedWarm.length).toBeGreaterThan(0)

    const counts = result.checkpoints.map(
      (checkpoint) => checkpoint.evaluatedOutcomeCount,
    )
    expect(counts).toEqual([...counts].sort((left, right) => left - right))
    expect(counts.at(-1)).toBe(result.outcomes.length)
  })
})
