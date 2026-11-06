import { describe, expect, it } from 'vitest'
import {
  ENGINE_D_RETIRED_DETAIL,
  engineDRetiredFromEnv,
} from './engine-d-retired.ts'

describe('engineDRetiredFromEnv', () => {
  it('is retired only when the launcher says FUTURES_ENGINE_D_RETIRED=1', () => {
    expect(engineDRetiredFromEnv({ FUTURES_ENGINE_D_RETIRED: '1' })).toBe(true)
    expect(engineDRetiredFromEnv({ FUTURES_ENGINE_D_RETIRED: ' 1 ' })).toBe(
      true,
    )
  })
  it('is not retired when absent, 0, blank or anything else (existing behaviour)', () => {
    expect(engineDRetiredFromEnv({})).toBe(false)
    for (const value of ['0', '', 'true', 'yes'])
      expect(engineDRetiredFromEnv({ FUTURES_ENGINE_D_RETIRED: value })).toBe(
        false,
      )
  })
  it('names the retirement and how to turn it back on', () => {
    expect(ENGINE_D_RETIRED_DETAIL).toMatch(/Motor D retirado/)
    expect(ENGINE_D_RETIRED_DETAIL).toMatch(/ENGINE_D_ENABLED=1/)
  })
})
