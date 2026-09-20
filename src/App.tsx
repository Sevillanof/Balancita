import { useMemo, useState } from 'react'
import WatchlistScreen from './app/watchlist/WatchlistScreen'
import InstrumentDetail from './app/detail/InstrumentDetail'
import type {
  Instrument,
  MarketDataProvider,
} from './domain/market-data'
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
  const [selectedInstrument, setSelectedInstrument] =
    useState<Instrument | null>(null)

  return (
    <main className="app">
      <h1>Balancita</h1>
      <p className="tagline">
        A local-first, mock-only personal trading workspace.
      </p>
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
    </main>
  )
}

export default App
