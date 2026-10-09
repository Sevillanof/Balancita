import { useEffect, useState, type ReactNode } from 'react'
import { record } from '../shared/wire/decode.ts'
import SystemUsageChip from './SystemUsageChip.tsx'
import { flowStatus, type FlowLevel } from './terminal-flow.ts'

const HEALTH_POLL_MS = 10_000

const SHORT_LABELS: Record<FlowLevel, string> = {
  ok: 'En vivo',
  warn: 'Con problemas',
  bad: 'Sin conexión',
}

/** What the terminal already knows from its own WebSocket and quote. */
export interface FlowOverride {
  readonly connected: boolean
  readonly processes: Record<string, unknown> | null
  readonly quoteAgeMs: number | null
}

/**
 * The one status indicator of the header, the same on every page: a dot and
 * a short word for the flow (en vivo, con problemas, sin conexión) and the
 * PAPER mark. Clicking it opens the diagnosis: why the flow is not ok, usage
 * (CPU, data, Qwen, Kronos), the source and whatever technical detail the
 * page passes in `diagnosis`. The terminal passes `override` with what its
 * WebSocket reports; other pages derive the flow from the gateway's health.
 */
export default function AppStatusChips({
  apiBase,
  override,
  showUsage = true,
  modeLabel = 'PAPER · KRAKEN',
  diagnosis,
}: {
  apiBase: string
  override?: FlowOverride
  showUsage?: boolean
  modeLabel?: string
  diagnosis?: ReactNode
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
    <details className="app-status" data-tone={flow.level}>
      <summary title="Estado y diagnóstico">
        <span className="app-status__dot" aria-hidden="true" />
        <span data-testid="flow-status" aria-label={flow.label}>
          {SHORT_LABELS[flow.level]}
        </span>
        <span className="app-status__mode">{paper}</span>
      </summary>
      <div className="app-status__panel" aria-label="Diagnóstico">
        <p className="app-status__title">{flow.label}</p>
        {flow.reasons.length > 0 ? (
          <ul>
            {flow.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        ) : (
          <p>Todo corre con normalidad.</p>
        )}
        {showUsage && <SystemUsageChip apiBase={apiBase} />}
        <p>
          <strong>{modeLabel}</strong> · precios reales de Kraken, operaciones
          simuladas, sin órdenes reales ni conexión privada.
        </p>
        {diagnosis}
      </div>
    </details>
  )
}
