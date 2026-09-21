import { useState } from 'react'
import type { AnalysisProvider } from '../domain/analysis'
import type { MarketDataProvider } from '../domain/market-data'
import type { PortfolioRepository } from '../domain/portfolio'
import type { AnalysisMode } from './AnalysisModeToggle'
import AlertsScreen from './alerts/AlertsScreen'
import type { UseAlertsResult } from './alerts/useAlerts'
import InstrumentDetail from './detail/InstrumentDetail'
import PortfolioScreen from './portfolio/PortfolioScreen'
import TradeScreen from './trade/TradeScreen'
import WatchlistScreen from './watchlist/WatchlistScreen'
import { useWatchlist } from './watchlist/useWatchlist'
import IntelligenceStatusPanel from './intelligence/IntelligenceStatusPanel'
import { useIntelligenceStream } from './intelligence/useIntelligenceStream'
import { formatLocalTime, formatQuoteStatus } from './format'
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
  const [portfolioRefresh, setPortfolioRefresh] = useState(0)
  const instrument = market.instruments.find(({ id }) => id === 'BTC-EUR')
  const quote =
    instrument === undefined ? undefined : market.quotes.get(instrument.id)
  const marketModeLabel =
    dataMode === 'real' ? 'Datos reales' : 'Datos simulados'

  if (market.status === 'loading') {
    return (
      <p role="status" aria-busy="true">
        Cargando BTC-EUR…
      </p>
    )
  }
  if (market.status === 'error') {
    return (
      <section className="dashboard__state" aria-label="Estado del dashboard">
        <h2>No se pudo cargar BTC-EUR</h2>
        <p role="alert">La fuente de datos no está disponible.</p>
        <button
          type="button"
          className="button button--secondary"
          onClick={market.retry}
        >
          Reintentar
        </button>
      </section>
    )
  }
  if (market.status === 'empty' || instrument === undefined) {
    return (
      <section className="dashboard__state" aria-label="Estado del dashboard">
        <h2>BTC-EUR no está disponible</h2>
        <p role="status">
          No hay un instrumento BTC-EUR en la fuente seleccionada.
        </p>
      </section>
    )
  }

  return (
    <div className="dashboard">
      <header
        className="dashboard__market-header"
        aria-label="Resumen de BTC-EUR"
      >
        <div>
          <p className="dashboard__eyebrow">Instrumento principal</p>
          <h2>{instrument.symbol}</h2>
          <p>
            {instrument.displayName} · {instrument.currency}
          </p>
        </div>
        <div className="dashboard__market-status" aria-live="polite">
          <span className="badge dashboard__mode">{marketModeLabel}</span>
          <span className="badge">
            {quote ? formatQuoteStatus(quote.status) : 'Esperando datos'}
          </span>
          <span>
            Última actualización:{' '}
            {quote ? formatLocalTime(quote.timestamp) : '—'}
          </span>
        </div>
      </header>

      <div className="dashboard__disclaimer" role="note">
        <strong>Operación simulada.</strong> El precio puede ser una referencia
        de mercado, pero este simulador local es la única autoridad de órdenes,
        posiciones y ledger.
      </div>

      <IntelligenceStatusPanel dataMode={dataMode} stream={intelligence} />

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

      <div className="dashboard__work-grid">
        <section
          className="dashboard__surface"
          aria-labelledby="dashboard-trade-title"
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
            onAccountChanged={() => setPortfolioRefresh((value) => value + 1)}
          />
        </section>

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
      </div>

      <details className="dashboard__secondary">
        <summary>Alertas BTC-EUR</summary>
        <AlertsScreen alerts={alerts} instrumentIds={['BTC-EUR']} />
      </details>

      <details className="dashboard__secondary">
        <summary>Laboratorio mock: TTWO y SPCX</summary>
        <p className="dashboard__caption">
          Superficie secundaria para explorar instrumentos simulados. No cambia
          el flujo principal BTC-EUR.
        </p>
        <WatchlistScreen provider={labProvider} />
      </details>
    </div>
  )
}
