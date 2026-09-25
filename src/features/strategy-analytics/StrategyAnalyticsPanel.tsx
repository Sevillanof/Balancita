import { useState } from 'react'
import { useStrategyAnalytics } from './useStrategyAnalytics.ts'
import StrategyCards from './StrategyCards.tsx'
import PositionLifecycleTable from './PositionLifecycleTable.tsx'
import './strategy-analytics.css'

export default function StrategyAnalyticsPanel() {
  const [status, setStatus] = useState<'open' | 'closed'>('open')
  const analytics = useStrategyAnalytics(status)
  return (
    <section
      className="strategy-analytics"
      aria-label="Auditoría por Estrategia y Ledger de Posiciones"
    >
      <h2>Auditoría por Estrategia y Ledger de Posiciones</h2>
      {analytics.loading && <p role="status">Cargando auditoría…</p>}
      {analytics.error && <p role="alert">{analytics.error}</p>}
      <StrategyCards
        strategies={analytics.strategies}
        fastReplayBrier={analytics.fastReplayBrier}
      />
      <div role="tablist" aria-label="Estado de posiciones">
        <button
          type="button"
          role="tab"
          aria-selected={status === 'open'}
          onClick={() => setStatus('open')}
        >
          Activas (Long)
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={status === 'closed'}
          onClick={() => setStatus('closed')}
        >
          Historial cerrado
        </button>
      </div>
      <PositionLifecycleTable positions={analytics.positions} status={status} />
      <p>El peaje se presenta como — si el PnL bruto agregado es cero.</p>
    </section>
  )
}
