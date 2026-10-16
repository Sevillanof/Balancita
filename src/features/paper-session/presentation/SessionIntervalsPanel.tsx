import { Panel, StatusPill } from '../../../shared/mission-control'
import type { StatusTone } from '../../../shared/mission-control'
import type { IntervalsBlock } from '../domain/session-blocks.ts'

/**
 * Traceability of the session (Issue #187): signal → decision → order →
 * trade, one row per interval, as the publisher recorded it. It shows the
 * signals that did not trade (WAIT / HOLD) and the end of every order
 * (rejected, expired, cancelled...) instead of hiding them, the age of the
 * document it comes from and the warnings the publisher raised. It
 * computes nothing: an unknown code is shown as it came.
 */
export const VISIBLE_INTERVALS = 50

const ACTION: Record<string, string> = {
  BUY: 'Compra',
  SELL: 'Venta',
  WAIT: 'Espera',
  HOLD: 'Mantener',
}

const STAGE_STATE: Record<string, string> = {
  none: 'Sin registro',
  recorded: 'Registrada',
}

const ORDER_STATE: Record<string, { tone: StatusTone; label: string }> = {
  none: { tone: 'nodata', label: 'Sin orden' },
  pending: { tone: 'warn', label: 'Pendiente' },
  opened: { tone: 'ok', label: 'Abierta' },
  filled: { tone: 'ok', label: 'Ejecutada' },
  rejected: { tone: 'bad', label: 'Rechazada' },
  expired: { tone: 'warn', label: 'Vencida' },
  cancelled: { tone: 'warn', label: 'Cancelada' },
}

const TRADE_STATE: Record<string, string> = {
  none: 'Sin operación',
  open: 'Abierta',
  closed: 'Cerrada',
}

const REASONS: Record<string, string> = {
  stale_entry: 'Entrada vencida',
  no_quote: 'Sin cotización',
}

const label = (map: Record<string, string>, code: string) => map[code] ?? code

export default function SessionIntervalsPanel({
  block,
  ageSeconds,
  lastRead = false,
}: {
  block: IntervalsBlock
  /** Age of the document these intervals come from; `null` when it cannot be measured. */
  ageSeconds: number | null
  lastRead?: boolean
}) {
  const newest = [...block.intervals].reverse()
  const shown = newest.slice(0, VISIBLE_INTERVALS)
  const unverified = block.signalReferences.unverified.length
  const warnings: string[] = []
  if (!block.contract.complete)
    warnings.push(
      `Cadena incompleta${
        block.contract.stagesMissing.length > 0
          ? `: faltan ${block.contract.stagesMissing.join(', ')}`
          : ''
      }`,
    )
  if (unverified > 0)
    warnings.push(`${unverified} señales sin referencia verificable`)
  return (
    <Panel
      title="Trazabilidad de la sesión"
      eyebrow="Señal → decisión → orden → operación"
      label="Trazabilidad de la sesión"
      actions={
        <StatusPill tone={warnings.length > 0 ? 'warn' : 'nodata'}>
          {warnings.length > 0 ? 'Con advertencias' : 'Sin advertencias'}
        </StatusPill>
      }
    >
      <div data-testid="session-intervals">
        <p data-testid="intervals-age">
          {ageSeconds === null
            ? 'Edad del documento no medible'
            : `Del documento publicado hace ${ageSeconds} s${
                lastRead ? ' a la última lectura' : ''
              }`}
        </p>
        {warnings.length > 0 && (
          <ul aria-label="Advertencias de la trazabilidad">
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        )}
        {block.intervals.length === 0 ? (
          <p>Sin intervalos registrados.</p>
        ) : (
          <>
            {block.intervals.length > shown.length && (
              <p data-testid="intervals-truncated">
                Se muestran los últimos {shown.length} de{' '}
                {block.intervals.length} intervalos.
              </p>
            )}
            <ul aria-label="Intervalos de la sesión">
              {shown.map((i, index) => {
                const order = ORDER_STATE[i.order.state] ?? {
                  tone: 'nodata' as const,
                  label: i.order.state,
                }
                return (
                  <li
                    key={i.key ?? `${i.productId}-${index}`}
                    data-testid="interval"
                    data-action={i.signal.action ?? ''}
                  >
                    {i.productId} · {i.strategyId} ·{' '}
                    <span data-testid="interval-signal">
                      {i.signal.action
                        ? label(ACTION, i.signal.action)
                        : 'Señal sin acción'}
                    </span>{' '}
                    ({label(STAGE_STATE, i.signal.state)}) · decisión{' '}
                    {label(STAGE_STATE, i.decision.state).toLowerCase()} · orden{' '}
                    <StatusPill tone={order.tone}>{order.label}</StatusPill>
                    {i.order.reasons.length > 0 &&
                      ` (${i.order.reasons
                        .map((r) => label(REASONS, r))
                        .join(', ')})`}{' '}
                    · {label(TRADE_STATE, i.trade.state)}
                    {i.trade.exitReason ? ` (${i.trade.exitReason})` : ''}
                  </li>
                )
              })}
            </ul>
          </>
        )}
      </div>
    </Panel>
  )
}
