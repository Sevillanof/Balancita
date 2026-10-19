import type { ForwardResult } from '../infrastructure/strategy-api.ts'
import { operationalLabel } from './strategy-labels.ts'

/** Why Qwen did not decide, as the end of "Qwen no decidió: ...". */
export const Q_SKIP_LABELS: Record<string, string> = {
  model_down: 'llama-server no responde',
  model_loading: 'modelo cargando',
  state_error: 'estado de mercado no disponible',
  calm_skip: 'mercado en calma, no se le preguntó',
  stale_verdict: 'dato demasiado viejo',
}

/** The same when the model answered but nothing usable came out. */
export const Q_ERROR_LABELS: Record<string, string> = {
  no_letters: 'no eligió ninguna opción',
  thinking_leak: 'se puso a razonar en vez de elegir',
  bad_json: 'respuesta no válida',
  malformed_response: 'respuesta mal formada',
}

export const Q_OPTION_LABELS: Record<string, string> = {
  buy: 'Comprar',
  hold: 'Mantener',
  sell: 'Vender',
}

function utcDay(ms: number) {
  return new Date(ms).toISOString().slice(0, 10)
}

/** `Apagada: <motivo> (desde 2026-10-18)`; the reason is always present. */
export function stateLine(state: ForwardResult['state']): string {
  const since =
    state.since_ms == null ? '' : ` (desde ${utcDay(state.since_ms)})`
  return `${operationalLabel(state.code)}: ${state.reason}${since}`
}

/** `hace 12 min`, `hace 3 h`; `null` when there is no instant. */
export function agoText(ms: number | null, now: number): string | null {
  if (ms == null) return null
  const minutes = Math.max(0, Math.round((now - ms) / 60_000))
  return minutes < 90
    ? `hace ${minutes} min`
    : `hace ${Math.round(minutes / 60)} h`
}
