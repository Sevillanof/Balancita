import { describe, expect, it } from 'vitest'
import type { TimestampMs } from '../../domain/contracts.ts'
import {
  FORECAST_RULE_VERSION,
  generateForecast,
  type ForecastEngineInput,
} from '../forecasts/forecast-engine.ts'
import { MarketStore } from '../market-data/market-store.ts'
import { makeScenarioDataset } from '../replay/__fixtures__/replay-scenario.ts'
import { ReplayRunStore } from '../replay/replay-run-store.ts'
import { ReplayRunService } from '../replay/replay-service.ts'
import {
  candidateForRuleVersion,
  getAllCandidates,
} from './candidate-manifest.ts'
const SIMULATION_CANDIDATES = getAllCandidates()
import { runSimulationRule } from './rule-registry.ts'

function baseInput(): ForecastEngineInput {
  return {
    id: 'dispatch-parity',
    version: '1',
    createdAt: 1_000 as TimestampMs,
    asOfTimestamp: 1_000 as TimestampMs,
    eventCutoff: 1_000 as TimestampMs,
    horizon: '15m',
    referencePrice: 100,
    candles: [
      {
        eventTimeEnd: 1_000 as TimestampMs,
        bucketEnd: 1_000 as TimestampMs,
        close: 100,
        isClosed: true,
        status: 'live',
      },
    ],
    technicalFeatureSnapshot: {
      version: 'technical-features.v1',
      asOfTimestamp: 1_000 as TimestampMs,
      isClosed: true,
      ready: true,
      warmUp: { requiredCandles: 1, availableCandles: 1, missingCandles: 0 },
      values: {
        sma: 90,
        ema: 90,
        rsi: 70,
        macdLine: 2,
        macdSignal: 1,
        macdHistogram: 1,
        atr: 1,
        structuralSlope: 0.8,
      },
    },
    dataFreshness: { ageMs: 0, isStale: false, clockInverted: false },
    dataGaps: {
      gapCount: 0,
      expectedOpportunities: 1,
      rate: 0,
      sequenceAvailable: true,
    },
    newsEvidenceReferences: [],
  }
}

function makeService() {
  const store = new MarketStore({
    path: ':memory:',
    clock: () => 7 as TimestampMs,
  })
  const runStore = new ReplayRunStore({
    path: ':memory:',
    clock: () => 7 as TimestampMs,
  })
  const service = new ReplayRunService({
    store,
    runStore,
    clock: () => 7 as TimestampMs,
  })
  return { store, runStore, service }
}

describe('forecast engine rule dispatch', () => {
  it('keeps the default path on the production rule version', () => {
    const record = generateForecast(baseInput())
    expect(record.ruleVersion).toBe(FORECAST_RULE_VERSION)
    expect(record.abstained).toBe(false)
  })

  it('dispatches a manifest rule and stamps its version', () => {
    const candidate = candidateForRuleVersion('simulation-rsi-wide.v1')
    const record = generateForecast({
      ...baseInput(),
      ruleVersion: candidate.ruleVersion,
      ruleConfig: candidate.rule,
    })
    const expected = runSimulationRule(
      candidate,
      100,
      baseInput().technicalFeatureSnapshot,
    )
    expect(record.ruleVersion).toBe('simulation-rsi-wide.v1')
    expect(record.probabilityUp).toBe(expected.up)
    expect(record.probabilityDown).toBe(expected.down)
    expect(record.probabilityFlat).toBe(expected.flat)
  })

  it('refuses rule versions outside the manifest', () => {
    expect(() =>
      generateForecast({
        ...baseInput(),
        ruleVersion: 'technical-direction.v9',
        ruleConfig: candidateForRuleVersion('technical-direction.v1').rule,
      }),
    ).toThrowError(/unknown simulation rule/i)
  })

  it('honors rule-level ATR abstention without weakening engine gates', () => {
    const candidate = candidateForRuleVersion('simulation-atr-gated.v1')
    const volatile = {
      ...baseInput(),
      technicalFeatureSnapshot: {
        ...baseInput().technicalFeatureSnapshot,
        values: { ...baseInput().technicalFeatureSnapshot.values, atr: 5 },
      },
      ruleVersion: candidate.ruleVersion,
      ruleConfig: candidate.rule,
    }
    const gated = generateForecast(volatile)
    expect(gated.abstained).toBe(true)
    expect(gated.abstentionReason).toBe('atr_gate')

    const engineGated = generateForecast({ ...volatile, candles: [] })
    expect(engineGated.abstained).toBe(true)
    expect(engineGated.abstentionReason).not.toBe('atr_gate')
  })
})

describe('replay service candidate wiring', () => {
  it('runs the default candidate exactly as before when no candidate is given', () => {
    const { service } = makeService()
    const dataset = makeScenarioDataset({ candles: 90 })
    const result = service.run({
      dataset,
      horizon: '15m',
      runId: 'run-default-compat',
    })
    for (const forecast of result.forecasts) {
      expect(forecast.ruleVersion).toBe(FORECAST_RULE_VERSION)
      expect(forecast.technicalFeatureSnapshot.paramSetVersion).toBeUndefined()
    }
  })

  it('stamps rule version and param lineage for a manifest candidate', () => {
    const { service } = makeService()
    const dataset = makeScenarioDataset({ candles: 90 })
    const result = service.run({
      dataset,
      horizon: '15m',
      runId: 'run-period-preset',
      candidateId: 'period-preset-fast',
    })
    expect(result.forecasts.length).toBeGreaterThan(0)
    for (const forecast of result.forecasts) {
      expect(forecast.ruleVersion).toBe('simulation-period-fast.v1')
      expect(forecast.technicalFeatureSnapshot.paramSetVersion).toBe(
        'simulation-periods-fast.v1',
      )
    }
  })

  it('encodes the candidate id in the default run id', () => {
    const { service } = makeService()
    const dataset = makeScenarioDataset({ candles: 90 })
    const result = service.run({
      dataset,
      horizon: '15m',
      candidateId: 'strict-quorum',
    })
    expect(result.run.id).toContain('strict-quorum')
    expect(result.forecasts[0]!.replayRunId).toBe(result.run.id)
  })

  it('refuses unknown candidate ids', () => {
    const { service } = makeService()
    const dataset = makeScenarioDataset({ candles: 90 })
    expect(() =>
      service.run({
        dataset,
        horizon: '15m',
        candidateId: 'no-such-candidate',
      }),
    ).toThrowError(/unknown simulation candidate/i)
  })

  it('covers every manifest candidate without crashing', () => {
    const { service } = makeService()
    for (const candidate of SIMULATION_CANDIDATES) {
      const dataset = makeScenarioDataset({ candles: 60 })
      const result = service.run({
        dataset,
        horizon: '15m',
        runId: `run-cover-${candidate.candidateId}`,
        candidateId: candidate.candidateId,
      })
      expect(result.forecasts.length).toBe(dataset.candles.length)
    }
  })
})
