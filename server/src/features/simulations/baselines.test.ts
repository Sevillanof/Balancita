import { describe, expect, it } from 'vitest'
import {
  momentumBaseline,
  noChangeBaseline,
  uniformBaseline,
} from './baselines.ts'

describe('baseline trio', () => {
  it('uniform baseline always emits one third per class', () => {
    expect(uniformBaseline()).toEqual({
      probabilityUp: 1 / 3,
      probabilityDown: 1 / 3,
      probabilityFlat: 1 / 3,
    })
  })

  it('no-change baseline always predicts flat', () => {
    expect(noChangeBaseline()).toEqual({
      probabilityUp: 0,
      probabilityDown: 0,
      probabilityFlat: 1,
    })
  })

  it('momentum baseline repeats the last observed label', () => {
    expect(momentumBaseline('up')).toEqual({
      probabilityUp: 1,
      probabilityDown: 0,
      probabilityFlat: 0,
    })
    expect(momentumBaseline('down')?.probabilityDown).toBe(1)
    expect(momentumBaseline('flat')?.probabilityFlat).toBe(1)
  })

  it('momentum baseline is uniform before the first label', () => {
    expect(momentumBaseline(null)).toEqual(uniformBaseline())
  })
})
