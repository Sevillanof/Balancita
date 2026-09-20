import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  Instrument,
  InstrumentId,
  MarketDataProvider,
  Quote,
} from '../../domain/market-data'
import type { Money } from '../../domain/money'
import {
  BUY,
  type OrderExecutionProvider,
  type OrderIntent,
  type OrderPreview,
  type OrderReceipt,
  type OrderSide,
} from '../../domain/orders'
import {
  LocalPaperTradingProvider,
  type PaperTradingAccount,
  type PaperTradingMarketSource,
} from '../../orders/local-paper-trading-provider'

export type UseTradingOptions = {
  provider?: OrderExecutionProvider
  makeIdempotencyKey?: () => string
}

function defaultIdempotencyKey(): string {
  return `lpt-${crypto.randomUUID()}`
}

/**
 * Live market surface for the paper trading provider. Data is pushed in from
 * the subscription callbacks, so the source itself needs no React state.
 */
class LiveTradeMarketSource implements PaperTradingMarketSource {
  private readonly instruments = new Map<string, Instrument>()
  private readonly prices = new Map<string, number>()

  ingestInstruments(loaded: readonly Instrument[]): void {
    for (const instrument of loaded) {
      this.instruments.set(instrument.id, instrument)
    }
  }

  ingestQuote(quote: Quote): void {
    this.prices.set(quote.instrumentId, quote.price)
  }

  async getInstrument(instrumentId: string): Promise<Instrument | null> {
    return this.instruments.get(instrumentId) ?? null
  }

  async getPrice(instrumentId: string): Promise<Quote | null> {
    const price = this.prices.get(instrumentId)
    if (price === undefined) return null
    return {
      instrumentId,
      price,
      change: 0,
      changePercent: 0,
      timestamp: new Date().toISOString(),
      status: 'live',
    }
  }
}

export function useTrading(
  marketData: MarketDataProvider,
  options: UseTradingOptions = {},
) {
  const [instruments, setInstruments] = useState<Instrument[]>([])
  const [selectedInstrumentId, setSelectedInstrumentId] =
    useState<InstrumentId | null>(null)
  const [side, setSide] = useState<OrderSide>(BUY)
  const [preview, setPreview] = useState<OrderPreview | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [receipt, setReceipt] = useState<OrderReceipt | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [account, setAccount] = useState<PaperTradingAccount | null>(null)
  const [prices, setPrices] = useState<ReadonlyMap<InstrumentId, number>>(
    () => new Map(),
  )

  const pendingKeyRef = useRef<string | null>(null)
  const makeIdempotencyKey = options.makeIdempotencyKey ?? defaultIdempotencyKey

  const source = useMemo(() => new LiveTradeMarketSource(), [])
  const provider = useMemo<OrderExecutionProvider>(
    () => options.provider ?? new LocalPaperTradingProvider(source),
    [options.provider, source],
  )

  const refreshAccount = useCallback(async (): Promise<void> => {
    const localProvider = provider as unknown as {
      account?: () => Promise<PaperTradingAccount>
    }
    if (typeof localProvider.account !== 'function') return
    setAccount(await localProvider.account())
  }, [provider])

  useEffect(() => {
    let active = true
    void marketData
      .getInstruments()
      .then(async (loaded) => {
        if (!active) return
        source.ingestInstruments(loaded)
        setInstruments(loaded)
        if (loaded.length > 0) {
          setSelectedInstrumentId((current) =>
            current === null ? loaded[0]!.id : current,
          )
        }
        await refreshAccount()
      })
      .catch(() => {
        if (!active) setInstruments([])
      })
    return () => {
      active = false
    }
  }, [marketData, source, refreshAccount])

  useEffect(() => {
    if (instruments.length === 0) return
    const unsubscribe = marketData.subscribe(
      instruments.map((instrument) => instrument.id),
      (quote) => {
        source.ingestQuote(quote)
        setPrices((current) => {
          const next = new Map(current)
          next.set(quote.instrumentId, quote.price)
          return next
        })
      },
    )
    return unsubscribe
  }, [marketData, instruments, source])

  const priceOf = useCallback(
    (instrumentId: InstrumentId): number | null => {
      return prices.get(instrumentId) ?? null
    },
    [prices],
  )

  const requestPreview = useCallback(
    async (quantity: Money): Promise<void> => {
      const instrumentId = selectedInstrumentId
      if (instrumentId === null) return
      pendingKeyRef.current = makeIdempotencyKey()
      setPreviewing(true)
      setPreviewError(null)
      setPreview(null)
      setReceipt(null)
      setSubmitError(null)
      try {
        const intent: OrderIntent = {
          instrumentId,
          side,
          quantity,
          idempotencyKey: pendingKeyRef.current,
        }
        setPreview(await provider.preview(intent))
      } catch (error) {
        pendingKeyRef.current = null
        setPreviewError(errorMessage(error))
      } finally {
        setPreviewing(false)
      }
    },
    [selectedInstrumentId, side, provider, makeIdempotencyKey],
  )

  const confirmOrder = useCallback(async (): Promise<void> => {
    if (preview === null || pendingKeyRef.current === null) return
    setConfirming(true)
    setSubmitError(null)
    try {
      setReceipt(
        await provider.submit({
          previewReference: preview.reference,
          idempotencyKey: pendingKeyRef.current,
        }),
      )
      pendingKeyRef.current = null
      await refreshAccount()
    } catch (error) {
      setSubmitError(errorMessage(error))
    } finally {
      setConfirming(false)
    }
  }, [preview, provider, refreshAccount])

  const resetTrade = useCallback(() => {
    pendingKeyRef.current = null
    setPreview(null)
    setPreviewError(null)
    setReceipt(null)
    setSubmitError(null)
  }, [])

  const selectedInstrument =
    selectedInstrumentId === null
      ? undefined
      : instruments.find((instrument) => instrument.id === selectedInstrumentId)

  return {
    instruments,
    selectedInstrumentId,
    selectedInstrument,
    selectInstrument: setSelectedInstrumentId,
    side,
    setSide,
    priceOf,
    prices,
    account,
    preview,
    previewError,
    previewing,
    requestPreview,
    confirming,
    confirmOrder,
    submitError,
    receipt,
    resetTrade,
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return 'Something unexpected happened.'
}
