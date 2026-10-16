import { Metric, Panel, StatusPill } from '../../../shared/mission-control'
import type { StatusTone } from '../../../shared/mission-control'
import type {
  SessionPhase,
  SessionStatusBlock,
} from '../domain/session-blocks.ts'

/**
 * Operating status of the session (Issue #187). It presents what the
 * publisher said about the phase and what the gateway degraded; it computes
 * no phase and no limit. A running session is never shown as alive without
 * an approved limit: `alive` only appears when the block says so.
 */
const PHASE: Record<SessionPhase, { tone: StatusTone; label: string }> = {
  INIT: { tone: 'nodata', label: 'Iniciando' },
  WARMING_UP: { tone: 'nodata', label: 'Calentando' },
  LIVE: { tone: 'ok', label: 'En marcha' },
  STOPPING: { tone: 'warn', label: 'Deteniéndose' },
  STOPPED: { tone: 'nodata', label: 'Detenida en orden' },
  HALTED: { tone: 'bad', label: 'Detenida por una parada' },
  REFUSED: { tone: 'bad', label: 'Rechazada al arrancar' },
  unverified: { tone: 'warn', label: 'Sin verificar' },
  unavailable: { tone: 'nodata', label: 'No disponible' },
}

const LIVENESS: Record<SessionStatusBlock['liveness'], string> = {
  unknown: 'Latido sin confirmar (vigencia no determinada)',
  alive: 'Latido al día',
  stale: 'Latido vencido',
  final: 'Sesión terminada',
}

const REASONS: Record<string, string> = {
  heartbeat_age_unknown: 'Edad del latido desconocida',
  heartbeat_stale: 'Latido más viejo que su límite',
  halt_file_outranks_heartbeat: 'El archivo de parada manda sobre el latido',
  report_ended_after_heartbeat: 'El informe final es posterior al latido',
  heartbeat_missing: 'Sin latido',
  heartbeat_schema_unknown: 'Latido de un formato desconocido',
  heartbeat_phase_unknown: 'Fase del latido desconocida',
  heartbeat_phase_missing: 'El latido no trae fase',
}

const GATEWAY_REASONS: Record<string, string> = {
  heartbeat_age_over_limit: 'Archivo más viejo que su límite',
  heartbeat_age_unknown: 'Edad del archivo no medible',
  threshold_missing: 'Sin límite en el bloque',
}

const FUNDING_SOURCE = {
  synthetic: 'Fondeo sintético (nunca verifica el resultado)',
  observed: 'Fondeo observado',
  unknown: 'Fondeo sin dato',
} as const

const label = (map: Record<string, string>, code: string) => map[code] ?? code

export default function SessionStatusPanel({
  status,
}: {
  status: SessionStatusBlock
}) {
  const phase = PHASE[status.phase]
  const gateway = status.gateway
  return (
    <Panel
      title="Fase de la sesión"
      eyebrow="Sesión paper"
      label="Fase de la sesión"
      actions={<StatusPill tone={phase.tone}>{phase.label}</StatusPill>}
    >
      <div data-testid="session-status" data-phase={status.phase}>
        <p>{LIVENESS[status.liveness]}</p>
        {status.reportedPhase !== null &&
          status.reportedPhase !== status.phase && (
            <p data-testid="reported-phase">
              Fase que informó el proceso: {status.reportedPhase}
            </p>
          )}
        {status.haltReason && (
          <p data-testid="halt-reason" role="note">
            Motivo de la parada: {status.haltReason}
          </p>
        )}
        {gateway?.reason && (
          <p data-testid="status-gateway-reason">
            {label(GATEWAY_REASONS, gateway.reason)}
            {gateway.ageMs !== null
              ? ` · edad ${Math.round(gateway.ageMs / 1000)} s`
              : ''}
          </p>
        )}
        {status.reasons.length > 0 && (
          <ul aria-label="Motivos del publicador">
            {status.reasons.map((code) => (
              <li key={code}>{label(REASONS, code)}</li>
            ))}
          </ul>
        )}
        <Metric
          label="Órdenes pendientes"
          value={status.pendingOrders === null ? '—' : status.pendingOrders}
        />
        <Metric
          label="Posiciones abiertas"
          value={status.openPositions === null ? '—' : status.openPositions}
        />
        <p data-testid="funding-source">
          {FUNDING_SOURCE[status.funding.source]}
          {status.funding.pnlVerified
            ? ' · resultado verificado'
            : ' · resultado sin verificar'}
        </p>
      </div>
    </Panel>
  )
}
