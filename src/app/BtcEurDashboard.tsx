import type { AnalysisProvider } from '../domain/analysis'
import type { MarketDataProvider } from '../domain/market-data'
import type { PortfolioRepository } from '../domain/portfolio'
import type { AnalysisMode } from './AnalysisModeToggle'
import ChartPanel from './chart/ChartPanel'
import { useCandleHistory } from './detail/useCandleHistory'
import NewsPanel from './intelligence/NewsPanel'
import { NEWS_FIXTURES } from './intelligence/news-fixtures'
import BtcEurSummary from './summary/BtcEurSummary'
import AutoTradingControl from './trade/AutoTradingControl'
import TradeScreen from './trade/TradeScreen'
import { useTrading } from './trade/useTrading'
import { useWatchlist } from './watchlist/useWatchlist'
import type { UseAlertsResult } from './alerts/useAlerts'
import { formatPriceMoney } from './format'
import './dashboard.css'

type BtcEurDashboardProps = {
  provider: MarketDataProvider
  labProvider: MarketDataProvider
  portfolioRepository: PortfolioRepository
  alerts: UseAlertsResult
  analysis: AnalysisProvider
  analysisMode: AnalysisMode
  analysisFallback?: AnalysisProvider
  dataMode: 'real' | 'simulated'
}

/**
 * Phase 1 main screen: a desktop-first CSS grid that renders ONLY the six
 * wireframe areas A–F backed by deterministic mock data and the local paper
 * ledger. No network is used here; the chart and news come from mock candles
 * and local fixtures respectively. Secondary surfaces (instrument detail,
 * portfolio, alerts, mock lab, intelligence status) are intentionally not part
 * of the Phase 1 screen and live in their own modules and tests.
 *
 * The `labProvider`, `alerts`, `analysis*` and `dataMode` props remain wired by
 * the app shell but are unused here; a later phase reattaches those surfaces.
 */
export default function BtcEurDashboard({
  provider,
  portfolioRepository,
}: BtcEurDashboardProps) {
  const market = useWatchlist(provider)
  const history = useCandleHistory(provider, 'BTC-EUR')
  const ledger = useTrading(provider, {
    portfolioRepository,
    initialInstrumentId: 'BTC-EUR',
  })
  const instrument = market.instruments.find(({ id }) => id === 'BTC-EUR')
  const quote =
    instrument === undefined ? undefined : market.quotes.get(instrument.id)
  const eur = ledger.account === null ? undefined : ledger.account.cash.EUR
  const ready = market.status === 'ready' && instrument !== undefined

  return (
    <div className="dashboard">
      <div className="dashboard__grid">
        <header className="dashboard__brand">
          <span className="dashboard__brand-mark" aria-hidden="true" />
          <h1 className="dashboard__brand-title">Balancita (BTC/EUR)</h1>
        </header>

        <section
          className="dashboard__available"
          aria-label="Dinero disponible"
        >
          <p className="dashboard__eyebrow">Dinero disponible</p>
          <p className="dashboard__available-amount">
            {eur === undefined ? '—' : formatPriceMoney(eur, 'EUR')}
          </p>
        </section>

        {market.status === 'loading' && <GridState kind="loading" />}
        {market.status === 'error' && (
          <GridState kind="error" onRetry={market.retry} />
        )}
        {(market.status === 'empty' ||
          (market.status === 'ready' && instrument === undefined)) && (
          <GridState kind="empty" />
        )}

        {ready && instrument !== undefined && (
          <>
            <ChartPanel
              status={history.status}
              candles={history.candles}
              onRetry={history.retry}
            />
            <NewsPanel status="ready" items={NEWS_FIXTURES} />
            <div className="dashboard__controls-scroll">
              <section
                className="dashboard__trade-area"
                aria-label="Operar BTC-EUR"
              >
                <TradeScreen
                  provider={provider}
                  portfolioRepository={portfolioRepository}
                  initialInstrumentId="BTC-EUR"
                  onAccountChanged={() => {
                    void ledger.refreshAccount()
                  }}
                />
                <AutoTradingControl />
              </section>
              <BtcEurSummary quote={quote} candles={history.candles} />
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function GridState({
  kind,
  onRetry,
}: {
  kind: 'loading' | 'error' | 'empty'
  onRetry?: () => void
}) {
  return (
    <section className="dashboard__state" aria-label="Estado del dashboard">
      {kind === 'loading' && (
        <p role="status" aria-busy="true">
          Cargando BTC-EUR…
        </p>
      )}
      {kind === 'error' && (
        <>
          <p role="alert">
            No se pudo cargar BTC-EUR. La fuente de datos no está disponible.
          </p>
          {onRetry !== undefined && (
            <button
              type="button"
              className="button button--secondary"
              onClick={onRetry}
            >
              Reintentar
            </button>
          )}
        </>
      )}
      {kind === 'empty' && (
        <p role="status">
          BTC-EUR no está disponible en la fuente seleccionada.
        </p>
      )}
    </section>
  )
}
