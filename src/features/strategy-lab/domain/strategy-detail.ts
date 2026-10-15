import type { InventoryStrategy } from '../infrastructure/strategy-api.ts'
import { RESEARCH_LABELS, researchLabel } from './strategy-labels.ts'

/** `2025-06-14` in UTC, or `null` when the instant is absent. */
export function utcDay(ms: number | null | undefined): string | null {
  return ms == null ? null : new Date(ms).toISOString().slice(0, 10)
}

/** `previous` → `Rango 1 (previo)`; names this build does not know are shown as written. */
export function rangeName(name: string): string {
  if (name === 'previous') return 'Rango 1 (previo)'
  if (name === 'recent') return 'Rango 2 (reciente)'
  return name
}

/** Whole days between two bucket starts (inclusive of the last minute). */
export function spanDays(first: number, last: number): number {
  return Math.round((last - first + 60_000) / 86_400_000)
}

/** `hace 26 h`, `hace 12 min`, `hace 3 d`; `null` for an absent instant. */
export function agoText(
  ms: number | null | undefined,
  nowMs: number,
): string | null {
  if (ms == null) return null
  const minutes = Math.max(0, Math.round((nowMs - ms) / 60_000))
  if (minutes < 60) return `hace ${minutes} min`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `hace ${hours} h`
  return `hace ${Math.round(hours / 24)} d`
}

/**
 * What the evidence says, in one sentence. It never turns a positive backtest
 * mean into a profitability claim: the verdict of `strategy-reliability.json`
 * decides the wording.
 */
export function verdictStatement(row: InventoryStrategy): string {
  const verdict = researchLabel(row.research.state)
  if (row.research.reliable)
    return `${verdict}: el veredicto de strategy-reliability.json es fiable para este spec. Sigue siendo backtest; el forward decide.`
  if (row.research.evidence_of_edge)
    return `${verdict}. Hay indicios en backtest, pero no alcanzan para llamarla rentable: solo el forward puede validarla.`
  if (row.research.state in RESEARCH_LABELS && row.research.backtest)
    return `${verdict}. Un neto medio positivo en backtest no es rentabilidad demostrada: no supera los umbrales de calificación.`
  return `${verdict}. Sin evidencia para declarar rentabilidad.`
}

/** Experiment id the forward uses for a strategy: the registry id itself. */
export function experimentIdOf(row: Pick<InventoryStrategy, 'id'>): string {
  return row.id
}
