import { useMemo, useState } from 'react'
import PortfolioScreen from './app/portfolio/PortfolioScreen'
import TradeScreen from './app/trade/TradeScreen'
import WatchlistScreen from './app/watchlist/WatchlistScreen'
import InstrumentDetail from './app/detail/InstrumentDetail'
import AlertsScreen from './app/alerts/AlertsScreen'
import AlertNotificationCenter from './app/alerts/AlertNotificationCenter'
import { useAlerts } from './app/alerts/useAlerts'
import type { AnalysisProvider } from './domain/analysis'
import type { Instrument, MarketDataProvider } from './domain/market-data'
import type { PortfolioRepository } from './domain/portfolio'
import type { AlertRepository } from './domain/alerts'
import { LocalStoragePortfolioRepository } from './portfolio/local-storage-portfolio-repository'
import { LocalStorageAlertRepository } from './alerts/local-storage-alert-repository'
import { createMarketDataProvider } from './providers/market-data-provider'
import { GeminiAnalysisProvider } from './providers/gemini-analysis-provider'
import { MockAnalysisProvider } from './providers/mock-analysis-provider'
import { AnalysisModeToggle } from './app/AnalysisModeToggle'
import type { AnalysisMode } from './app/AnalysisModeToggle'
import './App.css'

type AppView = 'watchlist' | 'portfolio' | 'trade' | 'alerts'

type AppProps = {
  provider?: MarketDataProvider
  portfolioRepository?: PortfolioRepository
  alertRepository?: AlertRepository
  analysis?: AnalysisProvider
  /** Optional remote Gemini provider. When provided, the AI toggle is enabled. */
  geminiAnalysis?: AnalysisProvider
}

function App({
  provider,
  portfolioRepository,
  alertRepository,
  analysis,
  geminiAnalysis,
}: AppProps) {
  const defaultProvider = useMemo(() => createMarketDataProvider(), [])
  const defaultPortfolioRepository = useMemo(
    () => new LocalStoragePortfolioRepository(),
    [],
  )
  const defaultAlertRepository = useMemo(
    () => new LocalStorageAlertRepository(),
    [],
  )
  const defaultAnalysis = useMemo(() => new MockAnalysisProvider(), [])
  const defaultGeminiAnalysis = useMemo(
    () =>
      new GeminiAnalysisProvider(
        import.meta.env.VITE_GEMINI_SERVER_URL ?? 'http://127.0.0.1:8787',
      ),
    [],
  )
  const activeProvider = provider ?? defaultProvider
  const activePortfolioRepository =
    portfolioRepository ?? defaultPortfolioRepository
  const activeAlertRepository = alertRepository ?? defaultAlertRepository
  const activeAnalysis = analysis ?? defaultAnalysis
  const activeGeminiAnalysis = geminiAnalysis ?? defaultGeminiAnalysis
  const alerts = useAlerts(activeProvider, activeAlertRepository)
  const [view, setView] = useState<AppView>('watchlist')
  const [selectedInstrument, setSelectedInstrument] =
    useState<Instrument | null>(null)
  const [analysisMode, setAnalysisMode] = useState<AnalysisMode>('local')

  const currentAnalysis =
    analysisMode === 'ai' ? activeGeminiAnalysis : activeAnalysis

  return (
    <main className="app">
      <header className="app__header">
        <h1>Balancita</h1>
        <p className="tagline">A local-first personal trading workspace.</p>
        <AnalysisModeToggle mode={analysisMode} onChange={setAnalysisMode} />
      </header>

      <div role="tablist" aria-label="Workspace views" className="app__tabs">
        <button
          type="button"
          role="tab"
          id="tab-watchlist"
          aria-selected={view === 'watchlist'}
          aria-controls="panel-watchlist"
          className="app__tab"
          onClick={() => setView('watchlist')}
        >
          Watchlist
        </button>
        <button
          type="button"
          role="tab"
          id="tab-portfolio"
          aria-selected={view === 'portfolio'}
          aria-controls="panel-portfolio"
          className="app__tab"
          onClick={() => setView('portfolio')}
        >
          Portfolio
        </button>
        <button
          type="button"
          role="tab"
          id="tab-trade"
          aria-selected={view === 'trade'}
          aria-controls="panel-trade"
          className="app__tab"
          onClick={() => setView('trade')}
        >
          Trade
        </button>
        <button
          type="button"
          role="tab"
          id="tab-alerts"
          aria-selected={view === 'alerts'}
          aria-controls="panel-alerts"
          className="app__tab"
          onClick={() => setView('alerts')}
        >
          Alerts
        </button>
      </div>

      <AlertNotificationCenter
        triggered={alerts.triggered}
        onAcknowledge={(id) => void alerts.acknowledge(id)}
      />

      {view === 'watchlist' ? (
        <section
          role="tabpanel"
          id="panel-watchlist"
          aria-labelledby="tab-watchlist"
          className="app__panel"
        >
          <WatchlistScreen
            provider={activeProvider}
            selectedInstrumentId={selectedInstrument?.id}
            onSelectInstrument={setSelectedInstrument}
          />
          {selectedInstrument && (
            <InstrumentDetail
              key={selectedInstrument.id}
              provider={activeProvider}
              instrument={selectedInstrument}
              analysis={currentAnalysis}
              analysisMode={analysisMode}
              analysisFallback={
                analysisMode === 'ai' ? activeAnalysis : undefined
              }
              portfolioRepository={activePortfolioRepository}
            />
          )}
        </section>
      ) : view === 'alerts' ? (
        <section
          role="tabpanel"
          id="panel-alerts"
          aria-labelledby="tab-alerts"
          className="app__panel"
        >
          <AlertsScreen alerts={alerts} />
        </section>
      ) : view === 'trade' ? (
        <section
          role="tabpanel"
          id="panel-trade"
          aria-labelledby="tab-trade"
          className="app__panel"
        >
          <TradeScreen provider={activeProvider} />
        </section>
      ) : (
        <section
          role="tabpanel"
          id="panel-portfolio"
          aria-labelledby="tab-portfolio"
          className="app__panel"
        >
          <PortfolioScreen
            provider={activeProvider}
            repository={activePortfolioRepository}
          />
        </section>
      )}
    </main>
  )
}

export default App
