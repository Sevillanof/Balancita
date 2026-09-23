import { useEffect, useState } from 'react'
import type {
  InstrumentId,
  MarketDataProvider,
  Quote,
} from '../../market-data/domain/market-data.ts'

type LatestQuote = {
  instrumentId: InstrumentId
  quote: Quote
}

export function useLatestQuote(
  provider: MarketDataProvider,
  instrumentId: InstrumentId,
): Quote | undefined {
  const [latest, setLatest] = useState<LatestQuote | null>(null)

  useEffect(() => {
    let active = true

    try {
      const release = provider.subscribe([instrumentId], (incoming: Quote) => {
        if (!active) return
        if (incoming.instrumentId !== instrumentId) return
        setLatest({ instrumentId, quote: incoming })
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

  return latest?.instrumentId === instrumentId ? latest.quote : undefined
}
