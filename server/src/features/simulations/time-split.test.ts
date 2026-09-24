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

  it('keeps entries sharing a timestamp in the same slice', () => {
    const entries = [
      { id: 'a', timestamp: 1_000 },
      { id: 'b', timestamp: 1_000 },
      { id: 'c', timestamp: 2_000 },
      { id: 'd', timestamp: 3_000 },
      { id: 'e', timestamp: 4_000 },
    ]

    const split = splitByTime(
      entries,
      0.5,
      (entry) => entry.timestamp as TimestampMs,
    )

    expect(split.selection.map((entry) => entry.timestamp)).toEqual([
      1_000, 1_000, 2_000,
    ])
    expect(split.validation.map((entry) => entry.timestamp)).toEqual([
      3_000, 4_000,
    ])
    expect(split.cutTimestamp).toBe(3_000)
  })

  it('applies selection share to unique chronological timestamps', () => {
    const entries = [
      { id: 'a', timestamp: 1_000 },
      { id: 'b', timestamp: 1_000 },
      { id: 'c', timestamp: 1_000 },
      { id: 'd', timestamp: 2_000 },
      { id: 'e', timestamp: 3_000 },
      { id: 'f', timestamp: 4_000 },
    ]

    const split = splitByTime(
      entries,
      0.5,
      (entry) => entry.timestamp as TimestampMs,
    )

    expect(new Set(split.selection.map((entry) => entry.timestamp)).size).toBe(
      2,
    )
    expect(new Set(split.validation.map((entry) => entry.timestamp)).size).toBe(
      2,
    )
  })

  it('keeps uneven timestamp groups intact when measuring the share chronologically', () => {
    const entries = [
      ...Array.from({ length: 4 }, (_, index) => ({
        id: `first-${index}`,
        timestamp: 1_000,
      })),
      { id: 'second', timestamp: 2_000 },
      ...Array.from({ length: 2 }, (_, index) => ({
        id: `third-${index}`,
        timestamp: 3_000,
      })),
      { id: 'fourth', timestamp: 4_000 },
      ...Array.from({ length: 3 }, (_, index) => ({
        id: `fifth-${index}`,
        timestamp: 5_000,
      })),
    ]

    const split = splitByTime(
      entries,
      0.6,
      (entry) => entry.timestamp as TimestampMs,
    )

    expect(split.selection.map((entry) => entry.id)).toEqual([
      'first-0',
      'first-1',
      'first-2',
      'first-3',
      'second',
      'third-0',
      'third-1',
    ])
    expect(split.validation.map((entry) => entry.id)).toEqual([
      'fourth',
      'fifth-0',
      'fifth-1',
      'fifth-2',
    ])
    expect(split.cutTimestamp).toBe(4_000)
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
