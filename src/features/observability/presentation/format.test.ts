import { describe, expect, it } from 'vitest'
import { momentLabel } from './format.ts'

describe('momentLabel', () => {
  it('writes the moment in Madrid time, with no UTC label, and its age', () => {
    // 9 nov 2026 22:15:02 UTC = 23:15:02 CET.
    const ms = Date.UTC(2026, 10, 9, 22, 15, 2)
    const label = momentLabel(ms, ms + 41_000)
    expect(label).toContain('23:15:02')
    expect(label).toContain('hace 41 s')
    expect(label).not.toMatch(/UTC/)
  })
  it('says there is no data when there is no moment', () => {
    expect(momentLabel(null, 0)).toBe('Sin datos')
  })
})
