import { Metric, Panel, StatusPill } from '../../../shared/mission-control'
import type { StatusTone } from '../../../shared/mission-control'
import type { PositionsBlock } from '../domain/session-blocks.ts'
import {
  effectiveVerification,
  presentedFreshness,
  thresholdLabel,
  type EffectiveVerification,
  type PresentedFreshness,
} from '../domain/session-freshness.ts'

/**
 * Validity of the session's operational block (Issue #187). It presents what
 * the publisher said and what the gateway degraded; it computes no phase, no
 * threshold and no `verified`. Without an approved limit the block is never
 * shown as current operation: grey `nodata` pill, no tone of operation.
 * OFFLINE: nothing mounts it yet, because no authoritative session exists
 * (#185/#186). It is fed a decoded block.
 */
const FRESHNESS: Record<
  PresentedFreshness,
  { tone: StatusTone; label: string }
> = {
  fresh: { tone: 'ok', label: 'Vigente' },
  stale: { tone: 'warn', label: 'Desactualizado' },
  unknown: { tone: 'nodata', label: 'Vigencia no determinada' },
}

const VERIFICATION: Record<
  EffectiveVerification,
  { tone: StatusTone; label: string }
> = {
  verified: { tone: 'ok', label: 'Verificada' },
  not_current: { tone: 'warn', label: 'No vigente' },
  not_verified: { tone: 'warn', label: 'No verificada' },
}

const REASONS: Record<string, string> = {
  source_stale: 'Fuente desactualizada',
  source_state_unknown: 'Estado de la fuente desconocido',
  runner_not_processing: 'El runner no está procesando',
  report_age_unknown: 'Edad del reporte desconocida',
  report_stale: 'Reporte vencido',
  freshness_threshold_not_approved: 'Umbral no aprobado',
  open_obligations: 'Obligaciones abiertas',
  audit_violations: 'Auditoría con violaciones',
}

const GATEWAY_REASONS: Record<string, string> = {
  report_age_over_limit: 'Reporte más viejo que su límite',
  report_age_unknown: 'Edad del reporte no medible',
  threshold_missing: 'Sin límite en el reporte',
}

const reasonLabel = (code: string) => REASONS[code] ?? code

export default function SessionValidityPanel({
  block,
}: {
  block: PositionsBlock
}) {
  const freshness = presentedFreshness(block)
  const state = FRESHNESS[freshness]
  const current = freshness === 'fresh'
  const gateway = block.gateway
  return (
    <Panel
      title="Estado operativo de la sesión"
      eyebrow="Sesión paper"
      label="Estado operativo de la sesión"
      actions={<StatusPill tone={state.tone}>{state.label}</StatusPill>}
    >
      <div data-testid="session-validity" data-current={current}>
        <p>
          {freshness === 'unknown' &&
          block.verification.thresholds.status !== 'approved'
            ? 'Vigencia no determinada: umbral no aprobado'
            : state.label}
          {' · '}
          {thresholdLabel(block)}
        </p>
        {!current && (
          <p role="note">
            Cifras no vigentes: no se presentan como operación en curso.
          </p>
        )}
        {gateway?.reason && (
          <p data-testid="gateway-reason">
            {GATEWAY_REASONS[gateway.reason]}
            {gateway.ageMs !== null
              ? ` · edad ${Math.round(gateway.ageMs / 1000)} s`
              : ''}
          </p>
        )}
        {block.verification.reasons.length > 0 && (
          <ul aria-label="Motivos del publicador">
            {block.verification.reasons.map((code) => (
              <li key={code}>{reasonLabel(code)}</li>
            ))}
          </ul>
        )}
        <Metric
          label="PnL no realizado (estimado)"
          value={current ? block.unrealizedUsd : 'No vigente'}
          hint={current ? undefined : 'Sin vigencia para mostrar la cifra'}
        />
        {block.account && (
          <section aria-label="Cuenta simulada" data-testid="session-account">
            <h3>Cuenta simulada compartida</h3>
            <Metric
              label="Saldo total simulado"
              value={current ? block.account.totalSimulatedUsd : 'No vigente'}
              hint={
                current
                  ? 'Incluye ganancias aún provisionales: es informativo'
                  : 'Sin vigencia para mostrar la cifra'
              }
            />
            <Metric
              label="Capital definitivo"
              value={current ? block.account.definitiveUsd : 'No vigente'}
              hint={
                current
                  ? `Sin ganancias no verificadas (${block.account.provisionalGainsUsd} provisionales)`
                  : undefined
              }
            />
            <Metric
              label="Comprometido por posiciones abiertas"
              value={current ? block.account.committedUsd : 'No vigente'}
              hint={
                current
                  ? `Órdenes pendientes: ${block.account.pendingOrders} · sin reserva`
                  : undefined
              }
            />
            <Metric
              label="Libre para operar"
              value={current ? block.account.freeUsd : 'No vigente'}
              hint={
                current ? 'Capital definitivo menos comprometido' : undefined
              }
            />
          </section>
        )}
        {block.positions.length === 0 ? (
          <p>Sin posiciones abiertas en el reporte.</p>
        ) : (
          <ul aria-label="Posiciones de la sesión">
            {block.positions.map((p) => {
              const v = VERIFICATION[effectiveVerification(block, p)]
              return (
                <li key={p.intentId} data-current={current}>
                  {p.productId} · {p.side} · {p.strategyId}{' '}
                  <StatusPill tone={v.tone}>{v.label}</StatusPill>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </Panel>
  )
}
