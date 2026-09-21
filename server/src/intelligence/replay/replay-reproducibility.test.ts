import { describe, expect, it } from 'vitest'
import type { TimestampMs } from '../contracts.ts'
import { MarketStore } from '../market/market-store.ts'
import { makeScenarioDataset } from './__fixtures__/replay-scenario.ts'
import { ReplayRunStore } from './replay-run-store.ts'
import { ReplayRunService } from './replay-service.ts'

function runWithClock(clock: () => TimestampMs, importVersion?: string) {
  const store = new MarketStore({ path: ':memory:', clock })
  const runStore = new ReplayRunStore({ path: ':memory:', clock })
  const service = new ReplayRunService({ store, runStore, clock })
  const dataset = makeScenarioDataset({ candles: 60, importVersion })
  const result = service.run({ dataset, horizon: '15m', runId: 'repro-run' })
  return { ...result, datasetHash: dataset.datasetHash }
}

function forecastHashes(forecasts: readonly { contentHash: string }[]) {
  return forecasts.map((forecast) => forecast.contentHash)
}

function outcomeHashes(outcomes: readonly { contentHash: string }[]) {
  return outcomes.map((outcome) => outcome.contentHash)
}

describe('replay reproducibility', () => {
  it('produces identical dataset, forecast and outcome hashes for the same input', () => {
    const first = runWithClock(() => 1 as TimestampMs)
    const second = runWithClock(() => 4_000_000_000_000 as TimestampMs)

    expect(second.datasetHash).toBe(first.datasetHash)
    expect(second.run.datasetHash).toBe(first.run.datasetHash)
    expect(second.report.datasetHash).toBe(first.report.datasetHash)
    expect(forecastHashes(second.forecasts)).toEqual(
      forecastHashes(first.forecasts),
    )
    expect(outcomeHashes(second.outcomes)).toEqual(
      outcomeHashes(first.outcomes),
    )
    expect(second.run.contentHash).toBe(first.run.contentHash)
    expect(second.report.contentHash).toBe(first.report.contentHash)
  })

  it('changes the dataset hash when the import version changes', () => {
    const first = runWithClock(() => 1 as TimestampMs, 'kraken.v1')
    const second = runWithClock(() => 1 as TimestampMs, 'kraken.v2')
    expect(second.datasetHash).not.toBe(first.datasetHash)
  })
})
