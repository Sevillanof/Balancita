import { useState } from 'react'
import type { AnalysisProvider } from '../domain/analysis'
import type { MarketDataProvider } from '../domain/market-data'
import type { PortfolioRepository } from '../domain/portfolio'
import type { AnalysisMode } from './AnalysisModeToggle'
import AlertsScreen from './alerts/AlertsScreen'
import type { UseAlertsResult } from './alerts/useAlerts'
import ChartPanel from './chart/ChartPanel'
import InstrumentDetail from './detail/InstrumentDetail'
import { useCandleHistory } from './detail/useCandleHistory'
import IntelligenceStatusPanel from './intelligence/IntelligenceStatusPanel'
import NewsPanel from './intelligence/NewsPanel'
import { NEWS_FIXTURES } from './intelligence/news-fixtures'
import { useIntelligenceStream } from './intelligence/useIntelligenceStream'
import PortfolioScreen from './portfolio/PortfolioScreen'
import BtcEurSummary from './summary/BtcEurSummary'
import AutoTradingControl from './trade/AutoTradingControl'
import TradeScreen from './trade/TradeScreen'
import { useTrading } from './trade/useTrading'
import WatchlistScreen from './watchlist/WatchlistScreen'
import { useWatchlist } from './watchlist/useWatchlist'
import { formatLocalTime, formatPriceMoney, formatQuoteStatus } from './format'
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
 * Phase 1 main screen: a desktop-first CSS grid with areas A–F backed by
 * deterministic mock data and the local paper ledger. No network is used here;
 * areas C and D are fed by mock candles and local fixtures respectively.
 */
export default function BtcEurDashboard({
  provider,
  labProvider,
  portfolioRepository,
  alerts,
  analysis,
  analysisMode,
  analysisFallback,
  dataMode,
}: BtcEurDashboardProps) {
  const market = useWatchlist(provider)
  const intelligence = useIntelligenceStream()
  const history = useCandleHistory(provider, 'BTC-EUR')
  const ledger = useTrading(provider, {
    portfolioRepository,
    initialInstrumentId: 'BTC-EUR',
  })
  const [portfolioRefresh, setPortfolioRefresh] = useState(0)
  const instrument = market.instruments.find(({ id }) => id === 'BTC-EUR')
  const quote =
    instrument === undefined ? undefined : market.quotes.get(instrument.id)
  const marketModeLabel =
    dataMode === 'real' ? 'Datos reales' : 'Datos simulados'
  const eur = ledger.account === null ? undefined : ledger.account.cash.EUR
  const ready = market.status === 'ready' && instrument !== undefined

  return (
    <div className="dashboard">
      <div className="dashboard__grid">
        <header className="dashboard__brand">
          <h2 className="dashboard__brand-title">Balancita (BTC/EUR)</h2>
          <div className="dashboard__market-status" aria-live="polite">
            <span className="badge dashboard__mode">{marketModeLabel}</span>
            <span className="badge dashboard__quote-status">
              {quote ? formatQuoteStatus(quote.status) : 'Esperando datos'}
            </span>
            <span className="dashboard__timestamp">
              Última actualización:{' '}
              {quote ? formatLocalTime(quote.timestamp) : '—'}
            </span>
          </div>
        </header>

        <section
          className="dashboard__available"
          aria-label="Dinero disponible"
        >
          <p className="dashboard__eyebrow">Dinero disponible</p>
          <p className="dashboard__available-amount">
            {eur === undefined ? '—' : formatPriceMoney(eur, 'EUR')}
          </p>
          <p className="dashboard__caption">Ledger local de paper trading</p>
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
                <div className="section-header">
                  <div>
                    <p className="dashboard__eyebrow">Qué puedo hacer</p>
                    <h2 id="dashboard-trade-title">Comprar o vender BTC-EUR</h2>
                  </div>
                  <span className="badge">Operación simulada</span>
                </div>
                <TradeScreen
                  provider={provider}
                  portfolioRepository={portfolioRepository}
                  initialInstrumentId="BTC-EUR"
                  onAccountChanged={() => {
                    setPortfolioRefresh((value) => value + 1)
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

      <div className="dashboard__disclaimer" role="note">
        <strong>Operación simulada.</strong> El precio puede ser una referencia
        de mercado, pero este simulador local es la única autoridad de órdenes,
        posiciones y ledger.
      </div>

      <IntelligenceStatusPanel dataMode={dataMode} stream={intelligence} />

      {ready && instrument !== undefined && (
        <>
          <InstrumentDetail
            key={instrument.id}
            provider={provider}
            instrument={instrument}
            analysis={analysis}
            analysisMode={analysisMode}
            analysisFallback={analysisFallback}
            portfolioRepository={portfolioRepository}
            automaticAnalysis={analysisMode === 'local'}
          />

          <section
            className="dashboard__surface"
            aria-labelledby="dashboard-situation-title"
          >
            <div className="section-header">
              <div>
                <p className="dashboard__eyebrow">Cuál es mi situación</p>
                <h2 id="dashboard-situation-title">Efectivo y posición</h2>
              </div>
              <span className="dashboard__caption">
                Valores derivados del ledger y la cotización
              </span>
            </div>
            <PortfolioScreen
              key={portfolioRefresh}
              provider={provider}
              repository={portfolioRepository}
            />
          </section>

          <details className="dashboard__secondary">
            <summary>Alertas BTC-EUR</summary>
            <AlertsScreen alerts={alerts} instrumentIds={['BTC-EUR']} />
          </details>

          <details className="dashboard__secondary">
            <summary>Laboratorio mock: TTWO y SPCX</summary>
            <p className="dashboard__caption">
              Superficie secundaria para explorar instrumentos simulados. No
              cambia el flujo principal BTC-EUR.
            </p>
            <WatchlistScreen provider={labProvider} />
          </details>
        </>
      )}
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
