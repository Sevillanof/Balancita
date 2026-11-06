import type {
  IntervaloVelas,
  Informe,
} from '../infrastructure/estrategias-api.ts'
import { instanteCorto, numero, usd } from './estrategias-format.ts'

export type { IntervaloVelas }

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

const DIA_MS = 86_400_000
const HORA_MS = 3_600_000
const DIAS_INICIALES = 10
const MIN_POR_PAGINA = 500
const MAX_VELAS = 5000

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

/** The view opens on the last ten days of the window. */
export const velasIniciales = (intervalo: IntervaloVelas) =>
  Math.ceil((DIAS_INICIALES * DIA_MS) / (segundosDe(intervalo) * 1000))

/** Scrolling back asks for more than the first load; the server caps it at 5000. */
export const velasPorPagina = (intervalo: IntervaloVelas) =>
  Math.min(MAX_VELAS, Math.max(MIN_POR_PAGINA, velasIniciales(intervalo)))

// --------------------------------------------------------------------------- trades of both configurations

export type Quien = 'oficial' | 'variante'
export type Visibilidad = Record<Quien, boolean>

export type TramoOperacion = {
  salidaMs: number
  netoUsd: number
  horas: number
  /** The variant closed it earlier than the official one, by the time cap. */
  cortada: boolean
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

export type TramoVisible = {
  quien: Quien
  salidaMs: number
  cortada: boolean
}

export type MarcaOperacion = {
  par: ParOperacion
  tramos: TramoVisible[]
}

/** What the checkboxes leave on the chart: a trade stays while at least one of its two lines is visible. */
export function marcas(
  pares: readonly ParOperacion[],
  visibles: Visibilidad,
): MarcaOperacion[] {
  const out: MarcaOperacion[] = []
  for (const par of pares) {
    const tramos: TramoVisible[] = []
    for (const quien of ['oficial', 'variante'] as const) {
      const lado = par[quien]
      if (visibles[quien] && lado)
        tramos.push({ quien, salidaMs: lado.salidaMs, cortada: lado.cortada })
    }
    if (tramos.length > 0) out.push({ par, tramos })
  }
  return out
}

// --------------------------------------------------------------------------- projection on the chart

/** How the chart places instants and prices; `null` when it cannot (outside what it knows). */
export type MapaProyeccion = {
  ancho: number
  alto: number
  tiempo: (ms: number) => number | null
  precio: (precio: number) => number | null
}

/** The variant's line sits a few pixels under the official one so both stay readable when they overlap. */
export const DESPLAZAMIENTO_VARIANTE_PX = 4

export type TramoProyectado = {
  quien: Quien
  x2: number
  y: number
  cortada: boolean
}

export type OperacionProyectada = {
  par: ParOperacion
  lado: 'LONG' | 'SHORT'
  x: number
  y: number
  tramos: TramoProyectado[]
}

/** The close of the candle that holds `ms` (the price the entry marker sits on); `null` if it is not loaded. */
export function precioEnVela(
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
  return vela.t <= ms && ms < vela.t + pasoMs ? vela.c : null
}

export function proyectar(
  marcasVisibles: readonly MarcaOperacion[],
  velas: readonly Vela[],
  pasoMs: number,
  mapa: MapaProyeccion,
): OperacionProyectada[] {
  const items: OperacionProyectada[] = []
  for (const { par, tramos } of marcasVisibles) {
    const precio = precioEnVela(velas, par.entradaMs, pasoMs)
    if (precio === null) continue
    const x = mapa.tiempo(par.entradaMs)
    const y = mapa.precio(precio)
    if (x === null || y === null) continue
    const proyectados: TramoProyectado[] = []
    for (const t of tramos) {
      const x2 = mapa.tiempo(t.salidaMs)
      if (x2 === null) continue
      proyectados.push({
        quien: t.quien,
        x2,
        y: t.quien === 'variante' ? y + DESPLAZAMIENTO_VARIANTE_PX : y,
        cortada: t.cortada,
      })
    }
    if (proyectados.length === 0) continue
    const fin = Math.max(x, ...proyectados.map((t) => t.x2))
    if (fin < 0 || x > mapa.ancho) continue
    items.push({ par, lado: par.lado, x, y, tramos: proyectados })
  }
  return items
}

const RADIO_ACIERTO_PX = 10
const MARGEN_X_PX = 8

/** The trade under the pointer (its entry mark or either line); the nearest line wins, a later entry breaks ties. */
export function buscarOperacion(
  items: readonly OperacionProyectada[],
  x: number,
  y: number,
): OperacionProyectada | null {
  let mejor: OperacionProyectada | null = null
  let distancia = Infinity
  for (const item of items) {
    for (const t of item.tramos) {
      const lejos = Math.abs(t.y - y)
      if (
        lejos > RADIO_ACIERTO_PX ||
        x < Math.min(item.x, t.x2) - MARGEN_X_PX ||
        x > Math.max(item.x, t.x2) + MARGEN_X_PX
      )
        continue
      const desempata =
        lejos === distancia && item.par.entradaMs > (mejor?.par.entradaMs ?? 0)
      if (lejos < distancia || desempata) {
        mejor = item
        distancia = lejos
      }
    }
  }
  return mejor
}

// --------------------------------------------------------------------------- tooltip

export type FilaTooltip = {
  quien: Quien
  etiqueta: string
  neto: string
  tono: 'long' | 'short' | 'neutral'
}

export type ContenidoTooltip = {
  titulo: string
  filas: FilaTooltip[]
  aviso?: string
}

const NOMBRE: Record<Quien, string> = {
  oficial: 'Oficial',
  variante: 'Variante',
}

export function contenidoTooltip(
  par: ParOperacion,
  visibles: Visibilidad,
): ContenidoTooltip {
  const filas: FilaTooltip[] = []
  for (const quien of ['oficial', 'variante'] as const) {
    if (!visibles[quien]) continue
    const lado = par[quien]
    filas.push(
      lado
        ? {
            quien,
            etiqueta: `${NOMBRE[quien]} · ${numero(lado.horas, 1)} h`,
            neto: usd(lado.netoUsd),
            tono:
              lado.netoUsd > 0
                ? 'long'
                : lado.netoUsd < 0
                  ? 'short'
                  : 'neutral',
          }
        : {
            quien,
            etiqueta: `${NOMBRE[quien]} · no operó`,
            neto: '—',
            tono: 'neutral',
          },
    )
  }
  const contenido: ContenidoTooltip = {
    titulo: `${par.lado === 'LONG' ? '▲' : '▼'} ${par.lado} · ${instanteCorto(par.entradaMs)}`,
    filas,
  }
  if (visibles.variante && par.variante?.cortada)
    contenido.aviso = 'La variante la cortó por el tope de horas'
  return contenido
}
