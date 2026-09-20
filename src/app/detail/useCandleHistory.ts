import { useCallback, useEffect, useState } from 'react'
import type {
  Candle,
  InstrumentId,
  MarketDataProvider,
} from '../../domain/market-data'

export type CandleHistoryStatus = 'loading' | 'ready' | 'empty' | 'error'

export type CandleHistoryState = {
  status: CandleHistoryStatus
  candles: readonly Candle[]
}

const INITIAL_STATE: CandleHistoryState = {
  status: 'loading',
  candles: [],
}

export type UseCandleHistoryResult = CandleHistoryState & {
  retry: () => void
}

export function useCandleHistory(
  provider: MarketDataProvider,
  instrumentId: InstrumentId,
): UseCandleHistoryResult {
  const [reloadKey, setReloadKey] = useState(0)
  const [state, setState] = useState<CandleHistoryState>(INITIAL_STATE)

  const retry = useCallback(() => {
    setState(INITIAL_STATE)
    setReloadKey((key) => key + 1)
  }, [])

  useEffect(() => {
    let active = true
    setState(INITIAL_STATE)

    provider.getHistory(instrumentId).then(
      (candles) => {
        if (!active) return
        if (candles.length === 0) {
          setState({ status: 'empty', candles: [] })
          return
        }
        setState({ status: 'ready', candles })
      },
      () => {
        if (!active) return
        setState({ status: 'error', candles: [] })
      },
    )

    return () => {
      active = false
    }
  }, [provider, instrumentId, reloadKey])

  return { ...state, retry }
}
