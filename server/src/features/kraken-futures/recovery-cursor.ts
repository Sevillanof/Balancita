/**
 * Regla única de recuperación de la captura (docs/captura-recuperacion.md):
 * al (re)arrancar o volver la conexión, lo último ya registrado es el punto de
 * partida y todo lo que falta hasta ahora se pide a Kraken por REST y se
 * registra con la hora real en que Balancita lo recibió. Nunca se altera lo que
 * Kraken envió; solo se anota qué llegó y cuándo.
 */

/** Tope de retroceso del funding: ventana de 30 días del cargador + 2 días de margen. */
export const FUNDING_RECOVERY_LOOKBACK_MS = 32 * 24 * 3_600_000

/**
 * Desde dónde recuperar: el último instante ya registrado, o, sin registro
 * alguno, el tope de retroceso. Nunca más atrás que el tope.
 */
export function recoveryFrom(
  lastRecorded: number | undefined,
  now: number,
  lookbackMs: number,
): number {
  const floor = now - lookbackMs
  return lastRecorded === undefined ? floor : Math.max(lastRecorded, floor)
}

export interface FundingSightingQuery {
  startMs: number
  endMs: number
  receivedAtMs: number
  /** Nunca más atrás que este instante (tope de retroceso). */
  floorMs: number
  /** Las horas cerradas hace menos que esto se avistan de nuevo siempre (revisiones de tasa). */
  resightMs: number
  /** Inicio del último período ya avistado tras su cierre; sin él, solo manda el tope. */
  cursorMs: number | undefined
  /** Solo en la carga atrasada única: inicios que ya tienen avistamiento tras el cierre. */
  sighted: ReadonlySet<number> | undefined
}

/**
 * Si un período de la respuesta debe avistarse ahora. Operación normal: lo
 * posterior al cursor (las horas apagadas, incluida la abierta al apagar) más
 * las últimas 2 h. Carga atrasada (primera vez por producto): los huecos de
 * todo el retroceso. El período abierto nunca se avista.
 */
export function needsFundingSighting(q: FundingSightingQuery): boolean {
  if (q.endMs > q.receivedAtMs || q.startMs < q.floorMs) return false
  if (q.receivedAtMs - q.endMs <= q.resightMs) return true
  if (q.sighted !== undefined) return !q.sighted.has(q.startMs)
  return q.cursorMs === undefined || q.startMs > q.cursorMs
}
