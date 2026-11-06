import { describe, expect, it } from 'vitest'
import {
  barrasDeNeto,
  curvaSaldo,
  dominioDeCurvas,
  puntosSvg,
} from './estrategias-curva.ts'

const ops = [
  { salida_ms: 20, neto_usd: -2 },
  { salida_ms: 10, neto_usd: 5 },
]

describe('equity curve', () => {
  it('accumulates the net of closed trades in exit order as a step line from zero to the end of the window', () => {
    expect(curvaSaldo(ops, 0, 30)).toEqual([
      { t: 0, y: 0 },
      { t: 10, y: 0 },
      { t: 10, y: 5 },
      { t: 20, y: 5 },
      { t: 20, y: 3 },
      { t: 30, y: 3 },
    ])
  })

  it('is flat at zero without trades', () => {
    expect(curvaSaldo([], 0, 30)).toEqual([
      { t: 0, y: 0 },
      { t: 30, y: 0 },
    ])
  })

  it('shares one domain that always contains zero', () => {
    const a = curvaSaldo(ops, 0, 30)
    const b = curvaSaldo([{ salida_ms: 15, neto_usd: 12 }], 0, 30)
    const dominio = dominioDeCurvas([a, b])
    expect(dominio.tMin).toBe(0)
    expect(dominio.tMax).toBe(30)
    expect(dominio.yMin).toBeLessThanOrEqual(0)
    expect(dominio.yMax).toBeGreaterThan(12)
  })

  it('maps points to the drawing box: later is to the right, more is up', () => {
    const dominio = { tMin: 0, tMax: 100, yMin: -10, yMax: 10 }
    const puntos = puntosSvg(
      [
        { t: 0, y: 0 },
        { t: 100, y: 10 },
      ],
      dominio,
      1000,
      200,
    )
    expect(puntos).toBe('0,100 1000,0')
  })
})

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
