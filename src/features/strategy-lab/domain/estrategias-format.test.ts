import { describe, expect, it } from 'vitest'
import {
  diaDeInstante,
  horaDeInstante,
  instanteCorto,
  agruparPerillas,
  armarCambios,
  cambiosDeEntradas,
  cambiosPlanos,
  entradaInicial,
  etiquetaPerilla,
  firmado,
  leerEntrada,
  perillasEditables,
  resumenCambios,
  segmentosCambios,
  usd,
  valorTexto,
} from './estrategias-format.ts'
import { PERILLAS, PERILLAS_DE_TAMANO } from '../testing/estrategias-fixture.ts'

const por = (clave: string) =>
  [...PERILLAS, ...PERILLAS_DE_TAMANO].find((p) => p.clave === clave)!

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
    expect(valorTexto('guardrails.max_stop_pct', 0.03)).toBe('3 %')
    expect(valorTexto('rebotes.caida_pct', 5)).toBe('5 %')
    expect(valorTexto('guardrails.stop_sigma_24h', null)).toBe('sin stop')
    expect(valorTexto('analista.modo', 'fuerte')).toBe('Fuerte')
    expect(valorTexto('posiciones.max', 3)).toBe('3') // a legacy file still reads
  })

  it('offers the two maestro entry rules as off/on options in their own group', () => {
    const regla = por('reglas_maestro.no_vender_subida_30d')
    expect(valorTexto(regla.clave, 'prendido')).toBe('Prendido')
    expect(entradaInicial(regla)).toBe('apagado')
    expect(leerEntrada(regla, 'prendido')).toEqual({
      ok: true,
      valor: 'prendido',
    })
    expect(leerEntrada(regla, 'tal vez').ok).toBe(false)
    expect(
      cambiosDeEntradas([regla], { [regla.clave]: 'prendido' }).cambios,
    ).toEqual({ reglas_maestro: { no_vender_subida_30d: 'prendido' } })
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
        'rebotes.caida_pct': '6',
        'wake.flat_every_min': '15',
      }),
    ).toEqual({
      cambios: {
        guardrails: { max_hold_min: 1800 },
        rebotes: { caida_pct: 6 },
      },
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
      rebotes: { caida_pct: 6 },
      guardrails: { max_hold_min: 1800 },
    }
    expect(resumenCambios(cambios, PERILLAS)).toBe(
      'Tope de horas 36 h → 30 h · Caída que dispara 5 % → 6 %',
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

  it('never offers the sizing rules as knobs: they are fixed like the Terminal', () => {
    const todas = [...PERILLAS, ...PERILLAS_DE_TAMANO]
    expect(todas.length).toBeGreaterThan(PERILLAS.length)
    expect(perillasEditables(todas).map((p) => p.clave)).toEqual(
      PERILLAS.map((p) => p.clave),
    )
    expect(
      perillasEditables(todas).filter((p) =>
        /^(posiciones|analista)\./.test(p.clave),
      ),
    ).toEqual([])
  })

  it('groups the knobs the way the form shows them and keeps unknown ones', () => {
    const grupos = agruparPerillas([
      ...PERILLAS,
      { ...PERILLAS[0], clave: 'nueva.perilla' },
    ])
    expect(grupos.map((g) => g.grupo)).toEqual([
      'Salidas',
      'Ritmo',
      'Entradas',
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

describe('instants in Madrid time', () => {
  it('writes day and hour of Madrid in winter (UTC+1) and summer (UTC+2)', () => {
    expect(instanteCorto(Date.UTC(2026, 1, 3, 14, 5))).toBe('3 feb 15:05')
    expect(instanteCorto(Date.UTC(2026, 6, 1, 14, 5))).toBe('1 jul 16:05')
    expect(horaDeInstante(Date.UTC(2026, 1, 3, 14, 5))).toBe('15:05')
    expect(diaDeInstante(Date.UTC(2026, 1, 3, 14, 5))).toBe('3 feb')
  })

  it('moves to the next Madrid day before UTC does', () => {
    expect(instanteCorto(Date.UTC(2026, 9, 30, 23, 45))).toBe('31 oct 00:45')
    expect(diaDeInstante(Date.UTC(2026, 2, 28, 23, 30))).toBe('29 mar')
    expect(horaDeInstante(Date.UTC(2026, 6, 14, 22, 0))).toBe('00:00')
  })

  it('follows both changes of hour', () => {
    expect(horaDeInstante(Date.UTC(2026, 2, 29, 0, 59))).toBe('01:59')
    expect(horaDeInstante(Date.UTC(2026, 2, 29, 1, 0))).toBe('03:00')
    expect(horaDeInstante(Date.UTC(2026, 9, 25, 0, 30))).toBe('02:30')
    expect(horaDeInstante(Date.UTC(2026, 9, 25, 1, 30))).toBe('02:30')
  })
})
