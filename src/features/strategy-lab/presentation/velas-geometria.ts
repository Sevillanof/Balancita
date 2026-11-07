/** Colors and measures both views of the trade chart share (SVG drawn in pixels, tokens of the project as CSS variables). */

export const COLOR = {
  oficial: 'var(--color-info)',
  variante: 'var(--color-warn)',
  ideal: 'var(--color-long)',
  sube: 'var(--color-chart-up)',
  baja: 'var(--color-chart-down)',
  rejilla: 'var(--color-chart-line)',
  texto: 'var(--color-chart-text)',
  tinta: 'var(--color-ink)',
  tinta2: 'var(--color-ink-2)',
  fondo: 'var(--color-canvas)',
  panel: 'var(--color-surface-2)',
} as const

export const ALTO_PILDORA = 20
const ANCHO_CARACTER = 7
const RELLENO_PILDORA = 14

/** Pixels a pill needs for its text (11.5 px mono). */
export const anchoPildora = (texto: string) =>
  texto.length * ANCHO_CARACTER + RELLENO_PILDORA

/** Time axis of a stretch: candle `t` is drawn at the middle of its slot, so the last candle still fits. */
export function escalaDeTiempo(
  desdeMs: number,
  hastaMs: number,
  pasoMs: number,
  ancho: number,
) {
  const total = hastaMs - desdeMs + pasoMs
  const hueco = (ancho * pasoMs) / total
  return {
    hueco,
    x: (ms: number) =>
      (ancho * (Math.max(desdeMs, Math.min(hastaMs, ms)) - desdeMs)) / total +
      hueco / 2,
  }
}
