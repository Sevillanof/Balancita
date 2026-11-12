import { describe, expect, it } from 'vitest'
import {
  avanzar,
  marcasHasta,
  resumenDePrecios,
  tramoVisible,
} from './estrategias-repeticion.ts'
import type { ParOperacion, Vela } from './estrategias-velas.ts'

const PASO = 300_000
const velas = (n: number): Vela[] =>
  Array.from({ length: n }, (_, i) => ({
    t: i * PASO,
    o: 100 + i,
    h: 102 + i,
    l: 99 + i,
    c: 101 + i,
    v: 1,
  }))

const par = (
  entrada: number,
  salidaOf: number,
  salidaVar: number,
): ParOperacion => ({
  id: `p${entrada}`,
  lado: 'LONG',
  entradaMs: entrada * PASO,
  oficial: {
    salidaMs: salidaOf * PASO,
    netoUsd: 1,
    horas: 1,
    cortada: false,
    motivo: 'maestro_vuelta',
    nocionalUsd: 100,
  },
  variante: {
    salidaMs: salidaVar * PASO,
    netoUsd: 1,
    horas: 1,
    cortada: false,
    motivo: 'maestro_vuelta',
    nocionalUsd: 100,
  },
})

describe('avanzar', () => {
  it('moves one candle per second at x1 and keeps the fraction between steps', () => {
    let estado = { cursor: 0, acumulado: 0, fin: false }
    for (let i = 0; i < 10; i++)
      estado = avanzar(estado.cursor, estado.acumulado, 1, 100)
    expect(estado.cursor).toBe(1)
  })

  it('moves a hundred candles per second at x100 and stops at the last one', () => {
    const una = avanzar(0, 0, 100, 1000)
    expect(una.cursor).toBe(10)
    const fin = avanzar(995, 0, 100, 1000)
    expect(fin).toEqual({ cursor: 999, acumulado: 0.0, fin: true })
  })
})

describe('tramoVisible', () => {
  it('ends at the cursor and leaves the right part empty', () => {
    const t = tramoVisible(500, 1000, 100)
    expect(t.hasta).toBe(500)
    expect(t.desde).toBe(500 - 92)
  })
  it('starts at the first candle at the beginning and never passes the last', () => {
    expect(tramoVisible(3, 1000, 100).desde).toBe(0)
    expect(tramoVisible(5000, 1000, 100).hasta).toBe(999)
  })
})

describe('marcasHasta', () => {
  const v = velas(100)
  const pares = [par(10, 20, 15), par(50, 60, 70)]
  it('shows nothing of a trade before its entry', () => {
    expect(marcasHasta(pares, v, PASO, 5 * PASO)).toEqual([])
  })
  it('shows an open trade without exit and a closed one with it', () => {
    const marcas = marcasHasta(pares, v, PASO, 17 * PASO)
    expect(marcas).toHaveLength(2)
    const oficial = marcas.find((m) => m.quien === 'oficial')!
    const variante = marcas.find((m) => m.quien === 'variante')!
    expect(oficial.salidaMs).toBeNull()
    expect(variante.salidaMs).toBe(15 * PASO)
  })
  it('never returns an entry or an exit after the instant', () => {
    const ahora = 65 * PASO
    for (const m of marcasHasta(pares, v, PASO, ahora)) {
      expect(m.entradaMs).toBeLessThanOrEqual(ahora)
      if (m.salidaMs !== null) expect(m.salidaMs).toBeLessThanOrEqual(ahora)
    }
  })
})

describe('resumenDePrecios', () => {
  it('reduces the history to the asked columns', () => {
    expect(resumenDePrecios(velas(100), 10)).toHaveLength(10)
    expect(resumenDePrecios([], 10)).toEqual([])
  })
})
