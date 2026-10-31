import { OBS } from '../features/observability/presentation/observability-styles.ts'
import { useEffect, useState, type ReactNode } from 'react'
import { record } from '../shared/wire/decode.ts'
import HealthIndicator, {
  type HealthRead,
} from '../features/observability/presentation/HealthIndicator.tsx'
import SystemUsageChip from './SystemUsageChip.tsx'
import { flowStatus, type FlowLevel } from './terminal-flow.ts'

const HEALTH_POLL_MS = 10_000

const SHORT_LABELS: Record<FlowLevel, string> = {
  ok: 'Flujo en vivo',
  warn: 'Flujo con problemas',
  bad: 'Flujo sin conexión',
}

/** What the terminal already knows from its own WebSocket and quote. */
export interface FlowOverride {
  readonly connected: boolean
  readonly processes: Record<string, unknown> | null
  readonly quoteAgeMs: number | null
}

/**
 * The one status control of the header, the same on every page. It is the B1
 * health chip (see HealthIndicator) with the flow of the gateway's data (en
 * vivo, con problemas, sin conexión; it is not the health of every service) and the PAPER mark as details; clicking it opens the B1 inspector,
 * which also holds the flow diagnosis: why the flow is not ok, usage (CPU,
 * data, Qwen, Kronos), the source and whatever technical detail the page
 * passes in `diagnosis`. The terminal passes `override` with what its
 * WebSocket reports; other pages derive the flow from the gateway's health.
 * Without `b1` (modes with no live gateway) B1 is reported as not
 * applicable instead of being invented.
 */
export default function AppStatusChips({
  apiBase,
  override,
  showUsage = true,
  modeLabel = 'PAPER · KRAKEN',
  diagnosis,
  b1,
  compact = false,
}: {
  apiBase: string
  override?: FlowOverride
  showUsage?: boolean
  modeLabel?: string
  diagnosis?: ReactNode
  b1?: HealthRead
  compact?: boolean
}) {
  const [health, setHealth] = useState<{
    reachable: boolean
    processes: Record<string, unknown> | null
    quoteAgeMs: number | null
  }>({ reachable: false, processes: null, quoteAgeMs: null })
  const ownHealth = override === undefined
  useEffect(() => {
    if (!ownHealth) return
    let cancelled = false
    const load = () =>
      fetch(`${apiBase}/health`)
        .then((response) => {
          if (!response.ok) throw new Error('health unavailable')
          return response.json() as Promise<unknown>
        })
        .then((body) => {
          if (cancelled) return
          const received = record(record(body).capture).lastReceivedAt
          setHealth({
            reachable: true,
            processes: record(record(body).processes),
            quoteAgeMs:
              typeof received === 'number'
                ? Math.max(0, Date.now() - received)
                : null,
          })
        })
        .catch(() => {
          if (!cancelled)
            setHealth({ reachable: false, processes: null, quoteAgeMs: null })
        })
    void load()
    const timer = setInterval(load, HEALTH_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [apiBase, ownHealth])
  const flow = override
    ? flowStatus(override)
    : flowStatus({
        connected: health.reachable,
        processes: health.processes,
        quoteAgeMs: health.quoteAgeMs,
      })
  const paper = modeLabel.split(' · ')[0]
  return (
    <HealthIndicator
      compact={compact}
      data={b1?.data ?? null}
      error={b1?.error ?? null}
      receivedAt={b1?.receivedAt ?? null}
      applicable={b1 !== undefined}
      flow={{ level: flow.level, text: SHORT_LABELS[flow.level], mode: paper }}
      extra={
        <>
          <p>
            <strong className={OBS.flowTitle}>{flow.label}</strong>{' '}
            <span className={OBS.flowScope}>
              (solo el flujo de datos del gateway)
            </span>
          </p>
          <details>
            <summary>Diagnóstico del flujo, uso y modo</summary>
            {flow.reasons.length > 0 ? (
              <ul>
                {flow.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            ) : (
              <p>
                El flujo del gateway no informa problemas. Esto no resume la
                salud de los servicios: eso lo dicen los seis componentes de
                abajo.
              </p>
            )}
            {showUsage && <SystemUsageChip apiBase={apiBase} />}
            <p>
              <strong>{modeLabel}</strong> · precios reales de Kraken,
              operaciones simuladas, sin órdenes reales ni conexión privada.
            </p>
            {diagnosis}
          </details>
        </>
      }
    />
  )
}
