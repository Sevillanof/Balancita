import type { ForwardResult } from '../infrastructure/strategy-api.ts'
import { operationalLabel } from './strategy-labels.ts'

/** Spanish wording of the skip codes of Q (`paper_futures_llm_skips`). */
export const Q_SKIP_LABELS: Record<string, string> = {
  model_down: 'Modelo local caído',
  state_error: 'Estado no disponible',
  calm_skip: 'Filtro de calma',
  stale_verdict: 'Veredicto viejo',
}

export const SKIP_WINDOW_LABELS: Record<string, string> = {
  '1h': 'Última hora',
  '24h': '24 horas',
  '7d': '7 días',
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
