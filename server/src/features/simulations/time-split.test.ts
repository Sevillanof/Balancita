import { describe, expect, it } from 'vitest'
import type { TimestampMs } from '../../domain/contracts.ts'
import { splitByTime } from './time-split.ts'

function stamped(count: number): readonly TimestampMs[] {
  return Array.from(
    { length: count },
    (_, index) => (1_000 + index) as TimestampMs,
  )
}

describe('time-based selection/validation split', () => {
  it('splits 70/30 by default on time order, never randomly', () => {
    const entries = stamped(10)
    const { selection, validation, cutTimestamp } = splitByTime(
      entries,
      0.7,
      (entry) => entry,
    )
    expect(selection).toHaveLength(7)
    expect(validation).toHaveLength(3)
    expect(cutTimestamp).toBe(validation[0])
    expect([...selection, ...validation]).toEqual([...entries])
  })

  it('accepts a parameterized selection share', () => {
    const entries = stamped(10)
    const { selection, validation } = splitByTime(
      entries,
      0.5,
      (entry) => entry,
    )
    expect(selection).toHaveLength(5)
    expect(validation).toHaveLength(5)
  })

  it('rejects shares that would empty either slice', () => {
    const entries = stamped(4)
    expect(() => splitByTime(entries, 0, (entry) => entry)).toThrowError(
      /selection share/i,
    )
    expect(() => splitByTime(entries, 1, (entry) => entry)).toThrowError(
      /selection share/i,
    )
    expect(() => splitByTime(entries, 0.2, (entry) => entry)).toThrowError(
      /empty/,
    )
    expect(() => splitByTime([], 0.7, (entry) => entry)).toThrowError(/empty/)
  })
})
