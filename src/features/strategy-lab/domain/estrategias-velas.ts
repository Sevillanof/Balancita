import type {
  IntervaloVelas,
  Informe,
} from '../infrastructure/estrategias-api.ts'
import { numero } from './estrategias-format.ts'

export type { IntervaloVelas }

/** `motivo` of a trade the replay closed by force when the tested window ended (not a decision of the strategy). */
export const MOTIVO_FIN_VENTANA = 'fin_examen'

/** The only product the laboratory replays today. */
export const PRODUCTO_VELAS = 'PF_ETHUSD'

export const INTERVALOS_VELAS: ReadonlyArray<{
  id: IntervaloVelas
  segundos: number
}> = [
  { id: '15m', segundos: 15 * 60 },
  { id: '1h', segundos: 3600 },
  { id: '4h', segundos: 4 * 3600 },
  { id: '1d', segundos: 86_400 },
]

export const INTERVALO_INICIAL: IntervaloVelas = '1h'

export const HORA_MS = 3_600_000
/** The most candles the server sends in one answer. */
export const MAX_VELAS = 5000

export const segundosDe = (intervalo: IntervaloVelas) =>
  INTERVALOS_VELAS.find((i) => i.id === intervalo)!.segundos

/** One candle as the server sends it: open instant in ms and OHLC with the volume. */
export type Vela = {
  t: number
  o: number
  h: number
  l: number
  c: number
  v: number
}

/** The tested window of a comparison: the only stretch the chart may ever show. */
export function ventanaDeInforme(informe: Informe): {
  desdeMs: number
  hastaMs: number
} {
  const { ventana } = informe
  const dia = (fecha: string | undefined) => Date.parse(`${fecha}T00:00:00Z`)
  return {
    desdeMs:
      ventana.desde_efectivo_ms ??
      ventana.desde_ms ??
      dia(ventana.desde_efectivo),
    hastaMs: ventana.hasta_ms ?? dia(ventana.hasta),
  }
}

// --------------------------------------------------------------------------- trades of both configurations

export type Quien = 'oficial' | 'variante'
export type Salida = Quien | 'ideal'

/** The official Terminal closes by force after this many hours (`guardrails.max_hold_min` 2160 of the snapshot). */
export const TOPE_OFICIAL_H = 36
export const TOPE_OFICIAL_MS = TOPE_OFICIAL_H * HORA_MS

export type TramoOperacion = {
  salidaMs: number
  netoUsd: number
  horas: number
  /** The variant closed it earlier than the official one, by the time cap. */
  cortada: boolean
  /** Closed by force at the end of the tested window; only present when true. */
  finVentana?: true
  /** Why the replay closed it (`tiempo`, `maestro_vuelta`, `fin_examen`…). */
  motivo: string
  /** Position size, when the server sends it. */
  nocionalUsd: number | null
}

/** The same entry as the official Terminal and the variant took it (either side may be missing). */
export type ParOperacion = {
  id: string
  lado: 'LONG' | 'SHORT'
  entradaMs: number
  oficial: TramoOperacion | null
  variante: TramoOperacion | null
}

type OperacionInforme = Informe['oficial']['operaciones'][number]

const tramo = (
  operacion: OperacionInforme,
  cortada: boolean,
): TramoOperacion => ({
  salidaMs: operacion.salida_ms,
  netoUsd: operacion.neto_usd,
  horas: (operacion.salida_ms - operacion.entrada_ms) / HORA_MS,
  cortada,
  ...(operacion.motivo === MOTIVO_FIN_VENTANA && { finVentana: true as const }),
  motivo: operacion.motivo,
  nocionalUsd: operacion.nocional_usd ?? null,
})

const claveDe = (o: OperacionInforme) => `${o.entrada_ms}|${o.lado}`

/**
 * Pairs the two runs by entry instant and side (two positions opened in the same candle pair one by one, in order).
 * The variant is «cut» when the time cap closed it before the official one did.
 */
export function emparejar(informe: Informe): ParOperacion[] {
  const pares: ParOperacion[] = []
  const sinPareja = new Map<string, ParOperacion[]>()
  const salidaOficial = new Map<ParOperacion, number>()
  const nuevo = (
    operacion: OperacionInforme,
    quien: Quien,
    cortada: boolean,
  ): ParOperacion => {
    const par: ParOperacion = {
      id: `${operacion.entrada_ms}-${operacion.lado}-${pares.length}`,
      lado: operacion.lado,
      entradaMs: operacion.entrada_ms,
      oficial: null,
      variante: null,
    }
    par[quien] = tramo(operacion, cortada)
    pares.push(par)
    return par
  }
  for (const operacion of informe.oficial.operaciones) {
    const par = nuevo(operacion, 'oficial', false)
    salidaOficial.set(par, operacion.salida_ms)
    const clave = claveDe(operacion)
    sinPareja.set(clave, [...(sinPareja.get(clave) ?? []), par])
  }
  for (const operacion of informe.variante.operaciones) {
    const par = sinPareja.get(claveDe(operacion))?.shift()
    if (!par) {
      nuevo(operacion, 'variante', false)
      continue
    }
    par.variante = tramo(
      operacion,
      operacion.motivo === 'tiempo' &&
        operacion.salida_ms < salidaOficial.get(par)!,
    )
  }
  return pares.sort((a, b) => a.entradaMs - b.entradaMs)
}

/** The trade the chart opens on: the first one the variant cut at or after the middle of the list, else the middle one. */
export function operacionInicial(pares: readonly ParOperacion[]): number {
  const medio = Math.floor(pares.length / 2)
  const cortada = pares.findIndex(
    (par, i) => i >= medio && par.variante?.cortada,
  )
  return cortada >= 0 ? cortada : medio
}

/** The cap of hours the variant changed (`guardrails.max_hold_min`), `null` when it kept the official one. */
export function topeVarianteDeInforme(informe: Informe): number | null {
  const guardrails = informe.estrategia.cambios.guardrails
  if (typeof guardrails !== 'object' || guardrails === null) return null
  const minutos = guardrails.max_hold_min
  return typeof minutos === 'number' ? minutos / 60 : null
}

// --------------------------------------------------------------------------- what the chart shows around one trade

const sentido = (lado: 'LONG' | 'SHORT') => (lado === 'LONG' ? 1 : -1)

/** The price at an instant: the candle that holds it, between its open and its close in proportion; `null` if not loaded. */
export function precioEnInstante(
  velas: readonly Vela[],
  ms: number,
  pasoMs: number,
): number | null {
  if (velas.length === 0) return null
  let bajo = 0
  let alto = velas.length - 1
  while (bajo < alto) {
    const medio = (bajo + alto + 1) >> 1
    if (velas[medio]!.t <= ms) bajo = medio
    else alto = medio - 1
  }
  const vela = velas[bajo]!
  if (!(vela.t <= ms && ms < vela.t + pasoMs)) return null
  return vela.o + ((vela.c - vela.o) * (ms - vela.t)) / pasoMs
}

export type PuntoIdeal = { salidaMs: number; precio: number }

/**
 * The best price a trade could have exited at while it was allowed to stay open: the highest high (LONG) or lowest low (SHORT)
 * from the entry up to `entradaMs + topeMs` (36 h by default, the official cap). Only candles that lie inside that stretch
 * count; the candle that holds the entry (opened before it) only offers its close and the entry price, since its high or low may
 * have happened before the entry. A candle that opens at the cap or later is out. `null` when there is no candle to look at.
 */
export function salidaIdeal(
  velas: readonly Vela[],
  entrada: { ms: number; px: number; lado: 'LONG' | 'SHORT' },
  pasoMs: number,
  topeMs = TOPE_OFICIAL_MS,
): PuntoIdeal | null {
  const signo = sentido(entrada.lado)
  const fin = entrada.ms + topeMs
  let mejor: PuntoIdeal | null = null
  const probar = (salidaMs: number, precio: number) => {
    if (mejor === null || signo * (precio - mejor.precio) > 0)
      mejor = { salidaMs, precio }
  }
  for (const vela of velas) {
    if (vela.t + pasoMs <= entrada.ms || vela.t + pasoMs > fin) continue
    if (vela.t < entrada.ms)
      probar(
        entrada.ms,
        signo > 0 ? Math.max(entrada.px, vela.c) : Math.min(entrada.px, vela.c),
      )
    else probar(vela.t, signo > 0 ? vela.h : vela.l)
  }
  return mejor
}

/**
 * What a position of `nocional` US$ gains (or loses) by exiting at `haciaPx` instead of `desdePx`, having entered at `entradaPx`.
 * Fees, costs and funding are the same for both exits, so this is exactly the difference between their nets.
 */
export function mejoraDeSalida(
  nocional: number,
  lado: 'LONG' | 'SHORT',
  entradaPx: number,
  desdePx: number,
  haciaPx: number,
): number {
  return (nocional * sentido(lado) * (haciaPx - desdePx)) / entradaPx
}

export type SalidaDetalle = {
  quien: Salida
  salidaMs: number
  precio: number
  /** `null` when the size is unknown (an informe from before the server sent it) and the ideal cannot be priced. */
  netoUsd: number | null
  horas: number
  motivo: string
}

export type DetalleOperacion = {
  par: ParOperacion
  entradaPx: number
  /** `null` = that exit does not exist (the configuration did not take the trade, or no candle to look at). */
  salidas: Record<Salida, SalidaDetalle | null>
  /** What the official one left on the table: ideal − official net, both with the same size and cost model. */
  faltoUsd: number | null
}

/** Rounding noise of the price round trip must not read as «−0,0». */
const sinRuido = (valor: number) => (Math.abs(valor) < 1e-9 ? 0 : valor)

const horasTexto = (horas: number) => `${numero(horas, 0)} h`

function motivoDe(
  quien: Quien,
  par: ParOperacion,
  topes: { oficialH: number; varianteH: number | null },
): string {
  const t = par[quien]!
  if (quien === 'variante') {
    if (t.cortada) return `tope ${horasTexto(topes.varianteH ?? t.horas)}`
    if (par.oficial && par.oficial.salidaMs === t.salidaMs)
      return 'igual que la oficial'
  }
  if (t.finVentana) return 'fin de la ventana'
  if (t.motivo === 'tiempo')
    return `tope ${horasTexto(quien === 'oficial' ? topes.oficialH : (topes.varianteH ?? topes.oficialH))}`
  return 'regla de salida'
}

/**
 * The three exits of one trade. The official and the variant keep the net the backtest recorded (fees, funding and fills
 * included) and sit at the candle price of their exit instant. The ideal is the best price within the official cap; its net is
 * the net of the official trade plus what moving the exit from its price to the ideal one gains with the same size, so the
 * same costs apply (the informe has no per-trade fees or prices to price it any other way). `null` when the entry candle is not
 * loaded.
 */
export function detalleDeOperacion(
  par: ParOperacion,
  velas: readonly Vela[],
  pasoMs: number,
  opciones: { topeVarianteH?: number | null } = {},
): DetalleOperacion | null {
  const entradaPx = precioEnInstante(velas, par.entradaMs, pasoMs)
  if (entradaPx === null) return null
  const topes = {
    oficialH: TOPE_OFICIAL_H,
    varianteH: opciones.topeVarianteH ?? null,
  }
  const real = (quien: Quien): SalidaDetalle | null => {
    const t = par[quien]
    if (!t) return null
    return {
      quien,
      salidaMs: t.salidaMs,
      precio: precioEnInstante(velas, t.salidaMs, pasoMs) ?? entradaPx,
      netoUsd: t.netoUsd,
      horas: t.horas,
      motivo: motivoDe(quien, par, topes),
    }
  }
  const oficial = real('oficial')
  const variante = real('variante')
  const signo = sentido(par.lado)
  let punto = salidaIdeal(
    velas,
    { ms: par.entradaMs, px: entradaPx, lado: par.lado },
    pasoMs,
  )
  // A price a recorded trade really got inside the cap is reachable: the ideal is never worse than either of them.
  for (const s of [oficial, variante])
    if (
      s &&
      s.salidaMs - par.entradaMs <= TOPE_OFICIAL_MS &&
      (punto === null || signo * (s.precio - punto.precio) > 0)
    )
      punto = { salidaMs: s.salidaMs, precio: s.precio }
  // The size and costs of the official trade (the variant's when the official one did not take it) are the ideal's.
  const base = oficial ?? variante
  const baseTramo = par.oficial ?? par.variante
  const nocional = baseTramo?.nocionalUsd ?? null
  const ideal: SalidaDetalle | null = punto && {
    quien: 'ideal',
    salidaMs: punto.salidaMs,
    precio: punto.precio,
    netoUsd:
      base && nocional !== null && nocional > 0
        ? base.netoUsd! +
          mejoraDeSalida(
            nocional,
            par.lado,
            entradaPx,
            base.precio,
            punto.precio,
          )
        : null,
    horas: (punto.salidaMs - par.entradaMs) / HORA_MS,
    motivo: 'mejor precio posible',
  }
  return {
    par,
    entradaPx,
    salidas: { oficial, variante, ideal },
    faltoUsd:
      oficial && ideal?.netoUsd != null
        ? sinRuido(ideal.netoUsd - oficial.netoUsd!)
        : null,
  }
}

// --------------------------------------------------------------------------- which candles to ask for and show

export type RangoMs = { desdeMs: number; hastaMs: number }

const MARGEN_ANTES_UNA_MS = 10 * HORA_MS
const MARGEN_DESPUES_UNA_MS = 8 * HORA_MS
const MEDIA_VENTANA_VARIAS_MS = 60 * HORA_MS
/** At a coarse interval the margins grow so that there are still some candles around the trade. */
const MIN_VELAS_MARGEN = 8
const MIN_VELAS_MEDIA_VARIAS = 20

/** «Una operación»: ten hours before the entry and eight after the last exit (at least eight candles each side). */
export function rangoUna(
  par: ParOperacion,
  idealMs: number | null,
  pasoMs: number,
): RangoMs {
  const fin = Math.max(
    par.entradaMs,
    par.oficial?.salidaMs ?? 0,
    par.variante?.salidaMs ?? 0,
    idealMs ?? 0,
  )
  return {
    desdeMs:
      par.entradaMs - Math.max(MARGEN_ANTES_UNA_MS, MIN_VELAS_MARGEN * pasoMs),
    hastaMs: fin + Math.max(MARGEN_DESPUES_UNA_MS, MIN_VELAS_MARGEN * pasoMs),
  }
}

/** «Varias»: about five days centred on the entry of the chosen trade (at least forty candles). */
export function rangoVarias(par: ParOperacion, pasoMs: number): RangoMs {
  const media = Math.max(
    MEDIA_VENTANA_VARIAS_MS,
    MIN_VELAS_MEDIA_VARIAS * pasoMs,
  )
  return { desdeMs: par.entradaMs - media, hastaMs: par.entradaMs + media }
}

/** What to load for a trade so that both modes (and its ideal exit, up to the official cap) have their candles. */
export function rangoDeCarga(par: ParOperacion, pasoMs: number): RangoMs {
  const una = rangoUna(par, par.entradaMs + TOPE_OFICIAL_MS, pasoMs)
  const varias = rangoVarias(par, pasoMs)
  return {
    desdeMs: Math.min(una.desdeMs, varias.desdeMs),
    hastaMs: Math.max(una.hastaMs, varias.hastaMs),
  }
}

/**
 * The server answers «the newest `limite` candles before `antesMs`» inside the tested window: this turns a range into that
 * query, never reaching outside the window (the end of the window is the end of what is known, the reserve starts there).
 */
export function consultaDeRango(
  rango: RangoMs,
  ventana: RangoMs,
  pasoMs: number,
): { antesMs: number; limite: number } {
  const antesMs = Math.min(rango.hastaMs, ventana.hastaMs)
  const desde = Math.max(rango.desdeMs, ventana.desdeMs)
  return {
    antesMs,
    limite: Math.min(
      MAX_VELAS,
      Math.max(1, Math.ceil((antesMs - desde) / pasoMs) + 1),
    ),
  }
}

// --------------------------------------------------------------------------- layout

/**
 * Rows for horizontal bars so that none touches another in the same row: bars go in order of start, each one in the first row
 * whose last bar ended at or before its start. Returns the row (0-based) of each input, in the input order.
 */
export function asignarCarriles(
  items: ReadonlyArray<{ inicio: number; fin: number }>,
): number[] {
  const orden = items
    .map((item, i) => ({ ...item, i }))
    .sort((a, b) => a.inicio - b.inicio || a.i - b.i)
  const finDeCarril: number[] = []
  const carril = new Array<number>(items.length).fill(0)
  for (const item of orden) {
    let c = 0
    while (finDeCarril[c] !== undefined && finDeCarril[c]! > item.inicio) c++
    finDeCarril[c] = item.fin
    carril[item.i] = c
  }
  return carril
}

export type Pildora = {
  /** Left edge. */
  x0: number
  ancho: number
  /** Centre line the caller would like. */
  y: number
  /** Which way to move first when it collides: 1 = down, −1 = up. */
  hacia: 1 | -1
}

/** A fixed box a pill must stay clear of (a marker on the chart). */
export type Obstaculo = { x0: number; ancho: number; y: number; alto: number }

/**
 * Moves pills vertically, in order, until none overlaps one placed before it (a placed pill never moves) nor an obstacle, and
 * all stay between `ymin` and `ymax`. Returns the centre line of each, in the input order. If nothing free is left the wanted
 * one is kept.
 */
export function ubicarPildoras(
  pildoras: readonly Pildora[],
  {
    alto,
    ymin,
    ymax,
    obstaculos = [],
  }: { alto: number; ymin: number; ymax: number; obstaculos?: Obstaculo[] },
): number[] {
  const ocupadas: Obstaculo[] = [...obstaculos]
  const libre = (p: Pildora, y: number) =>
    y >= ymin &&
    y <= ymax &&
    ocupadas.every(
      (q) =>
        p.x0 >= q.x0 + q.ancho ||
        q.x0 >= p.x0 + p.ancho ||
        Math.abs(q.y - y) >= (q.alto + alto) / 2,
    )
  const salida: number[] = []
  const paso = alto + 2
  const pasos = Math.ceil((ymax - ymin) / paso) + 1
  for (const p of pildoras) {
    let y = Math.min(ymax, Math.max(ymin, p.y))
    search: for (let k = 0; k <= pasos; k++)
      for (const dir of k === 0 ? [1] : [p.hacia, -p.hacia]) {
        const candidato = p.y + dir * k * paso
        if (libre(p, candidato)) {
          y = candidato
          break search
        }
      }
    ocupadas.push({ x0: p.x0, ancho: p.ancho, y, alto })
    salida.push(y)
  }
  return salida
}

/** Round prices for the horizontal grid: about `aprox` lines between `lo` and `hi` at 1, 2, 5 or 10 × a power of ten. */
export function ticksDePrecio(lo: number, hi: number, aprox = 5): number[] {
  if (!(hi > lo)) return []
  const crudo = (hi - lo) / aprox
  const potencia = 10 ** Math.floor(Math.log10(crudo))
  const paso = [1, 2, 5, 10].map((m) => m * potencia).find((v) => v >= crudo)!
  const ticks: number[] = []
  for (let v = Math.ceil(lo / paso) * paso; v < hi; v += paso) ticks.push(v)
  return ticks
}

const PASOS_EJE_HORAS = [1, 2, 3, 6, 12, 24, 48, 72, 168]

/** How many hours between labels of the time axis so that a span carries about nine of them at most. */
export function pasoEjeHoras(spanMs: number): number {
  const horas = spanMs / HORA_MS
  return (
    PASOS_EJE_HORAS.find((paso) => horas / paso <= 9) ?? PASOS_EJE_HORAS.at(-1)!
  )
}
