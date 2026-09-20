import { useMemo } from 'react'
import type {
  Candle,
  Instrument,
  MarketDataProvider,
  Quote,
} from '../../domain/market-data'
import type { AnalysisProvider } from '../../domain/analysis'
import type { PortfolioRepository } from '../../domain/portfolio'
import { toCandlestickDataset } from '../chart/candlestick-data'
import PriceChart from '../chart/PriceChart'
import { formatChange, formatLocalTime, formatPrice } from '../format'
import AnalysisPanel from './AnalysisPanel'
import { useCandleHistory } from './useCandleHistory'
import { useLatestQuote } from './useLatestQuote'
import './detail.css'

type InstrumentDetailProps = {
  provider: MarketDataProvider
  instrument: Instrument
  analysis?: AnalysisProvider
  portfolioRepository?: PortfolioRepository
}

const PLACEHOLDER = '—'
const EMPTY_CANDLES: readonly Candle[] = []

export default function InstrumentDetail({
  provider,
  instrument,
  analysis,
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
          Loading price history…
        </p>
      )}
      {history.status === 'empty' && (
        <p role="status" className="detail__history-note">
          No historical candles available.
        </p>
      )}
      {history.status === 'error' && (
        <div role="alert" className="detail__history-note">
          Unable to load price history.
          <button
            type="button"
            className="detail__retry"
            onClick={history.retry}
          >
            Retry
          </button>
        </div>
      )}
      {history.status === 'ready' && <PriceChart data={chartData} />}
      {analysis && portfolioRepository && (
        <AnalysisPanel
          analysis={analysis}
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
          <dt>Price</dt>
          <dd className="detail__price">
            {hasQuote
              ? formatPrice(quote.price, instrument.currency)
              : PLACEHOLDER}
          </dd>
        </div>
        <div className="detail__cell">
          <dt>Change</dt>
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
          <dt>Status</dt>
          <dd>{quote?.status ?? PLACEHOLDER}</dd>
        </div>
        <div className="detail__cell">
          <dt>Last update</dt>
          <dd>{hasQuote ? formatLocalTime(quote.timestamp) : PLACEHOLDER}</dd>
        </div>
      </dl>
    </div>
  )
}
