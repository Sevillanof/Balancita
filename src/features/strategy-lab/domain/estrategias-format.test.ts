import { describe, expect, it } from 'vitest'
import {
  agruparPerillas,
  armarCambios,
  cambiosDeEntradas,
  cambiosPlanos,
  entradaInicial,
  etiquetaPerilla,
  firmado,
  leerEntrada,
  resumenCambios,
  segmentosCambios,
  usd,
  valorTexto,
} from './estrategias-format.ts'
import { PERILLAS } from '../testing/estrategias-fixture.ts'

const por = (clave: string) => PERILLAS.find((p) => p.clave === clave)!

describe('knob helpers', () => {
  it('flattens and rebuilds the nested changes of an overlay', () => {
    const cambios = {
      guardrails: { max_hold_min: 1800, stop_sigma_24h: null },
      analista: { modo: 'suave' },
    }
    const hojas = cambiosPlanos(cambios)
    expect(hojas).toEqual([
      ['guardrails.max_hold_min', 1800],
      ['guardrails.stop_sigma_24h', null],
      ['analista.modo', 'suave'],
    ])
    expect(armarCambios(hojas)).toEqual(cambios)
    expect(cambiosPlanos(null)).toEqual([])
  })

  it('shows each value in the unit people think in', () => {
    expect(valorTexto('guardrails.max_hold_min', 2160)).toBe('36 h')
    expect(valorTexto('guardrails.cooldown_min', 15)).toBe('15 min')
    expect(valorTexto('posiciones.fraccion', 0.33)).toBe('33 %')
    expect(valorTexto('rebotes.caida_pct', 5)).toBe('5 %')
    expect(valorTexto('guardrails.stop_sigma_24h', null)).toBe('sin stop')
    expect(valorTexto('analista.modo', 'fuerte')).toBe('Fuerte')
    expect(valorTexto('posiciones.max', 3)).toBe('3')
  })

  it('prefills an input with today value in the displayed unit', () => {
    expect(entradaInicial(por('guardrails.max_hold_min'))).toBe('36')
    expect(entradaInicial(por('posiciones.fraccion'))).toBe('33')
    expect(entradaInicial(por('guardrails.stop_sigma_24h'))).toBe('')
    expect(entradaInicial(por('analista.modo'))).toBe('fuerte')
  })

  it('reads an input back into what the server stores', () => {
    expect(leerEntrada(por('guardrails.max_hold_min'), '30')).toEqual({
      ok: true,
      valor: 1800,
    })
    expect(leerEntrada(por('posiciones.fraccion'), '50')).toEqual({
      ok: true,
      valor: 0.5,
    })
    expect(leerEntrada(por('rebotes.caida_pct'), '6,5')).toEqual({
      ok: true,
      valor: 6.5,
    })
    expect(leerEntrada(por('guardrails.stop_sigma_24h'), '')).toEqual({
      ok: true,
      valor: null,
    })
    expect(leerEntrada(por('analista.modo'), 'suave')).toEqual({
      ok: true,
      valor: 'suave',
    })
  })

  it('rejects what is not a value of the knob', () => {
    expect(leerEntrada(por('guardrails.max_hold_min'), 'abc').ok).toBe(false)
    expect(leerEntrada(por('guardrails.max_hold_min'), '').ok).toBe(false)
    expect(leerEntrada(por('guardrails.cooldown_min'), '1,5').ok).toBe(false)
    expect(leerEntrada(por('analista.modo'), 'enorme').ok).toBe(false)
  })

  it('keeps only the inputs that differ from today', () => {
    const entradas = Object.fromEntries(
      PERILLAS.map((p) => [p.clave, entradaInicial(p)]),
    )
    expect(cambiosDeEntradas(PERILLAS, entradas)).toEqual({
      cambios: {},
      error: null,
    })
    expect(
      cambiosDeEntradas(PERILLAS, {
        ...entradas,
        'guardrails.max_hold_min': '30',
        'posiciones.max': '2',
        'posiciones.fraccion': '33',
      }),
    ).toEqual({
      cambios: { guardrails: { max_hold_min: 1800 }, posiciones: { max: 2 } },
      error: null,
    })
    const malo = cambiosDeEntradas(PERILLAS, {
      ...entradas,
      'guardrails.max_hold_min': 'x',
    })
    expect(malo.error).toContain('Tope de horas')
  })

  it('describes the changes against today: «Tope de horas 36 h → 30 h»', () => {
    const cambios = {
      posiciones: { max: 2, fraccion: 0.5 },
      guardrails: { max_hold_min: 1800 },
    }
    expect(resumenCambios(cambios, PERILLAS)).toBe(
      'Tope de horas 36 h → 30 h · Máximo abiertas 3 → 2 · Tamaño de cada una 33 % → 50 %',
    )
    expect(segmentosCambios({ rebotes: { caida_pct: 6 } }, PERILLAS)).toEqual([
      {
        clave: 'rebotes.caida_pct',
        etiqueta: 'Caída que dispara',
        hoy: '5 %',
        nuevo: '6 %',
      },
    ])
    expect(resumenCambios(null, PERILLAS)).toBe('Sin cambios')
  })

  it('groups the knobs the way the form shows them and keeps unknown ones', () => {
    const grupos = agruparPerillas([
      ...PERILLAS,
      { ...PERILLAS[0], clave: 'nueva.perilla' },
    ])
    expect(grupos.map((g) => g.grupo)).toEqual([
      'Salidas',
      'Ritmo',
      'Posiciones',
      'Rebotes',
      'Otras',
    ])
    expect(grupos[0].perillas.map((p) => p.clave)).toEqual([
      'guardrails.max_hold_min',
      'guardrails.exhaust_hold_min',
      'guardrails.stop_sigma_24h',
    ])
    expect(etiquetaPerilla('nueva.perilla')).toBe('nueva.perilla')
  })

  it('formats signed figures in Spanish', () => {
    expect(firmado(1.234)).toBe('+1,23')
    expect(firmado(-1.234)).toBe('−1,23')
    expect(firmado(0)).toBe('0,00')
    expect(firmado(null)).toBe('—')
    expect(usd(97.7)).toBe('+97,70 US$')
    expect(usd(-44.07)).toBe('−44,07 US$')
  })
})
