import { describe, expect, it } from 'vitest'
import { parseTimestampMs, type TimestampMs } from '../../domain/contracts.ts'
import { MarketStore } from '../market-data/market-store.ts'
import { makeForecast, makeOutcome } from '../shadow-runs/shadow-fixtures.ts'
import { ShadowRunService } from '../shadow-runs/shadow-services.ts'
import { createIntelligenceSnapshot } from '../observability/stream.ts'
import {
  MINUTE_MS,
  REPLAY_T0,
  makeScenarioDataset,
} from './__fixtures__/replay-scenario.ts'
import { ReplayRunStore } from './replay-run-store.ts'
import { ReplayRunService } from './replay-service.ts'

const DAY = 24 * 3_600_000
const START = REPLAY_T0
const WINDOW_END = START + 30 * DAY + 1
const WRONG_WALL_CLOCK = 1

const time = (value: number): TimestampMs => {
  const result = parseTimestampMs(value)
  if (!result.valid) throw new Error('test timestamp must be valid')
  return result.value
}

function makeHarness() {
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

function seedShadowEvidence(store: MarketStore) {
  const shadow = makeForecast({
    id: 'shadow-1',
    asOfTimestamp: START + 5 * MINUTE_MS,
    createdAt: WINDOW_END,
  })
  store.insertForecast(shadow)
  store.insertOutcome(makeOutcome(shadow))
  return shadow
}

describe('historical/live evidence isolation', () => {
  it('keeps shadow_live forecasts out of the replay report and vice versa', () => {
    const { store, service } = makeHarness()
    const shadow = seedShadowEvidence(store)

    const dataset = makeScenarioDataset({ candles: 40 })
    const replay = service.run({
      dataset,
      horizon: '15m',
      runId: 'replay-run-1',
    })
    const other = makeScenarioDataset({ candles: 25, priceStep: 20 })
    service.run({ dataset: other, horizon: '15m', runId: 'replay-run-2' })

    expect(store.listForecasts({ sourceMode: 'shadow_live' })).toEqual([shadow])
    expect(
      store.listForecasts({ sourceMode: 'historical_replay' }),
    ).toHaveLength(65)

    expect(replay.report.outcome.forecastCount).toBe(40)
    expect(replay.report.runId).toBe('replay-run-1')
    expect(
      replay.forecasts.every(
        (forecast) =>
          forecast.sourceMode === 'historical_replay' &&
          forecast.replayRunId === 'replay-run-1',
      ),
    ).toBe(true)
    expect(
      replay.forecasts.some((forecast) => forecast.id === 'shadow-1'),
    ).toBe(false)

    const rescoped = service.buildReport('replay-run-1')
    expect(rescoped.outcome.forecastCount).toBe(40)
    expect(rescoped.outcome.evaluatedOutcomeCount).toBe(replay.outcomes.length)
  })

  it('scopes the shadow report, status and decision path to shadow_live only', () => {
    const { store, service } = makeHarness()
    seedShadowEvidence(store)
    const dataset = makeScenarioDataset({ candles: 40 })
    service.run({ dataset, horizon: '15m', runId: 'replay-run-1' })

    const shadow = new ShadowRunService({
      store,
      instrumentId: 'BTC-EUR',
      clock: () => time(WINDOW_END),
    })
    shadow.start(START)

    const status = shadow.status(WINDOW_END)
    expect(status.computedStatus).toBe('insufficient_evidence')
    expect(status.evaluatedOutcomeCount).toBe(1)

    const built = shadow.buildReport(WINDOW_END)
    expect(built.report.outcome.forecastCount).toBe(1)
    expect(built.report.outcome.evaluatedOutcomeCount).toBe(1)

    const decided = shadow.decide({
      decision: 'no_go',
      actor: 'test',
      reason: 'isolation',
      at: WINDOW_END,
    })
    expect(decided.outcome).toBe('inserted')
  })

  it('never surfaces a historical_replay forecast in the intelligence snapshot', () => {
    const { store, service } = makeHarness()
    const shadow = seedShadowEvidence(store)
    const dataset = makeScenarioDataset({ candles: 40 })
    service.run({ dataset, horizon: '15m', runId: 'replay-run-1' })

    const snapshot = createIntelligenceSnapshot({
      collectorEnabled: true,
      marketStore: store,
      staleAfterMs: 15_000,
      clock: () => WINDOW_END,
    })

    expect(snapshot.summaries.forecast).toMatchObject({
      status: 'available',
      id: shadow.id,
    })
  })
})
