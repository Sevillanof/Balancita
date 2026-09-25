import { describe, expect, it } from 'vitest'
import {
  getAllCandidates,
  SIMULATION_MANIFEST_VERSION,
} from './candidate-manifest.ts'
const SIMULATION_CANDIDATES = getAllCandidates()
import {
  empiricalPriorBefore,
  probabilitiesForShift,
} from './fixed-proportional-shift.ts'

describe('experimental candidate manifest', () => {
  it('keeps the original 24 candidate ids and adds versioned candidates 25–28', () => {
    expect(SIMULATION_CANDIDATES).toHaveLength(28)
    expect(
      SIMULATION_CANDIDATES.slice(24).map(({ candidateId }) => candidateId),
    ).toEqual([
      'micro-trend-pullback',
      'micro-bollinger-reversion',
      'micro-donchian-breakout',
      'micro-regime-adapter',
    ])
    expect(SIMULATION_MANIFEST_VERSION).not.toBe('simulations-manifest.v2')
  })
})

describe('fixed proportional shift probability map', () => {
  it('sums to exactly one in left-to-right order for expanding empirical priors and both shifts', () => {
    for (let total = 1; total <= 40; total += 1) {
      for (let up = 0; up <= total; up += 1) {
        for (let down = 0; down <= total - up; down += 1) {
          const flat = total - up - down
          const prior = {
            up: up / total,
            down: down / total,
            flat: flat / total,
          }
          for (const shift of [0, 1] as const) {
            const probabilities = probabilitiesForShift(prior, shift)
            expect(
              probabilities.up + probabilities.down + probabilities.flat,
            ).toBe(1)
            expect(
              [probabilities.up, probabilities.down, probabilities.flat].every(
                (value) => Number.isFinite(value) && value >= 0 && value <= 1,
              ),
            ).toBe(true)
          }
        }
      }
    }
  })

  it('builds an expanding prior only from labels matured strictly before as-of', () => {
    expect(
      empiricalPriorBefore(
        [
          { maturedAt: 10, label: 'up' },
          { maturedAt: 20, label: 'down' },
          { maturedAt: 30, label: 'flat' },
        ],
        20,
      ),
    ).toEqual({ up: 1, down: 0, flat: 0 })
    expect(
      empiricalPriorBefore([{ maturedAt: 20, label: 'flat' }], 20),
    ).toBeNull()
    expect(
      empiricalPriorBefore([{ maturedAt: 30, label: 'flat' }], 20),
    ).toBeNull()
  })

  it('retains the matured prior at zero shift and transfers directional mass proportionally', () => {
    const prior = probabilitiesForShift({ up: 0.2, down: 0.5, flat: 0.3 }, 0)
    expect(prior).toEqual({ up: 0.2, down: 0.5, flat: 0.3 })
    expect(prior.up + prior.down + prior.flat).toBe(1)
    const shifted = probabilitiesForShift({ up: 0.2, down: 0.5, flat: 0.3 }, 1)
    expect(shifted.up).toBeCloseTo(0.35, 12)
    expect(shifted.down).toBeCloseTo(0.40625, 12)
    expect(shifted.flat).toBeCloseTo(0.24375, 12)
  })

  it('clamps a directional shift to the available simplex mass', () => {
    const result = probabilitiesForShift({ up: 0.9, down: 0.1, flat: 0 }, 1)
    expect(result).toEqual({ up: 1, down: 0, flat: 0 })
    expect(result.up + result.down + result.flat).toBe(1)
    for (const prior of [
      { up: 0, down: 0.25, flat: 0.75 },
      { up: 0.85, down: 0.1, flat: 0.05 },
      { up: 1, down: 0, flat: 0 },
    ]) {
      const shifted = probabilitiesForShift(prior, 1)
      expect(
        Object.values(shifted).every(
          (value) => Number.isFinite(value) && value >= 0 && value <= 1,
        ),
      ).toBe(true)
      expect(shifted.up + shifted.down + shifted.flat).toBe(1)
    }
  })
})
