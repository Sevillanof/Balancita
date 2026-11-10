import {
  MESES_CORTOS,
  madridParts,
} from '../../../shared/finance/madrid-time.ts'
import type { Cambios, Perilla } from '../infrastructure/estrategias-api.ts'

type Valor = number | string | null

/**
 * How each knob is shown. `divisor` turns the stored value into the displayed one
 * (2160 min → 36 h, 0.33 → 33 %) and back; `unidad` follows the number.
 */
type Meta = {
  etiqueta: string
  grupo: string
  unidad?: string
  divisor?: number
}

const META: Record<string, Meta> = {
  'guardrails.max_hold_min': {
    etiqueta: 'Tope de horas',
    grupo: 'Salidas',
    unidad: 'h',
    divisor: 60,
  },
  'guardrails.exhaust_hold_min': {
    etiqueta: 'Cierre si el maestro no está a favor',
    grupo: 'Salidas',
    unidad: 'h',
    divisor: 60,
  },
  'guardrails.stop_sigma_24h': {
    etiqueta: 'Stop por volatilidad',
    grupo: 'Salidas',
    unidad: 'σ',
  },
  'guardrails.min_stop_pct': {
    etiqueta: 'Stop mínimo',
    grupo: 'Salidas',
    unidad: '%',
    divisor: 0.01,
  },
  'guardrails.max_stop_pct': {
    etiqueta: 'Stop máximo',
    grupo: 'Salidas',
    unidad: '%',
    divisor: 0.01,
  },
  'wake.flat_every_min': {
    etiqueta: 'Mirar el mercado cada',
    grupo: 'Ritmo',
    unidad: 'min',
  },
  'wake.position_every_min': {
    etiqueta: 'Mirar con una posición abierta cada',
    grupo: 'Ritmo',
    unidad: 'min',
  },
  'guardrails.cooldown_min': {
    etiqueta: 'Espera tras cerrar',
    grupo: 'Ritmo',
    unidad: 'min',
  },
  'posiciones.max': { etiqueta: 'Máximo abiertas', grupo: 'Posiciones' },
  'posiciones.fraccion': {
    etiqueta: 'Tamaño de cada una',
    grupo: 'Posiciones',
    unidad: '%',
    divisor: 0.01,
  },
  'posiciones.espera_entre_entradas_min': {
    etiqueta: 'Espera entre entradas',
    grupo: 'Posiciones',
    unidad: 'min',
  },
  'analista.modo': {
    etiqueta: 'Tamaño según volatilidad',
    grupo: 'Posiciones',
  },
  'rebotes.caida_pct': {
    etiqueta: 'Caída que dispara',
    grupo: 'Rebotes',
    unidad: '%',
  },
  'rebotes.ventana_min': {
    etiqueta: 'Ventana de la caída',
    grupo: 'Rebotes',
    unidad: 'min',
  },
  'rebotes.salida_min': {
    etiqueta: 'Salida del rebote',
    grupo: 'Rebotes',
    unidad: 'min',
  },
  'rebotes.enfriamiento_min': {
    etiqueta: 'Enfriamiento del rebote',
    grupo: 'Rebotes',
    unidad: 'min',
  },
}

const GRUPOS = ['Salidas', 'Ritmo', 'Posiciones', 'Rebotes', 'Otras']

const OPCIONES: Record<string, string> = {
  apagado: 'Apagado',
  suave: 'Suave',
  fuerte: 'Fuerte',
}

const limpiar = (valor: number) => Math.round(valor * 1e9) / 1e9

const decimales = (valor: number, minimo: number, maximo: number) =>
  new Intl.NumberFormat('es-ES', {
    minimumFractionDigits: minimo,
    maximumFractionDigits: maximo,
  }).format(valor)

export const etiquetaPerilla = (clave: string) => META[clave]?.etiqueta ?? clave
export const etiquetaOpcion = (opcion: string) => OPCIONES[opcion] ?? opcion

/**
 * The sizing rules are FIXED, like the live Terminal («El backtest debe invertir igual que la Terminal»): how much goes into each
 * position, how many at once, the wait between entries and the volatility sizing. The server no longer lists them as knobs; this
 * keeps the form from offering them even if a server from before the rule still does.
 */
const REGLAS_DE_INVERSION_FIJAS = /^(posiciones|analista)\./

export const perillasEditables = (perillas: Perilla[]): Perilla[] =>
  perillas.filter((perilla) => !REGLAS_DE_INVERSION_FIJAS.test(perilla.clave))

export type GrupoPerillas = { grupo: string; perillas: Perilla[] }

/** Knobs in the order and groups of the form; a key this file does not know goes to «Otras». */
export function agruparPerillas(perillas: Perilla[]): GrupoPerillas[] {
  return GRUPOS.map((grupo) => ({
    grupo,
    perillas: perillas.filter(
      (perilla) => (META[perilla.clave]?.grupo ?? 'Otras') === grupo,
    ),
  })).filter((grupo) => grupo.perillas.length > 0)
}

/** A stored value as people read it: «36 h», «33 %», «sin stop». */
export function valorTexto(clave: string, valor: Valor | undefined): string {
  if (valor === null || valor === undefined) return 'sin stop'
  if (typeof valor === 'string') return etiquetaOpcion(valor)
  const meta = META[clave]
  const mostrado = limpiar(valor / (meta?.divisor ?? 1))
  const numero = decimales(mostrado, 0, 2)
  return meta?.unidad ? `${numero} ${meta.unidad}` : numero
}

/** What an input holds before the user touches it: today's value in the displayed unit. */
export function entradaInicial(perilla: Perilla): string {
  const hoy = perilla.valor_actual
  if (hoy === null) return ''
  if (typeof hoy === 'string') return hoy
  return String(limpiar(hoy / (META[perilla.clave]?.divisor ?? 1))).replace(
    '.',
    ',',
  )
}

export type Lectura = { ok: true; valor: Valor } | { ok: false; motivo: string }

/** Text of an input → the value to store (reverse of `entradaInicial`). */
export function leerEntrada(perilla: Perilla, texto: string): Lectura {
  const limpio = texto.trim()
  if (perilla.tipo === 'opcion') {
    return perilla.opciones?.includes(limpio)
      ? { ok: true, valor: limpio }
      : { ok: false, motivo: 'elegí una de las opciones' }
  }
  if (limpio === '')
    return perilla.admite_null
      ? { ok: true, valor: null }
      : { ok: false, motivo: 'escribí un valor' }
  const numero = Number(limpio.replace(',', '.'))
  if (!Number.isFinite(numero))
    return { ok: false, motivo: 'escribí un número' }
  const guardado = limpiar(numero * (META[perilla.clave]?.divisor ?? 1))
  if (perilla.tipo === 'entero' && !Number.isInteger(guardado))
    return { ok: false, motivo: 'no da un número entero de minutos o cupos' }
  return { ok: true, valor: guardado }
}

const igual = (a: Valor | undefined, b: Valor) =>
  typeof a === 'number' && typeof b === 'number'
    ? Math.abs(a - b) < 1e-9
    : a === b

/** `{guardrails: {max_hold_min: 1800}}` → `[['guardrails.max_hold_min', 1800]]`. */
export function cambiosPlanos(
  cambios: Cambios | null,
  prefijo = '',
): Array<[string, Valor]> {
  if (!cambios) return []
  return Object.entries(cambios).flatMap(([clave, valor]) =>
    valor !== null && typeof valor === 'object'
      ? cambiosPlanos(valor, `${prefijo}${clave}.`)
      : [[`${prefijo}${clave}`, valor] as [string, Valor]],
  )
}

/** The reverse: dotted keys → the nested object the overlay file holds. */
export function armarCambios(hojas: Array<[string, Valor]>): Cambios {
  const out: Cambios = {}
  for (const [clave, valor] of hojas) {
    const partes = clave.split('.')
    let nodo = out
    for (const parte of partes.slice(0, -1)) {
      const hijo = nodo[parte]
      if (hijo === null || typeof hijo !== 'object') nodo[parte] = {}
      nodo = nodo[parte] as Cambios
    }
    nodo[partes[partes.length - 1]] = valor
  }
  return out
}

/** The form's inputs → the knobs that differ from today (and the first input that is not a value). */
export function cambiosDeEntradas(
  perillas: Perilla[],
  entradas: Record<string, string>,
): { cambios: Cambios; error: string | null } {
  const hojas: Array<[string, Valor]> = []
  for (const perilla of perillas) {
    const texto = entradas[perilla.clave]
    if (texto === undefined) continue
    const lectura = leerEntrada(perilla, texto)
    if (!lectura.ok)
      return {
        cambios: {},
        error: `${etiquetaPerilla(perilla.clave)}: ${lectura.motivo}.`,
      }
    if (!igual(perilla.valor_actual, lectura.valor))
      hojas.push([perilla.clave, lectura.valor])
  }
  return { cambios: armarCambios(hojas), error: null }
}

export type SegmentoCambio = {
  clave: string
  etiqueta: string
  hoy: string
  nuevo: string
}

/** What a variant changes against today: one segment per knob, in the order of the form. */
export function segmentosCambios(
  cambios: Cambios | null,
  perillas: Perilla[],
): SegmentoCambio[] {
  const hoy = new Map(perillas.map((perilla) => [perilla.clave, perilla]))
  const orden = agruparPerillas(perillas).flatMap((g) =>
    g.perillas.map((p) => p.clave),
  )
  return cambiosPlanos(cambios)
    .sort(([a], [b]) => orden.indexOf(a) - orden.indexOf(b))
    .map(([clave, valor]) => ({
      clave,
      etiqueta: etiquetaPerilla(clave),
      hoy: valorTexto(clave, hoy.get(clave)?.valor_actual),
      nuevo: valorTexto(clave, valor),
    }))
}

/** «Tope de horas 36 h → 30 h · Máximo abiertas 3 → 2». */
export function resumenCambios(
  cambios: Cambios | null,
  perillas: Perilla[],
): string {
  const segmentos = segmentosCambios(cambios, perillas)
  return segmentos.length === 0
    ? 'Sin cambios'
    : segmentos.map((s) => `${s.etiqueta} ${s.hoy} → ${s.nuevo}`).join(' · ')
}

export const numero = (valor: number | null, digitos = 2) =>
  valor === null ? '—' : decimales(valor, digitos, digitos)

export const firmado = (valor: number | null, digitos = 2) =>
  valor === null
    ? '—'
    : `${valor > 0 ? '+' : valor < 0 ? '−' : ''}${decimales(Math.abs(valor), digitos, digitos)}`

export const usd = (valor: number | null) =>
  valor === null ? '—' : `${firmado(valor)} US$`

export const abreviado = (hash: string | null, largo = 6) =>
  hash ? `${hash.slice(0, largo)}…` : '—'

/** «2026-11-02…» → «2 nov» (calendar date as written, no time zone). */
export function diaCorto(fecha: string | null | undefined): string {
  const partes = /^(\d{4})-(\d{2})-(\d{2})/.exec(fecha ?? '')
  if (!partes) return '—'
  return `${Number(partes[3])} ${MESES_CORTOS[Number(partes[2]) - 1]}`
}

const MOTIVOS: Record<string, string> = {
  tiempo: 'Tope de horas',
  maestro_vuelta: 'Vuelta del maestro',
  fin_examen: 'Fin de la ventana',
}

export const motivoTexto = (motivo: string) =>
  MOTIVOS[motivo] ?? motivo.replaceAll('_', ' ')

/** Day and hour of an instant in Europe/Madrid: «3 feb 14:05». */
export function instanteCorto(ms: number): string {
  const { day, month, hour, minute } = madridParts(ms)
  return `${day} ${MESES_CORTOS[month]} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

/** «16 abr» (Madrid calendar). */
export function diaDeInstante(ms: number): string {
  const { day, month } = madridParts(ms)
  return `${day} ${MESES_CORTOS[month]}`
}

/** «12:00» (Madrid clock). */
export function horaDeInstante(ms: number): string {
  const { hour, minute } = madridParts(ms)
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}
