import type { ReactNode } from 'react'
import { DataProvenance, StatusPill } from '../shared/mission-control/index.ts'

/**
 * Secondary section for what the live gateway reads from the retired D book.
 * It is history, not the state of the forward experiments, so it is labelled
 * and its provenance stated. Without the gateway engine the children render
 * as they are (MOCK keeps its own simulated data).
 */
export default function GatewayHistory({
  enabled,
  runId,
  children,
}: {
  enabled: boolean
  runId: string | null | undefined
  children: ReactNode
}) {
  if (!enabled) return <>{children}</>
  return (
    <details
      className="connected-terminal__panel"
      aria-label="Historial del gateway"
      open
    >
      <summary>
        Historial del gateway · libro D retirado{' '}
        <StatusPill tone="warn">Histórico</StatusPill>
      </summary>
      <DataProvenance
        origin="Gateway · libro D retirado (lectura)"
        runId={runId}
      />
      {children}
    </details>
  )
}
