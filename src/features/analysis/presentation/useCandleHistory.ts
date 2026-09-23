import { useCallback, useEffect, useState } from 'react'
import type {
  Candle,
  InstrumentId,
  MarketDataProvider,
} from '../../market-data/domain/market-data.ts'

export type CandleHistoryStatus = 'loading' | 'ready' | 'empty' | 'error'

type HistoryResult = {
  instrumentId: InstrumentId
  status: Exclude<CandleHistoryStatus, 'loading'>
  candles: readonly Candle[]
}

const EMPTY: readonly Candle[] = []

export type UseCandleHistoryResult = {
  status: CandleHistoryStatus
  candles: readonly Candle[]
  retry: () => void
}

export function useCandleHistory(
  provider: MarketDataProvider,
  instrumentId: InstrumentId,
): UseCandleHistoryResult {
  const [reloadKey, setReloadKey] = useState(0)
  const [result, setResult] = useState<HistoryResult | null>(null)

  const retry = useCallback(() => {
    setResult(null)
    setReloadKey((key) => key + 1)
  }, [])

  useEffect(() => {
    let active = true

    provider.getHistory(instrumentId).then(
      (candles) => {
        if (!active) return
        setResult({
          instrumentId,
          status: candles.length === 0 ? 'empty' : 'ready',
          candles,
        })
      },
      () => {
        if (!active) return
        setResult({ instrumentId, status: 'error', candles: [] })
      },
    )

    return () => {
      active = false
    }
  }, [provider, instrumentId, reloadKey])

  const fresh = result?.instrumentId === instrumentId
  return {
    status: fresh ? result.status : 'loading',
    candles: fresh ? result.candles : EMPTY,
    retry,
  }
}
