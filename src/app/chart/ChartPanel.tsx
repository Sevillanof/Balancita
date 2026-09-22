import { useMemo } from 'react'
import type { Candle } from '../../domain/market-data'
import type { CandleHistoryStatus } from '../detail/useCandleHistory'
import { toCandlestickDataset } from './candlestick-data'
import PriceChart from './PriceChart'
import './chart.css'

type ChartPanelProps = {
  readonly status: CandleHistoryStatus
  readonly candles: readonly Candle[]
  readonly onRetry: () => void
}

/**
 * Area C of the main screen: the dominant BTC-EUR candlestick chart. It owns
 * the per-area loading/empty/error states and reuses the existing PriceChart.
 */
export default function ChartPanel({
  status,
  candles,
  onRetry,
}: ChartPanelProps) {
  const data = useMemo(
    () => (status === 'ready' ? toCandlestickDataset(candles) : []),
    [status, candles],
  )

  return (
    <section className="chart-panel" aria-label="Gráfico BTC-EUR">
      <div className="section-header chart-panel__header">
        <div>
          <p className="dashboard__eyebrow">Gráfico dominante</p>
          <h2 id="dashboard-chart-title">BTC-EUR</h2>
        </div>
        <span className="dashboard__caption">Velas BTC-EUR (mock)</span>
      </div>

      {status === 'loading' && (
        <p role="status" aria-busy="true" className="chart-panel__state">
          Cargando velas BTC-EUR…
        </p>
      )}

      {status === 'empty' && (
        <p role="status" className="chart-panel__state">
          No hay velas BTC-EUR disponibles.
        </p>
      )}

      {status === 'error' && (
        <div
          role="alert"
          className="chart-panel__state chart-panel__state--error"
        >
          <span>No se pudo cargar el gráfico BTC-EUR.</span>
          <button
            type="button"
            className="chart-panel__retry"
            onClick={onRetry}
          >
            Reintentar
          </button>
        </div>
      )}

      {status === 'ready' && <PriceChart data={data} />}
    </section>
  )
}
