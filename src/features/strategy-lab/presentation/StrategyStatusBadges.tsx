import { StatusPill } from '../../../shared/mission-control/index.ts'
import {
  FROZEN_HINT,
  FROZEN_LABEL,
  OPERATIONAL_BASIS_HINT,
  operationalLabel,
  operationalTone,
  researchLabel,
  researchTone,
} from '../domain/strategy-labels.ts'

/**
 * The status badges every Estrategias view reuses. Operational and research
 * state are separate badges with the words of `strategy-labels.ts`.
 */
export function OperationalBadge({
  state,
  basis,
}: {
  state: string
  basis?: string
}) {
  return (
    <span
      title={basis ? OPERATIONAL_BASIS_HINT[basis] : undefined}
      data-testid="operational-badge"
      data-state={state}
    >
      <StatusPill tone={operationalTone(state)}>
        {operationalLabel(state)}
      </StatusPill>
    </span>
  )
}

export function ResearchBadge({ state }: { state: string }) {
  return (
    <span data-testid="research-badge" data-state={state}>
      <StatusPill tone={researchTone(state)}>{researchLabel(state)}</StatusPill>
    </span>
  )
}

export function FrozenBadge() {
  return (
    <span title={FROZEN_HINT} data-testid="frozen-badge">
      <StatusPill tone="nodata">{FROZEN_LABEL}</StatusPill>
    </span>
  )
}
