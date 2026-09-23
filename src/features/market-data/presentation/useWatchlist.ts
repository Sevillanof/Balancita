import { useCallback, useEffect, useState } from 'react'
import type {
  Instrument,
  InstrumentId,
  MarketDataProvider,
  Quote,
} from '../domain/market-data.ts'

export type WatchlistStatus = 'loading' | 'ready' | 'empty' | 'error'

export type WatchlistState = {
  status: WatchlistStatus
  instruments: readonly Instrument[]
  quotes: ReadonlyMap<InstrumentId, Quote>
}

const INITIAL_STATE: WatchlistState = {
  status: 'loading',
  instruments: [],
  quotes: new Map(),
}

export type UseWatchlistResult = WatchlistState & {
  retry: () => void
}

export function useWatchlist(provider: MarketDataProvider): UseWatchlistResult {
  const [reloadKey, setReloadKey] = useState(0)
  const [state, setState] = useState<WatchlistState>(INITIAL_STATE)

  const retry = useCallback(() => {
    setState(INITIAL_STATE)
    setReloadKey((key) => key + 1)
  }, [])

  useEffect(() => {
    let active = true
    let release: (() => void) | undefined

    provider.getInstruments().then(
      (instruments) => {
        if (!active) return

        if (instruments.length === 0) {
          setState({ status: 'empty', instruments: [], quotes: new Map() })
          return
        }

        setState({ status: 'ready', instruments, quotes: new Map() })

        try {
          release = provider.subscribe(
            instruments.map((instrument) => instrument.id),
            (quote: Quote) => {
              setState((previous) => {
                if (previous.status !== 'ready') return previous
                const quotes = new Map(previous.quotes)
                quotes.set(quote.instrumentId, quote)
                return { ...previous, quotes }
              })
            },
          )
        } catch {
          if (active) {
            setState({ status: 'error', instruments: [], quotes: new Map() })
          }
        }
      },
      () => {
        if (!active) return
        setState({ status: 'error', instruments: [], quotes: new Map() })
      },
    )

    return () => {
      active = false
      release?.()
    }
  }, [provider, reloadKey])

  return { ...state, retry }
}
