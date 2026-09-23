import { describe, expect, it } from 'vitest'
import {
  SIMULATION_MANIFEST_VERSION,
  SIMULATION_NEUTRAL_BAND,
  SIMULATION_CANDIDATES,
  assertKnownSimulationRule,
  manifestHashFor,
} from './candidate-manifest.ts'

describe('simulation candidate manifest', () => {
  it('is versioned and pre-registered with a small candidate set', () => {
    expect(SIMULATION_MANIFEST_VERSION).toBe('simulations-manifest.v1')
    expect(SIMULATION_CANDIDATES.length).toBeGreaterThanOrEqual(10)
    expect(SIMULATION_CANDIDATES.length).toBeLessThanOrEqual(12)
  })

  it('has unique candidate ids and rule versions', () => {
    const ids = SIMULATION_CANDIDATES.map((candidate) => candidate.candidateId)
    const rules = SIMULATION_CANDIDATES.map(
      (candidate) => candidate.ruleVersion,
    )
    expect(new Set(ids).size).toBe(ids.length)
    expect(new Set(rules).size).toBe(rules.length)
  })

  it('covers each required variant family exactly once', () => {
    const families = SIMULATION_CANDIDATES.map(
      (candidate) => candidate.family,
    ).sort()
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
