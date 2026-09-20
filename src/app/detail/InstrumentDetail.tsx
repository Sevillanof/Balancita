import { useMemo } from 'react'
import type {
  Candle,
  Instrument,
  MarketDataProvider,
  Quote,
} from '../../domain/market-data'
import type { AnalysisProvider } from '../../domain/analysis'
import type { PortfolioRepository } from '../../domain/portfolio'
import type { AnalysisMode } from '../AnalysisModeToggle'
import { toCandlestickDataset } from '../chart/candlestick-data'
import PriceChart from '../chart/PriceChart'
import {
  formatChange,
  formatLocalTime,
  formatPrice,
  formatQuoteStatus,
} from '../format'
import AnalysisPanel from './AnalysisPanel'
import { useCandleHistory } from './useCandleHistory'
import { useLatestQuote } from './useLatestQuote'
import './detail.css'

type InstrumentDetailProps = {
  provider: MarketDataProvider
  instrument: Instrument
  analysis?: AnalysisProvider
  analysisMode?: AnalysisMode
  analysisFallback?: AnalysisProvider
  portfolioRepository?: PortfolioRepository
}

const PLACEHOLDER = '—'
const EMPTY_CANDLES: readonly Candle[] = []

export default function InstrumentDetail({
  provider,
  instrument,
  analysis,
  analysisMode = 'local',
  analysisFallback,
  portfolioRepository,
}: InstrumentDetailProps) {
  const quote = useLatestQuote(provider, instrument.id)
  const history = useCandleHistory(provider, instrument.id)
  const chartData = useMemo(
    () =>
      history.status === 'ready' ? toCandlestickDataset(history.candles) : [],
    [history.status, history.candles],
  )

  return (
    <section className="detail" aria-label={`${instrument.symbol} details`}>
      <PriceSummary instrument={instrument} quote={quote} />
      {history.status === 'loading' && (
        <p role="status" aria-busy="true" className="detail__history-note">
          Cargando historial de precios…
        </p>
      )}
      {history.status === 'empty' && (
        <p role="status" className="detail__history-note">
          No hay velas históricas disponibles.
        </p>
      )}
      {history.status === 'error' && (
        <div role="alert" className="detail__history-note">
          No se pudo cargar el historial de precios.
          <button
            type="button"
            className="detail__retry"
            onClick={history.retry}
          >
            Reintentar
          </button>
        </div>
      )}
      {history.status === 'ready' && <PriceChart data={chartData} />}
      {analysis && portfolioRepository && (
        <AnalysisPanel
          mode={analysisMode}
          analysis={analysis}
          fallback={analysisFallback}
          portfolioRepository={portfolioRepository}
          instrument={instrument}
          quote={quote}
          candles={history.status === 'ready' ? history.candles : EMPTY_CANDLES}
        />
      )}
    </section>
  )
}

function PriceSummary({
  instrument,
  quote,
}: {
  instrument: Instrument
  quote: Quote | undefined
}) {
  const hasQuote = quote !== undefined
  const change = hasQuote ? formatChange(quote) : undefined

  return (
    <div className="detail__summary">
      <div>
        <h2 className="detail__symbol">{instrument.symbol}</h2>
        <span className="detail__name">{instrument.displayName}</span>
      </div>
      <dl className="detail__quote">
        <div className="detail__cell">
          <dt>Precio</dt>
          <dd className="detail__price">
            {hasQuote
              ? formatPrice(quote.price, instrument.currency)
              : PLACEHOLDER}
          </dd>
        </div>
        <div className="detail__cell">
          <dt>Variación</dt>
          <dd>
            {change ? (
              <span
                className={`detail__change--${change.direction}`}
                data-direction={change.direction}
              >
                {change.text}
              </span>
            ) : (
              PLACEHOLDER
            )}
          </dd>
        </div>
        <div className="detail__cell">
          <dt>Estado</dt>
          <dd>{quote ? formatQuoteStatus(quote.status) : PLACEHOLDER}</dd>
        </div>
        <div className="detail__cell">
          <dt>Última actualización</dt>
          <dd>{hasQuote ? formatLocalTime(quote.timestamp) : PLACEHOLDER}</dd>
        </div>
      </dl>
    </div>
  )
}
