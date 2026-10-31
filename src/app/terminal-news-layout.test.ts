import { describe, expect, it } from 'vitest'
import { paginateNewsHeights } from './terminal-news-layout.ts'

describe('viewport news pagination', () => {
  it('fits the maximal consecutive cards at the exact height boundary', () => {
    expect(paginateNewsHeights([60, 80, 70, 50], 148, 8)).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ])
    expect(paginateNewsHeights([60, 80, 70, 50], 147, 8)).toEqual([
      { start: 0, end: 1 },
      { start: 1, end: 2 },
      { start: 2, end: 4 },
    ])
  })

  it('covers every item once and expands capacity beyond three when space allows', () => {
    const heights = [50, 50, 50, 50, 50, 50, 50]
    const pages = paginateNewsHeights(heights, 282, 8)
    expect(pages).toEqual([
      { start: 0, end: 5 },
      { start: 5, end: 7 },
    ])
    expect(
      pages?.flatMap(({ start, end }) => heights.slice(start, end)),
    ).toEqual(heights)
  })

  it('reports insufficient space rather than clipping a card', () => {
    expect(paginateNewsHeights([61], 60)).toBeNull()
    expect(paginateNewsHeights([40], 0)).toBeNull()
    expect(paginateNewsHeights([], 0)).toEqual([])
  })

  it('rejects invalid measurements explicitly', () => {
    expect(() => paginateNewsHeights([NaN], 100)).toThrow(RangeError)
    expect(() => paginateNewsHeights([0], 100)).toThrow(RangeError)
    expect(() => paginateNewsHeights([20], -1)).toThrow(RangeError)
  })
})
