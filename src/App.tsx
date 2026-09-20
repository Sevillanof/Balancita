import { useMemo } from 'react'
import WatchlistScreen from './app/watchlist/WatchlistScreen'
import type { MarketDataProvider } from './domain/market-data'
import { DeterministicMockMarketDataProvider } from './providers/deterministic-mock-market-data'
import './App.css'

type AppProps = {
  provider?: MarketDataProvider
}

function App({ provider }: AppProps) {
  const defaultProvider = useMemo(
    () => new DeterministicMockMarketDataProvider(1),
    [],
  )
  const activeProvider = provider ?? defaultProvider

  return (
    <main className="app">
      <h1>Balancita</h1>
      <p className="tagline">
        A local-first, mock-only personal trading workspace.
      </p>
      <WatchlistScreen provider={activeProvider} />
    </main>
  )
}

export default App
