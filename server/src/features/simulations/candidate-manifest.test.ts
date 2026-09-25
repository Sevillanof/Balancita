import { describe, expect, it } from 'vitest'
import {
  SIMULATION_MANIFEST_VERSION,
  SIMULATION_NEUTRAL_BAND,
  getActiveCandidates,
  getAllCandidates,
  assertKnownSimulationRule,
  candidateForId,
  manifestHashFor,
} from './candidate-manifest.ts'

const SIMULATION_CANDIDATES = getAllCandidates()

describe('simulation candidate manifest', () => {
  it('pre-registers three distinct composite hypotheses from existing features', () => {
    const composites = SIMULATION_CANDIDATES.filter(
      (candidate) => candidate.family === 'composite',
    )
    expect(composites.map((candidate) => candidate.candidateId)).toEqual([
      'composite-trend-confirmation',
      'composite-rsi-atr-reversion',
      'composite-session-trend',
    ])
    expect(composites[0]?.rule).toMatchObject({
      useEmaForTrend: true,
      macdSource: 'histogram',
      slopeEpsilon: 0.25,
    })
    expect(composites[1]?.rule).toMatchObject({
      rsiContrarian: true,
      atrGateRatio: 0.025,
    })
    expect(composites[2]?.rule).toMatchObject({
      useEmaForTrend: true,
      sessionGateUtc: [7, 17],
      quorum: 2,
    })
    expect(composites.every((candidate) => candidate.theory.length > 20)).toBe(
      true,
    )
  })

  it('is versioned as v4 with the original 24 plus four native 15m candidates', () => {
    expect(SIMULATION_MANIFEST_VERSION).toBe('simulations-manifest.v4')
    expect(SIMULATION_CANDIDATES.length).toBe(28)
  })

  it('archives the original 24 while keeping the four micro candidates active', () => {
    expect(getAllCandidates()).toHaveLength(28)
    expect(
      getActiveCandidates().map(({ candidateId, status }) => [
        candidateId,
        status,
      ]),
    ).toEqual([
      ['micro-trend-pullback', 'active'],
      ['micro-bollinger-reversion', 'active'],
      ['micro-donchian-breakout', 'active'],
      ['micro-regime-adapter', 'active'],
    ])
    expect(
      getAllCandidates()
        .slice(0, 24)
        .every(({ status }) => status === 'archived'),
    ).toBe(true)
    expect(candidateForId('technical-default').status).toBe('archived')
  })

  it('has unique candidate ids and rule versions', () => {
    const ids = SIMULATION_CANDIDATES.map((candidate) => candidate.candidateId)
    const rules = SIMULATION_CANDIDATES.map(
      (candidate) => candidate.ruleVersion,
    )
    expect(new Set(ids).size).toBe(ids.length)
    expect(new Set(rules).size).toBe(rules.length)
  })

  it('keeps every v1 entry untouched: same order, ids, versions, families', () => {
    const v1 = SIMULATION_CANDIDATES.slice(0, 11).map((candidate) => ({
      candidateId: candidate.candidateId,
      family: candidate.family,
      ruleVersion: candidate.ruleVersion,
      paramSetVersion: candidate.paramSetVersion,
    }))
    expect(v1).toEqual([
      {
        candidateId: 'technical-default',
        family: 'default',
        ruleVersion: 'technical-direction.v1',
        paramSetVersion: 'technical-defaults.v1',
      },
      {
        candidateId: 'rsi-wide-band',
        family: 'rsi-band',
        ruleVersion: 'simulation-rsi-wide.v1',
        paramSetVersion: 'technical-defaults.v1',
      },
      {
        candidateId: 'ema-trend',
        family: 'ema-trend',
        ruleVersion: 'simulation-ema-trend.v1',
        paramSetVersion: 'technical-defaults.v1',
      },
      {
        candidateId: 'macd-line-signal',
        family: 'macd-signal',
        ruleVersion: 'simulation-macd-line.v1',
        paramSetVersion: 'technical-defaults.v1',
      },
      {
        candidateId: 'slope-epsilon-gate',
        family: 'slope-gate',
        ruleVersion: 'simulation-slope-gate.v1',
        paramSetVersion: 'technical-defaults.v1',
      },
      {
        candidateId: 'weighted-rsi-double',
        family: 'vote-weights',
        ruleVersion: 'simulation-weighted-rsi.v1',
        paramSetVersion: 'technical-defaults.v1',
      },
      {
        candidateId: 'strict-quorum',
        family: 'quorum',
        ruleVersion: 'simulation-strict-quorum.v1',
        paramSetVersion: 'technical-defaults.v1',
      },
      {
        candidateId: 'steep-prob-map',
        family: 'prob-map',
        ruleVersion: 'simulation-steep-probmap.v1',
        paramSetVersion: 'technical-defaults.v1',
      },
      {
        candidateId: 'atr-gated',
        family: 'atr-abstention',
        ruleVersion: 'simulation-atr-gated.v1',
        paramSetVersion: 'technical-defaults.v1',
      },
      {
        candidateId: 'period-preset-fast',
        family: 'period-preset',
        ruleVersion: 'simulation-period-fast.v1',
        paramSetVersion: 'simulation-periods-fast.v1',
      },
      {
        candidateId: 'sma-deadband',
        family: 'sma-deadband',
        ruleVersion: 'simulation-sma-deadband.v1',
        paramSetVersion: 'technical-defaults.v1',
      },
    ])
  })

  it('covers each v1 variant family exactly once', () => {
    const families = SIMULATION_CANDIDATES.slice(0, 11)
      .map((candidate) => candidate.family)
      .sort()
    expect(families).toEqual(
      [
        'atr-abstention',
        'default',
        'ema-trend',
        'macd-signal',
        'period-preset',
        'prob-map',
        'quorum',
        'rsi-band',
        'sma-deadband',
        'slope-gate',
        'vote-weights',
      ].sort(),
    )
  })

  it('preserves the thirteen theory-motivated v2 candidates from new families', () => {
    const v2 = SIMULATION_CANDIDATES.slice(11, 24).map((candidate) => ({
      candidateId: candidate.candidateId,
      family: candidate.family,
      ruleVersion: candidate.ruleVersion,
    }))
    expect(v2).toEqual([
      {
        candidateId: 'ema-cross-trend',
        family: 'ema-cross',
        ruleVersion: 'simulation-ema-cross.v1',
      },
      {
        candidateId: 'atr-deadband',
        family: 'atr-deadband',
        ruleVersion: 'simulation-atr-deadband.v1',
      },
      {
        candidateId: 'rsi-contrarian',
        family: 'rsi-contrarian',
        ruleVersion: 'simulation-rsi-contrarian.v1',
      },
      {
        candidateId: 'drop-sma-leg',
        family: 'drop-leg',
        ruleVersion: 'simulation-drop-sma.v1',
      },
      {
        candidateId: 'drop-rsi-leg',
        family: 'drop-leg',
        ruleVersion: 'simulation-drop-rsi.v1',
      },
      {
        candidateId: 'drop-macd-leg',
        family: 'drop-leg',
        ruleVersion: 'simulation-drop-macd.v1',
      },
      {
        candidateId: 'drop-slope-leg',
        family: 'drop-leg',
        ruleVersion: 'simulation-drop-slope.v1',
      },
      {
        candidateId: 'ladder-patient',
        family: 'strategy-ladder',
        ruleVersion: 'simulation-ladder-patient.v1',
      },
      {
        candidateId: 'ladder-twitchy',
        family: 'strategy-ladder',
        ruleVersion: 'simulation-ladder-twitchy.v1',
      },
      {
        candidateId: 'session-gate',
        family: 'session-gate',
        ruleVersion: 'simulation-session-gate.v1',
      },
      {
        candidateId: 'composite-trend-confirmation',
        family: 'composite',
        ruleVersion: 'simulation-composite-trend.v1',
      },
      {
        candidateId: 'composite-rsi-atr-reversion',
        family: 'composite',
        ruleVersion: 'simulation-composite-reversion.v1',
      },
      {
        candidateId: 'composite-session-trend',
        family: 'composite',
        ruleVersion: 'simulation-composite-session.v1',
      },
    ])
  })

  it('appends the four separately versioned micro strategies', () => {
    expect(
      SIMULATION_CANDIDATES.slice(24).map(
        ({ candidateId, ruleVersion, microStrategy }) => ({
          candidateId,
          ruleVersion,
          microStrategy,
        }),
      ),
    ).toEqual([
      {
        candidateId: 'micro-trend-pullback',
        ruleVersion: 'simulation-micro-trend-pullback-15m.v1',
        microStrategy: 'trend-pullback',
      },
      {
        candidateId: 'micro-bollinger-reversion',
        ruleVersion: 'simulation-micro-bollinger-reversion-15m.v1',
        microStrategy: 'bollinger-reversion',
      },
      {
        candidateId: 'micro-donchian-breakout',
        ruleVersion: 'simulation-micro-donchian-breakout-15m.v1',
        microStrategy: 'donchian-breakout',
      },
      {
        candidateId: 'micro-regime-adapter',
        ruleVersion: 'simulation-micro-regime-adapter-15m.v1',
        microStrategy: 'regime-adapter',
      },
    ])
    expect(
      SIMULATION_CANDIDATES.slice(24).every(
        (candidate) =>
          candidate.probabilityMapVersion === 'fixed-proportional-shift-v1',
      ),
    ).toBe(true)
    expect(SIMULATION_CANDIDATES[24]?.params).toMatchObject({
      smaPeriod: 50,
      emaPeriod: 21,
      rsiPeriod: 14,
      atrPeriod: 14,
    })
  })

  it('records a one-line theory justification for every candidate', () => {
    for (const candidate of SIMULATION_CANDIDATES) {
      expect(candidate.theory.trim().length).toBeGreaterThan(0)
    }
    expect(candidateForId('rsi-contrarian').theory).toMatch(/mean-reversion/i)
  })

  it('keeps the default candidate on the production rule and params', () => {
    const baseline = SIMULATION_CANDIDATES.find(
      (candidate) => candidate.family === 'default',
    )
    expect(baseline?.ruleVersion).toBe('technical-direction.v1')
    expect(baseline?.paramSetVersion).toBe('technical-defaults.v1')
  })

  it('freezes the outcome band for the whole comparison', () => {
    expect(SIMULATION_NEUTRAL_BAND).toBe(0.0015)
  })

  it('hashes deterministically', () => {
    const first = manifestHashFor(SIMULATION_CANDIDATES)
    const second = manifestHashFor([...SIMULATION_CANDIDATES].reverse())
    expect(first).toMatch(/^[0-9a-f]{64}$/)
    expect(second).toBe(first)
  })

  it('does not change manifest identity when only operational status changes', () => {
    const reclassified = SIMULATION_CANDIDATES.map((candidate) => ({
      ...candidate,
      status:
        candidate.status === 'active'
          ? ('archived' as const)
          : ('active' as const),
    }))
    expect(manifestHashFor(reclassified)).toBe(
      manifestHashFor(SIMULATION_CANDIDATES),
    )
  })

  it('refuses rule versions outside the manifest', () => {
    expect(() =>
      assertKnownSimulationRule('technical-direction.v9'),
    ).toThrowError(/unknown simulation rule/i)
    for (const candidate of SIMULATION_CANDIDATES) {
      expect(() =>
        assertKnownSimulationRule(candidate.ruleVersion),
      ).not.toThrow()
    }
  })
})
