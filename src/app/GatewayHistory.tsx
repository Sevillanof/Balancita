import type { ReactNode } from 'react'
import { DataProvenance, StatusPill } from '../shared/mission-control/index.ts'
import { TERMINAL_PANEL } from '../shared/design-system/terminal-styles.ts'

/**
 * Secondary section for what the live gateway reads from the retired D book.
 * It is history, not the state of the forward experiments, so it is labelled
 * and its provenance stated. Without the gateway engine the children render
 * as they are.
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
    <details className={TERMINAL_PANEL} aria-label="Historial del gateway">
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
