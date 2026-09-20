import { useCallback, useEffect, useState } from 'react'
import type {
  Instrument,
  InstrumentId,
  MarketDataProvider,
  Quote,
} from '../../domain/market-data'
import {
  PortfolioCorruptError,
  type Holding,
  type PortfolioRepository,
} from '../../domain/portfolio'

export type PortfolioStatus = 'loading' | 'ready' | 'empty' | 'error'
export type PortfolioLoadError = 'corrupt' | 'general'

export type UsePortfolioResult = {
  status: PortfolioStatus
  holdings: readonly Holding[]
  quotes: ReadonlyMap<InstrumentId, Quote>
  instruments: ReadonlyMap<InstrumentId, Instrument>
  loadError: PortfolioLoadError | null
  operationError: string | null
  retry: () => void
  reset: () => void
  add: (holding: Holding) => Promise<boolean>
  remove: (instrumentId: InstrumentId) => Promise<boolean>
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function pruneQuotes(
  quotes: ReadonlyMap<InstrumentId, Quote>,
  heldIds: ReadonlySet<InstrumentId>,
): ReadonlyMap<InstrumentId, Quote> {
  const next = new Map<InstrumentId, Quote>()
  for (const [id, quote] of quotes) {
    if (heldIds.has(id)) next.set(id, quote)
  }
  return next
}

/**
 * Application-layer portfolio source. State is the single source for the UI:
 * holdings come from the repository, quotes from the live feed, and totals are
 * derived on render — never persisted or duplicated.
 */
export function usePortfolio(
  provider: MarketDataProvider,
  repository: PortfolioRepository,
): UsePortfolioResult {
  const [reloadKey, setReloadKey] = useState(0)
  const [status, setStatus] = useState<PortfolioStatus>('loading')
  const [holdings, setHoldings] = useState<readonly Holding[]>([])
  const [quotes, setQuotes] = useState<ReadonlyMap<InstrumentId, Quote>>(
    new Map(),
  )
  const [instruments, setInstruments] = useState<
    ReadonlyMap<InstrumentId, Instrument>
  >(new Map())
  const [loadError, setLoadError] = useState<PortfolioLoadError | null>(null)
  const [operationError, setOperationError] = useState<string | null>(null)

  const reload = useCallback(() => {
    setStatus('loading')
    setHoldings([])
    setQuotes(new Map())
    setLoadError(null)
    setOperationError(null)
    setReloadKey((key) => key + 1)
  }, [])

  useEffect(() => {
    let active = true

    Promise.all([repository.list(), provider.getInstruments()]).then(
      ([storedHoldings, catalog]) => {
        if (!active) return
        const byId = new Map(
          catalog.map((instrument) => [instrument.id, instrument]),
        )
        setInstruments(byId)
        setLoadError(null)
        if (storedHoldings.length === 0) {
          setHoldings([])
          setQuotes(new Map())
          setStatus('empty')
        } else {
          setHoldings(storedHoldings)
          setStatus('ready')
        }
      },
      (cause) => {
        if (!active) return
        setHoldings([])
        setQuotes(new Map())
        setInstruments(new Map())
        setLoadError(
          cause instanceof PortfolioCorruptError ? 'corrupt' : 'general',
        )
        setStatus('error')
      },
    )

    return () => {
      active = false
    }
  }, [provider, repository, reloadKey])

  useEffect(() => {
    if (status !== 'ready') return

    const subscribedIds = holdings
      .map((holding) => holding.instrumentId)
      .filter((id) => instruments.has(id))

    if (subscribedIds.length === 0) return

    let release: (() => void) | undefined
    try {
      release = provider.subscribe(subscribedIds, (quote: Quote) => {
        if (!subscribedIds.includes(quote.instrumentId)) return
        setQuotes((previous) => {
          const next = new Map(previous)
          next.set(quote.instrumentId, quote)
          return next
        })
      })
    } catch {
      return
    }

    return () => {
      release?.()
      const held = new Set(holdings.map((holding) => holding.instrumentId))
      setQuotes((previous) => pruneQuotes(previous, held))
    }
  }, [provider, status, holdings, instruments])

  const syncFromRepository = useCallback(async (): Promise<void> => {
    try {
      const storedHoldings = await repository.list()
      const heldIdsForPrune = new Set(
        storedHoldings.map((holding) => holding.instrumentId),
      )
      setHoldings(storedHoldings)
      setQuotes((previous) => pruneQuotes(previous, heldIdsForPrune))
      setStatus(storedHoldings.length === 0 ? 'empty' : 'ready')
      setLoadError(null)
      setOperationError(null)
    } catch (cause) {
      setLoadError(
        cause instanceof PortfolioCorruptError ? 'corrupt' : 'general',
      )
      setStatus('error')
    }
  }, [repository])

  const add = useCallback(
    async (holding: Holding): Promise<boolean> => {
      try {
        await repository.add(holding)
      } catch (cause) {
        setOperationError(messageOf(cause))
        return false
      }
      await syncFromRepository()
      return true
    },
    [repository, syncFromRepository],
  )

  const remove = useCallback(
    async (instrumentId: InstrumentId): Promise<boolean> => {
      try {
        await repository.remove(instrumentId)
      } catch (cause) {
        setOperationError(messageOf(cause))
        return false
      }
      await syncFromRepository()
      return true
    },
    [repository, syncFromRepository],
  )

  const reset = useCallback(async () => {
    try {
      await repository.clear()
    } catch (cause) {
      setOperationError(messageOf(cause))
      return
    }
    await syncFromRepository()
  }, [repository, syncFromRepository])

  return {
    status,
    holdings,
    quotes,
    instruments,
    loadError,
    operationError,
    retry: reload,
    reset,
    add,
    remove,
  }
}
