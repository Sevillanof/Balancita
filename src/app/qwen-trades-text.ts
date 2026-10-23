import type { QwenTradesSource } from './useQwenTrades.ts'

export function signedUsd(value: number | null): string {
  if (value === null) return 'no disponible'
  return `${new Intl.NumberFormat('es-ES', {
    style: 'currency',
    currency: 'USD',
    signDisplay: 'always',
  }).format(value)}`
}

/** Text when Qwen has no operations to show, or null. */
export function qwenTradesNotice(
  source: QwenTradesSource,
  rows: number,
): string | null {
  if (rows > 0 || source.state === 'loading') return null
  if (source.state === 'off')
    return 'Qwen no está operando: todavía no hay base de operaciones. Se crea sola cuando arranca pnpm dev con el modelo local instalado.'
  if (source.state === 'error')
    return 'No se pudieron leer las operaciones de Qwen del gateway.'
  return 'Qwen todavía no operó. Mira el mercado cada 15 minutos y solo opera si ve una ventaja clara.'
}
