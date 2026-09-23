import { describe, expect, it } from 'vitest'
import type { TechnicalFeatureSnapshot, TimestampMs } from '../contracts.ts'
import { generateForecast } from '../forecast-engine.ts'
import {
  SIMULATION_CANDIDATES,
  candidateForRuleVersion,
} from './candidate-manifest.ts'
import { resolveSimulationRule, runSimulationRule } from './rule-registry.ts'

function snapshotWith(
  values: Record<string, number>,
): TechnicalFeatureSnapshot {
  return {
    version: 'technical-features.v1',
    asOfTimestamp: 1_000 as TimestampMs,
    isClosed: true,
    ready: true,
    warmUp: { requiredCandles: 34, availableCandles: 40, missingCandles: 0 },
    values,
  }
}

const BULLISH = snapshotWith({
  sma: 90,
  ema: 90,
  rsi: 70,
  macdLine: 2,
  macdSignal: 1,
  macdHistogram: 1,
  atr: 1,
  structuralSlope: 0.8,
})

function engineProbabilitiesFor(snapshot: TechnicalFeatureSnapshot): {
  up: number
  down: number
  flat: number
} {
  const record = generateForecast({
    id: 'rule-parity',
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
    technicalFeatureSnapshot: snapshot,
    dataFreshness: { ageMs: 0, isStale: false, clockInverted: false },
    dataGaps: {
      gapCount: 0,
      expectedOpportunities: 1,
      rate: 0,
      sequenceAvailable: true,
    },
    newsEvidenceReferences: [],
  })
  return {
    up: record.probabilityUp,
    down: record.probabilityDown,
    flat: record.probabilityFlat,
  }
}

describe('simulation rule registry', () => {
  it('resolves every manifest rule version', () => {
    for (const candidate of SIMULATION_CANDIDATES) {
      expect(() => resolveSimulationRule(candidate.ruleVersion)).not.toThrow()
    }
  })

  it('refuses rule versions outside the manifest', () => {
    expect(() => resolveSimulationRule('technical-direction.v9')).toThrowError(
      /unknown simulation rule/i,
    )
  })

  it('keeps the default path byte-identical to the production engine', () => {
    const expected = engineProbabilitiesFor(BULLISH)
    const actual = runSimulationRule(
      candidateForRuleVersion('technical-direction.v1'),
      100,
      BULLISH,
    )
    expect(actual.abstentionReason).toBeUndefined()
    expect(actual.up).toBe(expected.up)
    expect(actual.down).toBe(expected.down)
    expect(actual.flat).toBe(expected.flat)
  })

  it('emits finite probabilities that sum to one for every candidate', () => {
    for (const candidate of SIMULATION_CANDIDATES) {
      const output = runSimulationRule(candidate, 100, BULLISH)
      for (const value of [output.up, output.down, output.flat]) {
        expect(Number.isFinite(value)).toBe(true)
        expect(value).toBeGreaterThanOrEqual(0)
        expect(value).toBeLessThanOrEqual(1)
      }
      expect(output.up + output.down + output.flat).toBeCloseTo(1, 9)
    }
  })

  it('widens the RSI band so a mild reading stays neutral', () => {
    // RSI-only snapshot: every other vote is 0 because those values are
    // absent, isolating the band-width effect.
    const mildBullish = snapshotWith({ rsi: 56 })
    const narrow = runSimulationRule(
      candidateForRuleVersion('technical-direction.v1'),
      100,
      mildBullish,
    )
    const wide = runSimulationRule(
      candidateForRuleVersion('simulation-rsi-wide.v1'),
      100,
      mildBullish,
    )
    expect(narrow.up).toBeGreaterThan(narrow.flat)
    expect(wide.flat).toBeGreaterThanOrEqual(wide.up)
  })

  it('swaps SMA for EMA in the trend vote', () => {
    const mixed = snapshotWith({ ...BULLISH.values, sma: 110, ema: 90 })
    const smaRule = runSimulationRule(
      candidateForRuleVersion('technical-direction.v1'),
      100,
      mixed,
    )
    const emaRule = runSimulationRule(
      candidateForRuleVersion('simulation-ema-trend.v1'),
      100,
      mixed,
    )
    expect(emaRule.up).toBeGreaterThan(smaRule.up)
  })

  it('abstains through the ATR gate on volatile snapshots', () => {
    const volatile = snapshotWith({
      ...BULLISH.values,
      atr: 5,
    })
    const gated = runSimulationRule(
      candidateForRuleVersion('simulation-atr-gated.v1'),
      100,
      volatile,
    )
    expect(gated.abstentionReason).toBe('atr_gate')
    expect(gated.up).toBeCloseTo(1 / 3, 9)
  })
})
