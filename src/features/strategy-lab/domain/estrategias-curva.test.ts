import { describe, expect, it } from 'vitest'
import { barrasDeNeto } from './estrategias-curva.ts'

describe('net bars', () => {
  it('sizes the lengths by net, the larger one filling the track', () => {
    const [oficial, variante] = barrasDeNeto(97.7, 53.63)
    expect(oficial).toBe(100)
    expect(variante).toBeCloseTo(54.9, 1)
  })

  it('uses the size of a loss and shows nothing when both are zero', () => {
    expect(barrasDeNeto(-20, 10)).toEqual([100, 50])
    expect(barrasDeNeto(0, 0)).toEqual([0, 0])
  })
})
