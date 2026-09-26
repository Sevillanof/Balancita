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
      <div
        aria-label="Estado de sincronización"
        className="strategy-analytics__heartbeat"
      >
        <p aria-label="Última sincronización">
          Sincronizado: {formatUtcTime(analytics.lastSuccessfulPollAt)} UTC
        </p>
        <p aria-label="Sondeo HTTP, frecuencia cada cinco segundos">
          Sondeo HTTP (cada 5 s):{' '}
          {analytics.error
            ? 'Error; reintento programado'
            : analytics.lastSuccessfulPollAt
              ? 'Activo'
              : 'Esperando primera respuesta'}
        </p>
        <p aria-label="Conexión del flujo ascendente">
          Flujo ascendente: {analytics.streamState ?? 'Sin datos'}
        </p>
        <p aria-label="Última vela evaluada">
          Última vela evaluada (UTC):{' '}
          {formatUtcDateTime(analytics.lastProcessedEventTime)}
        </p>
      </div>
      {analytics.loading && <p role="status">Cargando auditoría…</p>}
      {analytics.error && (
        <p role="alert" className="strategy-analytics__connection-error">
          Desconectado / Reintentando...
        </p>
      )}
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
      {analytics.positionsStatus === status && (
        <PositionLifecycleTable
          positions={analytics.positions}
          status={status}
        />
      )}
      <p>El peaje se presenta como — si el PnL bruto agregado es cero.</p>
    </section>
  )
}

function formatUtcTime(value: string | null): string {
  if (value === null) return 'Sin sincronizar'
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return 'Sin sincronizar'
  return [date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds()]
    .map((part) => String(part).padStart(2, '0'))
    .join(':')
}

function formatUtcDateTime(value: string | null): string {
  if (value === null) return 'Sin velas procesadas'
  const date = new Date(value)
  return Number.isFinite(date.getTime())
    ? date.toLocaleString('es-ES', {
        timeZone: 'UTC',
        dateStyle: 'medium',
        timeStyle: 'medium',
        hour12: false,
      })
    : 'Sin datos válidos'
}
