import type {
  EstrategiaFila,
  Trabajo,
} from '../infrastructure/estrategias-api.ts'

export type Tono = 'long' | 'short' | 'warn' | 'info' | 'neutral'

export type EstadoVariante = {
  clave:
    | 'cargando'
    | 'invalida'
    | 'sin-probar'
    | 'probando'
    | 'fallo'
    | 'mejor'
    | 'peor'
    | 'igual'
  texto: string
  tono: Tono
}

/**
 * Status of a variant from its latest comparison (`undefined`: still asking the server, `null`: it has none).
 * «Mejor/Peor» is the net after costs against the official Terminal over the same window.
 */
export function estadoVariante(
  fila: EstrategiaFila,
  trabajo: Trabajo | null | undefined,
): EstadoVariante {
  if (fila.error)
    return { clave: 'invalida', texto: 'No se puede probar', tono: 'warn' }
  if (trabajo === undefined)
    return { clave: 'cargando', texto: 'Cargando…', tono: 'neutral' }
  if (trabajo === null)
    return { clave: 'sin-probar', texto: 'Sin probar', tono: 'neutral' }
  if (trabajo.estado === 'corriendo')
    return { clave: 'probando', texto: 'Probando…', tono: 'info' }
  if (trabajo.estado === 'error' || !trabajo.informe)
    return { clave: 'fallo', texto: 'Falló', tono: 'warn' }
  const neto = trabajo.informe.diferencia.neto_usd
  if (neto === null || neto === 0)
    return { clave: 'igual', texto: 'Igual que la oficial', tono: 'neutral' }
  return neto > 0
    ? { clave: 'mejor', texto: 'Mejor que la oficial', tono: 'long' }
    : { clave: 'peor', texto: 'Peor que la oficial', tono: 'short' }
}

/** Whole seconds since a job started; `null` when the clocks disagree so much that it would be a lie. */
export function segundosCorriendo(
  trabajo: Trabajo,
  ahora = Date.now(),
): number | null {
  const segundos = Math.round((ahora - trabajo.iniciado_ms) / 1000)
  return segundos >= 0 && segundos < 3600 ? segundos : null
}

/** Seconds a finished job took. */
export function segundosTardados(trabajo: Trabajo): number | null {
  if (trabajo.terminado_ms === null) return null
  return Math.max(
    0,
    Math.round((trabajo.terminado_ms - trabajo.iniciado_ms) / 1000),
  )
}

export function tonoDeSigno(
  valor: number | null,
): 'long' | 'short' | 'neutral' {
  if (valor === null || valor === 0) return 'neutral'
  return valor > 0 ? 'long' : 'short'
}
