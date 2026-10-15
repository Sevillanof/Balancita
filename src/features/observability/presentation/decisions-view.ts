import type {
  DecisionItem,
  Scalar,
  TraceCondition,
  TraceProposal,
} from '../infrastructure/decisions-api.ts'

/** The spans the investigation list can look back over (server cap: 7 d). */
export const SPANS = [
  { id: '3h', label: '3 h', ms: 3 * 60 * 60_000 },
  { id: '24h', label: '24 h', ms: 24 * 60 * 60_000 },
  { id: '7d', label: '7 d', ms: 7 * 24 * 60 * 60_000 },
] as const
export type SpanId = (typeof SPANS)[number]['id']

export const ACTIONS = ['LONG', 'SHORT', 'WAIT', 'ABSTAIN'] as const

export const NOT_AVAILABLE = 'No disponible'

export function isDirectional(action: string): boolean {
  return action === 'LONG' || action === 'SHORT'
}

/** A proposal is not an order: the label says so wherever the action shows. */
export function actionLabel(action: string): string {
  return isDirectional(action) ? `${action} (propuesta)` : action
}

export function utcClock(ms: number): string {
  return `${new Date(ms).toISOString().slice(11, 19)} UTC`
}

export function utcMinute(ms: number): string {
  return `${new Date(ms).toISOString().slice(11, 16)} UTC`
}

export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

export function scalarText(value: Scalar): string {
  return value === null ? NOT_AVAILABLE : String(value)
}

export function conditionSummary(conditions: readonly TraceCondition[]): {
  passed: number
  failed: number
  unknown: number
} {
  return {
    passed: conditions.filter((c) => c.passed === true).length,
    failed: conditions.filter((c) => c.passed === false).length,
    unknown: conditions.filter((c) => c.passed === null).length,
  }
}

/**
 * Who a proposal belongs to: the strategy id, plus the strategy it delegates
 * to when the payload says so (the adapter does not originate its own signals).
 */
export function proposalOwner(proposal: TraceProposal): string {
  return proposal.delegatedStrategyId
    ? `${proposal.strategyId} → ${proposal.delegatedStrategyId}`
    : proposal.strategyId
}

/**
 * The strategy a list row can honestly show: the one the payload named for the
 * selected proposal. A discard shows none, because its `reason_code` is the
 * selector's, not a strategy's.
 */
export function rowStrategy(item: DecisionItem): string | null {
  return item.selectedStrategyId
}

/** What the page says about where a discard's reason comes from. */
export function reasonOrigin(
  action: string,
  strategyId: string | null | undefined,
  hasPayload: boolean,
): string {
  if (isDirectional(action))
    return strategyId
      ? `Motivo de la propuesta seleccionada de ${strategyId}`
      : 'Motivo registrado por el motor'
  return hasPayload && !strategyId
    ? 'Código del selector: el payload no lo atribuye a ninguna estrategia'
    : 'Código registrado por el motor; no se atribuye a una estrategia'
}
