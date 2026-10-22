import { describe, expect, it } from 'vitest'
import {
  LIQUIDATION_LOSS_SHARE,
  simulate,
  type SimResult,
} from './leverage-sim.ts'
import type {
  AnalyzerCell,
  AnalyzerEvent,
} from '../infrastructure/analyzer-api.ts'

const cell = (patch: Partial<AnalyzerCell> = {}): AnalyzerCell => ({
  id: 'move|PF_XBTUSD|5|follow|5',
  kind: 'move',
  product: 'PF_XBTUSD',
  window: 5,
  direction: 'follow',
  horizon: 5,
  events: 1,
  events_exported: 1,
  gross_bp: 0,
  excess_bp: 0,
  ic90_low_bp: null,
  p_holm: 1,
  ...patch,
})

const ev = (
  t: number,
  s: 1 | -1,
  r: number,
  up = 0,
  dn = 0,
  f = 0,
): AnalyzerEvent => ({ t, s, h: { '5': { r, up, dn, f } } })

const run = (
  events: AnalyzerEvent[],
  leverage = 1,
  margin = 100,
  patch: Partial<AnalyzerCell> = {},
): SimResult =>
  simulate(cell(patch), leverage, margin, {
    events: { 'PF_XBTUSD|move|5': events },
    round_trip_cost_bp: { PF_XBTUSD: 10 },
  })

describe('simulate', () => {
  it('usa la mitad del margen como límite', () => {
    expect(LIQUIDATION_LOSS_SHARE).toBe(0.5)
  })

  it('operación ganadora: 50 pb bruto - 10 de coste con 2x y 100 USD', () => {
    const out = run([ev(1, 1, 50, 60, -5)], 2)
    // nocional 200: neto 40 pb = 0,80 USD; coste 0,20; bruto 1,00
    expect(out.netUsd).toBeCloseTo(0.8)
    expect(out.costUsd).toBeCloseTo(0.2)
    expect(out.grossUsd).toBeCloseTo(1)
    expect(out.hitRate).toBe(100)
    expect(out.directionRate).toBe(100)
    expect(out.liquidations).toBe(0)
  })

  it('perdedora, y dirección acertada pero sin cubrir costes', () => {
    const out = run([ev(1, 1, 5, 8, -2), ev(2, 1, -30, 0, -40)], 1)
    // 1: neto -5 pb = -0,05 (dirección bien, neto mal); 2: neto -40 pb = -0,40
    expect(out.netUsd).toBeCloseTo(-0.45)
    expect(out.hitRate).toBe(0)
    expect(out.directionRate).toBe(50)
    expect(out.worstUsd).toBeCloseTo(-0.4)
    expect(out.maxDrawdownUsd).toBeCloseTo(0.45)
    expect(out.maxDrawdownPct).toBeCloseTo(0.45)
  })

  it('liquidada: pierde todo el margen', () => {
    // 10x: límite 500 pb en contra. Largo con mínimo -600 pb, aunque cierre en +20.
    const out = run([ev(1, 1, 20, 30, -600)], 10, 250)
    expect(out.liquidations).toBe(1)
    expect(out.trades[0].liquidated).toBe(true)
    expect(out.netUsd).toBe(-250)
    expect(out.worstUsd).toBe(-250)
    expect(out.maxDrawdownPct).toBe(100)
  })

  it('justo en el límite se liquida; justo debajo no', () => {
    expect(run([ev(1, 1, 0, 0, -500)], 10).liquidations).toBe(1)
    expect(run([ev(1, 1, 0, 0, -499)], 10).liquidations).toBe(0)
  })

  it('funding en contra de un largo y a favor de un corto', () => {
    const largo = run([ev(1, 1, 100, 100, 0, 20)], 1)
    // neto 100 - 10 - 20 = 70 pb = 0,70 USD; funding pagado 0,20
    expect(largo.netUsd).toBeCloseTo(0.7)
    expect(largo.fundingUsd).toBeCloseTo(0.2)
    const corto = run([ev(1, -1, -100, 0, -100, 20)], 1)
    // d = -1: bruto 100, funding -20 (cobra) -> 100 - 10 + 20 = 110 pb
    expect(corto.netUsd).toBeCloseTo(1.1)
    expect(corto.fundingUsd).toBeCloseTo(-0.2)
  })

  it('revertir invierte la dirección y la excursión adversa', () => {
    // s=+1, fade => d=-1 (corto). Adversa = up = 700 pb; a 20x el límite es 250 => liquida.
    const out = run([ev(1, 1, -40, 700, -50)], 20, 100, { direction: 'fade' })
    expect(out.liquidations).toBe(1)
    const sin = run([ev(1, 1, -40, 100, -50)], 2, 100, { direction: 'fade' })
    // bruto 40 - 10 = 30 pb sobre 200 = 0,60
    expect(sin.netUsd).toBeCloseTo(0.6)
    expect(sin.directionRate).toBe(100)
  })

  it('piso en -margen sin liquidación', () => {
    // 3x: límite 1666 pb; r=-4000 con dn=-1000 (no liquida): -120 % -> piso.
    const out = run([ev(1, 1, -4000, 0, -1000)], 3)
    expect(out.liquidations).toBe(0)
    expect(out.netUsd).toBe(-100)
    expect(out.grossUsd).toBeCloseTo(-100 + 0.3)
  })

  it('ordena por tiempo y arma la curva', () => {
    const out = run([ev(2, 1, 110), ev(1, 1, 10, 10, 0)])
    expect(out.trades.map((t) => t.t)).toEqual([1, 2])
    expect(out.equity).toHaveLength(3)
    expect(out.equity[0]).toBe(0)
    expect(out.equity[2]).toBeCloseTo(out.netUsd)
  })

  it('sin eventos devuelve ceros, sin NaN', () => {
    const out = run([])
    expect(out.n).toBe(0)
    for (const value of [
      out.netUsd,
      out.grossUsd,
      out.hitRate,
      out.directionRate,
      out.maxDrawdownPct,
      out.worstUsd,
    ])
      expect(value).toBe(0)
    expect(out.equity).toEqual([0])
  })
})
