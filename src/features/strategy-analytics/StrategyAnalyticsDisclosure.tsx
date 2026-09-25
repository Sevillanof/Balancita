import { useState } from 'react'
import StrategyAnalyticsPanel from './StrategyAnalyticsPanel.tsx'

export default function StrategyAnalyticsDisclosure() {
  const [open, setOpen] = useState(false)
  return (
    <details
      className="dashboard__strategy-audit"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>Auditoría por Estrategia y Ledger de Posiciones</summary>
      {open && <StrategyAnalyticsPanel />}
    </details>
  )
}
