/**
 * The one vocabulary of strategy status, shared by every Estrategias view
 * (inventory, C29 detail, experiment comparison). Two axes that are never
 * mixed: operational state (does it run?) and research state (what does the
 * evidence say?). Contract: `docs/strategy-inventory-api.md`.
 */
import type { StatusTone } from '../../../shared/mission-control/index.ts'

export type OperationalState =
  | 'active'
  | 'shadow'
  | 'draft'
  | 'retired'
  | 'closed'
  | 'tracking'
  | 'inactive'
  | 'unverified'
  | 'off'

export type ResearchState =
  | 'reliable_edge'
  | 'tentative_edge'
  | 'candidate_edge'
  | 'no_edge'
  | 'negative_edge'
  | 'insufficient_data'
  | 'unmeasured'
  | 'registry_note'

export const OPERATIONAL_LABELS: Record<OperationalState, string> = {
  active: 'Activa en el registro',
  shadow: 'En sombra',
  draft: 'Borrador',
  retired: 'Desactivada',
  closed: 'Retirada',
  tracking: 'En seguimiento (no opera)',
  inactive: 'Desactivada',
  unverified: 'Estado no verificado',
  off: 'Apagada',
}

export const OPERATIONAL_TONES: Record<OperationalState, StatusTone> = {
  active: 'ok',
  shadow: 'warn',
  draft: 'nodata',
  retired: 'nodata',
  closed: 'nodata',
  tracking: 'ok',
  inactive: 'nodata',
  unverified: 'nodata',
  off: 'nodata',
}

export const RESEARCH_LABELS: Record<ResearchState, string> = {
  reliable_edge: 'Ventaja fiable',
  tentative_edge: 'Ventaja tentativa',
  candidate_edge: 'Candidata, no fiable',
  no_edge: 'Sin ventaja demostrada',
  negative_edge: 'Sin ventaja: negativa',
  insufficient_data: 'Datos insuficientes',
  unmeasured: 'Sin evaluación comparable',
  registry_note: 'Según el registro',
}

/** Only a verdict at `candidate_edge` or better is shown as evidence of advantage. */
export const RESEARCH_TONES: Record<ResearchState, StatusTone> = {
  reliable_edge: 'ok',
  tentative_edge: 'ok',
  candidate_edge: 'warn',
  no_edge: 'warn',
  negative_edge: 'bad',
  insufficient_data: 'nodata',
  unmeasured: 'nodata',
  registry_note: 'nodata',
}

export const FROZEN_LABEL = 'Congelada'
export const FROZEN_HINT =
  'No cambia de comportamiento hasta 100 operaciones forward (ADR 0001).'

export const OPERATIONAL_BASIS_HINT: Record<string, string> = {
  registry:
    'Estado del registro de estrategias: no prueba que el proceso corra ahora',
  config:
    'Registrada en un archivo de configuración: no prueba que el proceso esté corriendo',
  none: 'Ninguna fuente confirma este estado',
}

/** Tooltip of the badge: an off strategy shows why and since when, not the config hint. */
export function operationalTitle(
  state: string,
  basis?: string,
  sinceMs?: number | null,
  reason?: string | null,
): string | undefined {
  if (state === 'off' || (state === 'closed' && reason)) {
    const date =
      sinceMs != null && Number.isFinite(sinceMs)
        ? new Date(sinceMs).toISOString().slice(0, 10)
        : null
    const word = state === 'off' ? 'Apagada' : 'Retirada'
    const parts = [
      date ? `${word} desde ${date}` : word,
      reason ? `motivo: ${reason}` : null,
    ].filter(Boolean)
    return parts.join(' · ')
  }
  return basis ? OPERATIONAL_BASIS_HINT[basis] : undefined
}

/** Labels tolerate a value this build does not know, never printing it as a verdict. */
export function operationalLabel(state: string): string {
  return state in OPERATIONAL_LABELS
    ? OPERATIONAL_LABELS[state as OperationalState]
    : OPERATIONAL_LABELS.unverified
}

export function researchLabel(state: string): string {
  return state in RESEARCH_LABELS
    ? RESEARCH_LABELS[state as ResearchState]
    : RESEARCH_LABELS.unmeasured
}

export function operationalTone(state: string): StatusTone {
  return state in OPERATIONAL_TONES
    ? OPERATIONAL_TONES[state as OperationalState]
    : 'nodata'
}

export function researchTone(state: string): StatusTone {
  return state in RESEARCH_TONES
    ? RESEARCH_TONES[state as ResearchState]
    : 'nodata'
}
