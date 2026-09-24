import { useMemo, useState } from 'react'
import type { Candle, Quote } from '../../market-data/domain/market-data.ts'
import type { CandleHistoryStatus } from '../../analysis/presentation/useCandleHistory'
import {
  mergeQuoteIntoCandles,
  reconcileLiveCandles,
  toCandlestickDataset,
} from './candlestick-data.ts'
import PriceChart from './PriceChart.tsx'
import './chart.css'

type ChartPanelProps = {
  readonly status: CandleHistoryStatus
  readonly candles: readonly Candle[]
  readonly quote?: Quote
  readonly onRetry: () => void
}

/**
 * Area C of the main screen: the dominant BTC-EUR candlestick chart. It owns
 * the per-area loading/empty/error states and reuses the existing PriceChart.
 */
export default function ChartPanel({
  status,
  candles,
  quote,
  onRetry,
}: ChartPanelProps) {
  const [liveState, setLiveState] = useState(() => ({
    restCandles: candles,
    quote,
    candles:
      quote === undefined
        ? [...candles]
        : mergeQuoteIntoCandles(candles, quote),
  }))
  if (
    status === 'ready' &&
    (liveState.restCandles !== candles || liveState.quote !== quote)
  ) {
    const reconciled = reconcileLiveCandles(candles, liveState.candles)
    setLiveState({
      restCandles: candles,
      quote,
      candles:
        quote === undefined
          ? reconciled
          : mergeQuoteIntoCandles(reconciled, quote),
    })
  }

  const data = useMemo(
    () =>
      status === 'ready'
        ? toCandlestickDataset(reconcileLiveCandles(candles, liveState.candles))
        : [],
    [status, candles, liveState.candles],
  )

  return (
    <section className="chart-panel" aria-label="Gráfico BTC-EUR">
      {quote !== undefined && (
        <p
          className="chart-panel__freshness"
          data-testid="chart-freshness"
          role="status"
          aria-live="polite"
        >
          {freshnessLabel(quote)}
        </p>
      )}
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

function freshnessLabel(quote: Quote): string {
  const age =
    quote.freshnessAgeMs === undefined
      ? ''
      : ` · frescura ${formatFreshnessAge(quote.freshnessAgeMs)}`
  if (quote.status === 'stale' || quote.freshnessIsStale === true) {
    return `Mercado stale${age}`
  }
  if (quote.status === 'live') return `Mercado en vivo${age}`
  if (quote.status === 'delayed') return `Mercado retrasado${age}`
  return 'Mercado simulado'
}

function formatFreshnessAge(ageMs: number): string {
  if (ageMs < 1000) return `${Math.max(0, Math.round(ageMs))} ms`
  return `${Math.round(ageMs / 1000)} s`
}
