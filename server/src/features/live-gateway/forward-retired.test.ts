import { describe, expect, it } from 'vitest'
import {
  FORWARD_RETIRED_DETAIL,
  forwardRetiredFromEnv,
} from './forward-retired.ts'

describe('forwardRetiredFromEnv', () => {
  it('is retired only when the launcher says FUTURES_FORWARD_RETIRED=1', () => {
    expect(forwardRetiredFromEnv({ FUTURES_FORWARD_RETIRED: '1' })).toBe(true)
    expect(forwardRetiredFromEnv({ FUTURES_FORWARD_RETIRED: ' 1 ' })).toBe(true)
  })
  it('is not retired when absent, 0, blank or anything else (existing behaviour)', () => {
    expect(forwardRetiredFromEnv({})).toBe(false)
    for (const value of ['0', '', 'true', 'yes'])
      expect(forwardRetiredFromEnv({ FUTURES_FORWARD_RETIRED: value })).toBe(
        false,
      )
  })
  it('names the retirement and how to turn it back on', () => {
    expect(FORWARD_RETIRED_DETAIL).toMatch(/Forward retirado/)
    expect(FORWARD_RETIRED_DETAIL).toMatch(/C25-C31/)
    expect(FORWARD_RETIRED_DETAIL).toMatch(/Kronos/)
    expect(FORWARD_RETIRED_DETAIL).toMatch(/FORWARD_ENABLED=1/)
  })
})
