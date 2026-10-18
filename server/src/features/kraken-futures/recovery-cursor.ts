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
