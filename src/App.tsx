import { useMemo, useState } from 'react'
import PortfolioScreen from './app/portfolio/PortfolioScreen'
import WatchlistScreen from './app/watchlist/WatchlistScreen'
import InstrumentDetail from './app/detail/InstrumentDetail'
import type { Instrument, MarketDataProvider } from './domain/market-data'
import type { PortfolioRepository } from './domain/portfolio'
import { LocalStoragePortfolioRepository } from './portfolio/local-storage-portfolio-repository'
import { DeterministicMockMarketDataProvider } from './providers/deterministic-mock-market-data'
import './App.css'

type AppView = 'watchlist' | 'portfolio'

type AppProps = {
  provider?: MarketDataProvider
  portfolioRepository?: PortfolioRepository
}

function App({ provider, portfolioRepository }: AppProps) {
  const defaultProvider = useMemo(
    () => new DeterministicMockMarketDataProvider(1),
    [],
  )
  const defaultRepository = useMemo(
    () => new LocalStoragePortfolioRepository(),
    [],
  )
  const activeProvider = provider ?? defaultProvider
  const activeRepository = portfolioRepository ?? defaultRepository
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
      </div>

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
      ) : (
        <section
          role="tabpanel"
          id="panel-portfolio"
          aria-labelledby="tab-portfolio"
          className="app__panel"
        >
          <PortfolioScreen
            provider={activeProvider}
            repository={activeRepository}
          />
        </section>
      )}
    </main>
  )
}

export default App
