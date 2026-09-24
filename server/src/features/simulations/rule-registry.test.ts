import { describe, expect, it } from 'vitest'
import type {
  TechnicalFeatureSnapshot,
  TimestampMs,
} from '../../domain/contracts.ts'
import { generateForecast } from '../forecasts/forecast-engine.ts'
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
  it('resolves legacy rules and refuses to dispatch micro rules without replay state', () => {
    for (const candidate of SIMULATION_CANDIDATES) {
      if (candidate.microStrategy === undefined) {
        expect(() => resolveSimulationRule(candidate.ruleVersion)).not.toThrow()
      } else {
        expect(() => resolveSimulationRule(candidate.ruleVersion)).toThrow(/chronological micro replay/i)
      }
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

  it('emits finite probabilities that sum to one for every legacy candidate', () => {
    for (const candidate of SIMULATION_CANDIDATES.filter(({ microStrategy }) => microStrategy === undefined)) {
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

describe('simulation rule registry v2 families', () => {
  const MIDDAY = Date.parse('2026-09-22T12:00:00Z') as TimestampMs
  const NIGHT = Date.parse('2026-09-22T03:00:00Z') as TimestampMs

  function snapshotAt(
    values: Record<string, number>,
    asOfTimestamp: TimestampMs,
  ): TechnicalFeatureSnapshot {
    return {
      version: 'technical-features.v1',
      asOfTimestamp,
      isClosed: true,
      ready: true,
      warmUp: { requiredCandles: 34, availableCandles: 40, missingCandles: 0 },
      values,
    }
  }

  it('votes the EMA/SMA spread instead of price-vs-basis for ema-cross', () => {
    // Price sits above SMA (default votes up) while EMA sits below SMA
    // (spread votes down): isolates the cross signal from the level signal.
    const snapshot = snapshotWith({ sma: 98, ema: 95 })
    const cross = runSimulationRule(
      candidateForRuleVersion('simulation-ema-cross.v1'),
      100,
      snapshot,
    )
    const level = runSimulationRule(
      candidateForRuleVersion('technical-direction.v1'),
      100,
      snapshot,
    )
    expect(cross.abstentionReason).toBeUndefined()
    expect(cross.down).toBeGreaterThan(cross.up)
    expect(level.up).toBeGreaterThan(level.down)
  })

  it('widens the trend deadband with volatility for atr-deadband', () => {
    // 10 bps above SMA: directional under a fixed zero deadband, neutral
    // when the deadband scales as 0.5x ATR (ATR/price = 5%).
    const snapshot = snapshotWith({ sma: 99.9, atr: 5 })
    const scaled = runSimulationRule(
      candidateForRuleVersion('simulation-atr-deadband.v1'),
      100,
      snapshot,
    )
    const fixed = runSimulationRule(
      candidateForRuleVersion('technical-direction.v1'),
      100,
      snapshot,
    )
    expect(scaled.abstentionReason).toBeUndefined()
    expect(scaled.flat).toBe(0.4)
    expect(fixed.up).toBeGreaterThan(fixed.flat)
  })

  it('flips the RSI vote for the pre-registered contrarian hypothesis', () => {
    const overbought = snapshotWith({ rsi: 70 })
    const contrarian = runSimulationRule(
      candidateForRuleVersion('simulation-rsi-contrarian.v1'),
      100,
      overbought,
    )
    const momentum = runSimulationRule(
      candidateForRuleVersion('technical-direction.v1'),
      100,
      overbought,
    )
    expect(contrarian.down).toBeGreaterThan(contrarian.up)
    expect(momentum.up).toBeGreaterThan(momentum.down)
  })

  it.each([
    ['drop-sma-leg', 'simulation-drop-sma.v1', { sma: 90 }],
    ['drop-rsi-leg', 'simulation-drop-rsi.v1', { rsi: 70 }],
    ['drop-macd-leg', 'simulation-drop-macd.v1', { macdHistogram: 1 }],
    ['drop-slope-leg', 'simulation-drop-slope.v1', { structuralSlope: 0.8 }],
  ] as const)(
    'stays neutral on an isolated %s signal while the default votes',
    (_id, ruleVersion, values) => {
      const snapshot = snapshotWith(values)
      const dropped = runSimulationRule(
        candidateForRuleVersion(ruleVersion),
        100,
        snapshot,
      )
      const full = runSimulationRule(
        candidateForRuleVersion('technical-direction.v1'),
        100,
        snapshot,
      )
      expect(dropped.abstentionReason).toBeUndefined()
      expect(dropped.flat).toBe(0.4)
      expect(full.up).toBeGreaterThan(full.flat)
    },
  )

  it('abstains outside EU hours and votes inside them for session-gate', () => {
    const afterHours = runSimulationRule(
      candidateForRuleVersion('simulation-session-gate.v1'),
      100,
      snapshotAt({ ...BULLISH.values }, NIGHT),
    )
    expect(afterHours.abstentionReason).toBe('session_gate')
    expect(afterHours.up).toBeCloseTo(1 / 3, 9)
    const inSession = runSimulationRule(
      candidateForRuleVersion('simulation-session-gate.v1'),
      100,
      snapshotAt({ ...BULLISH.values }, MIDDAY),
    )
    expect(inSession.abstentionReason).toBeUndefined()
    expect(inSession.up).toBeGreaterThan(inSession.flat)
  })

  it('requires EMA trend, MACD histogram, and slope to agree for composite confirmation', () => {
    const candidate = candidateForRuleVersion('simulation-composite-trend.v1')
    const confirmed = runSimulationRule(candidate, 100, BULLISH)
    const conflicting = runSimulationRule(
      candidate,
      100,
      snapshotWith({ ...BULLISH.values, structuralSlope: -0.8 }),
    )
    expect(confirmed.up).toBeGreaterThan(confirmed.flat)
    expect(conflicting).toEqual({ up: 0.3, down: 0.3, flat: 0.4 })
  })

  it('applies the configured ATR ceiling to the composite RSI reversion hypothesis', () => {
    const gated = runSimulationRule(
      candidateForRuleVersion('simulation-composite-reversion.v1'),
      100,
      snapshotWith({ rsi: 70, atr: 3 }),
    )
    expect(gated.abstentionReason).toBe('atr_gate')
  })

  it.each([
    'simulation-ladder-patient.v1',
    'simulation-ladder-twitchy.v1',
  ] as const)(
    'keeps ladder %s signals identical to the default rule',
    (ruleVersion) => {
      const ladder = runSimulationRule(
        candidateForRuleVersion(ruleVersion),
        100,
        BULLISH,
      )
      const baseline = runSimulationRule(
        candidateForRuleVersion('technical-direction.v1'),
        100,
        BULLISH,
      )
      expect(ladder).toEqual(baseline)
    },
  )
})
