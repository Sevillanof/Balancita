import type { Vela, ParOperacion } from './estrategias-velas.ts'
import { precioEnInstante } from './estrategias-velas.ts'

/** Speeds of the replay: «x1» is one candle of the chosen interval per second, so «x100» is a hundred candles per second. */
export const VELOCIDADES = [1, 25, 50, 100] as const
export type Velocidad = (typeof VELOCIDADES)[number]
export const VELOCIDAD_INICIAL: Velocidad = 50

/** How often the replay moves (ms); each step advances `velocidad × TICK_MS / 1000` candles. */
export const TICK_MS = 100

/** Share of the chart width the cursor sits at: the rest is the (unknown) future, left empty. */
const POSICION_CURSOR = 0.92

/** The candles the chart shows when the cursor is on candle `cursor`: `[desde, cursor]` of the loaded ones. */
export function tramoVisible(
  cursor: number,
  total: number,
  cantidad: number,
): { desde: number; hasta: number; ranuras: number } {
  const ranuras = Math.max(10, Math.floor(cantidad))
  const hasta = Math.max(0, Math.min(total - 1, cursor))
  const desde = Math.max(0, hasta - Math.floor(ranuras * POSICION_CURSOR))
  return { desde, hasta, ranuras }
}

/** The next cursor after one step of the replay at `velocidad`; `acumulado` carries the fraction of a candle. */
export function avanzar(
  cursor: number,
  acumulado: number,
  velocidad: number,
  total: number,
): { cursor: number; acumulado: number; fin: boolean } {
  const suma = acumulado + (velocidad * TICK_MS) / 1000
  const pasos = Math.floor(suma + 1e-9) // 10 steps of 0.1 must make exactly 1
  const nuevo = Math.min(total - 1, cursor + pasos)
  return {
    cursor: nuevo,
    acumulado: Math.max(0, suma - pasos),
    fin: nuevo >= total - 1,
  }
}

export type MarcaOperacion = {
  id: string
  quien: 'oficial' | 'variante'
  lado: 'LONG' | 'SHORT'
  entradaMs: number
  entradaPx: number
  /** `null` while the trade is still open at the cursor. */
  salidaMs: number | null
  salidaPx: number | null
}

/**
 * What exists at instant `ahoraMs` of the replay: each trade whose entry already happened, with its exit only if that happened
 * too. Nothing after the cursor is ever returned, so the chart cannot show the future.
 */
export function marcasHasta(
  pares: readonly ParOperacion[],
  velas: readonly Vela[],
  pasoMs: number,
  ahoraMs: number,
): MarcaOperacion[] {
  const marcas: MarcaOperacion[] = []
  for (const par of pares) {
    if (par.entradaMs > ahoraMs) continue
    const entradaPx = precioEnInstante(velas, par.entradaMs, pasoMs)
    if (entradaPx === null) continue
    for (const quien of ['oficial', 'variante'] as const) {
      const tramo = par[quien]
      if (!tramo) continue
      const cerrada = tramo.salidaMs <= ahoraMs
      marcas.push({
        id: `${par.id}-${quien}`,
        quien,
        lado: par.lado,
        entradaMs: par.entradaMs,
        entradaPx,
        salidaMs: cerrada ? tramo.salidaMs : null,
        salidaPx: cerrada
          ? precioEnInstante(velas, tramo.salidaMs, pasoMs)
          : null,
      })
    }
  }
  return marcas
}

/** Close prices of the whole history reduced to `columnas` points (average per column), for the strip under the chart. */
export function resumenDePrecios(
  velas: readonly Vela[],
  columnas: number,
): number[] {
  if (velas.length === 0 || columnas < 1) return []
  const salida: number[] = []
  for (let k = 0; k < columnas; k++) {
    const a = Math.floor((k * velas.length) / columnas)
    const b = Math.max(a + 1, Math.floor(((k + 1) * velas.length) / columnas))
    let suma = 0
    for (let i = a; i < b && i < velas.length; i++) suma += velas[i]!.c
    salida.push(suma / (Math.min(b, velas.length) - a))
  }
  return salida
}
