import { useEffect, useState } from 'react'
import { record } from '../shared/wire/decode.ts'
import SystemUsageChip from './SystemUsageChip.tsx'
import { flowStatus } from './terminal-flow.ts'

const HEALTH_POLL_MS = 10_000

/** What the terminal already knows from its own WebSocket and quote. */
export interface FlowOverride {
  readonly connected: boolean
  readonly processes: Record<string, unknown> | null
  readonly quoteAgeMs: number | null
}

/**
 * The status chips of the header, the same on every page: flow (conectado,
 * con problemas, desconectado), usage (CPU, data, Qwen, Kronos) and the
 * source. The terminal passes `override` with what its WebSocket reports;
 * other pages derive the flow from the gateway's health feed.
 */
export default function AppStatusChips({
  apiBase,
  override,
  showUsage = true,
  modeLabel = 'PAPER · KRAKEN',
}: {
  apiBase: string
  override?: FlowOverride
  showUsage?: boolean
  modeLabel?: string
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
          const received = record(record(body).capture).last_received_at
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
  return (
    <>
      <span
        className="demo-shell__badge"
        data-testid="flow-status"
        data-tone={flow.level}
        title={flow.reasons.join('\n') || 'Todo corre con normalidad'}
      >
        {flow.label}
      </span>
      {showUsage && <SystemUsageChip apiBase={apiBase} />}
      <span
        className="demo-shell__badge demo-shell__badge--usage"
        title="Precios reales de Kraken, operaciones simuladas (paper)"
      >
        {modeLabel}
      </span>
    </>
  )
}
