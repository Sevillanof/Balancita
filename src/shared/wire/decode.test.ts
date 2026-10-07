import { describe, expect, it } from 'vitest'
import { record } from './decode.ts'

describe('record', () => {
  it('keeps plain objects and turns everything else into an empty one', () => {
    const value = { a: 1 }
    expect(record(value)).toBe(value)
    for (const other of [null, undefined, [1], 'x', 3, true])
      expect(record(other)).toEqual({})
  })
})
