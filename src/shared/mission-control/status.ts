/**
 * The four health states plus the neutral one. `nodata` is for "Sin datos" and
 * "No disponible": it is never rendered as healthy.
 */
export type StatusTone = 'ok' | 'warn' | 'bad' | 'nodata'

export const STATUS_LABELS: Record<StatusTone, string> = {
  ok: 'Correcto',
  warn: 'Advertencia',
  bad: 'Error',
  nodata: 'Sin datos',
}
