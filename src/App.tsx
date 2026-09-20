import { useMemo, useState } from 'react'
import PortfolioScreen from './app/portfolio/PortfolioScreen'
import WatchlistScreen from './app/watchlist/WatchlistScreen'
import InstrumentDetail from './app/detail/InstrumentDetail'
import AlertsScreen from './app/alerts/AlertsScreen'
import AlertNotificationCenter from './app/alerts/AlertNotificationCenter'
import { useAlerts } from './app/alerts/useAlerts'
import type { Instrument, MarketDataProvider } from './domain/market-data'
import type { PortfolioRepository } from './domain/portfolio'
import type { AlertRepository } from './domain/alerts'
import { LocalStoragePortfolioRepository } from './portfolio/local-storage-portfolio-repository'
import { LocalStorageAlertRepository } from './alerts/local-storage-alert-repository'
import { DeterministicMockMarketDataProvider } from './providers/deterministic-mock-market-data'
import './App.css'

type AppView = 'watchlist' | 'portfolio' | 'alerts'

type AppProps = {
  provider?: MarketDataProvider
  portfolioRepository?: PortfolioRepository
  alertRepository?: AlertRepository
}

function App({ provider, portfolioRepository, alertRepository }: AppProps) {
  const defaultProvider = useMemo(
    () => new DeterministicMockMarketDataProvider(1),
    [],
  )
  const defaultPortfolioRepository = useMemo(
    () => new LocalStoragePortfolioRepository(),
    [],
  )
  const defaultAlertRepository = useMemo(
    () => new LocalStorageAlertRepository(),
    [],
  )
  const activeProvider = provider ?? defaultProvider
  const activePortfolioRepository =
    portfolioRepository ?? defaultPortfolioRepository
  const activeAlertRepository = alertRepository ?? defaultAlertRepository
  const alerts = useAlerts(activeProvider, activeAlertRepository)
  const [view, setView] = useState<AppView>('watchlist')
  const [selectedInstrument, setSelectedInstrument] =
    useState<Instrument | null>(null)

  return (
    <main className="app">
      <h1>Balancita</h1>
      <p className="tagline">
        A local-first, mock-only personal trading workspace.
      </p>

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
