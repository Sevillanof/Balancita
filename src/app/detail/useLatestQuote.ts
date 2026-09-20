import { useEffect, useState } from 'react'
import type {
  InstrumentId,
  MarketDataProvider,
  Quote,
} from '../../domain/market-data'

export function useLatestQuote(
  provider: MarketDataProvider,
  instrumentId: InstrumentId,
): Quote | undefined {
  const [quote, setQuote] = useState<Quote | undefined>(undefined)

  useEffect(() => {
    let active = true
    setQuote(undefined)

    try {
      const release = provider.subscribe([instrumentId], (incoming: Quote) => {
        if (!active) return
        if (incoming.instrumentId !== instrumentId) return
        setQuote(incoming)
      })

      return () => {
        active = false
        release()
      }
    } catch {
      return () => {
        active = false
      }
    }
  }, [provider, instrumentId])

  return quote
}
