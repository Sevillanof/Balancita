import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  Instrument,
  InstrumentId,
  MarketDataProvider,
  Quote,
} from '../../market-data/domain/market-data.ts'
import type { Money } from '../../../shared/finance/money.ts'
import {
  BUY,
  type OrderExecutionProvider,
  type OrderIntent,
  type OrderPreview,
  type OrderReceipt,
  type OrderSide,
  type OrderSimulatorConfig,
} from '../domain/orders.ts'
import type { PortfolioRepository } from '../../portfolio/domain/portfolio.ts'
import {
  type CashMovement,
  type CashMovementOptions,
  LocalPaperTradingProvider,
  type PaperTradingAccount,
  type PaperTradingMarketSource,
} from '../infrastructure/local-paper-trading-provider'

export type UseTradingOptions = {
  provider?: OrderExecutionProvider
  makeIdempotencyKey?: () => string
  portfolioRepository?: PortfolioRepository
  initialInstrumentId?: InstrumentId
  initialSide?: OrderSide
  simulatorOptions?: Partial<OrderSimulatorConfig> & { now?: () => number }
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
  private readonly quotes = new Map<string, Quote>()

  ingestInstruments(loaded: readonly Instrument[]): void {
    for (const instrument of loaded) {
      this.instruments.set(instrument.id, instrument)
    }
  }

  ingestQuote(quote: Quote): void {
    this.prices.set(quote.instrumentId, quote.price)
    this.quotes.set(quote.instrumentId, quote)
  }

  async getInstrument(instrumentId: string): Promise<Instrument | null> {
    return this.instruments.get(instrumentId) ?? null
  }

  async getPrice(instrumentId: string): Promise<Quote | null> {
    return this.quotes.get(instrumentId) ?? null
  }
}

export function useTrading(
  marketData: MarketDataProvider,
  options: UseTradingOptions = {},
) {
  const [instruments, setInstruments] = useState<Instrument[]>([])
  const [selectedInstrumentId, setSelectedInstrumentId] =
    useState<InstrumentId | null>(null)
  const [side, setSide] = useState<OrderSide>(options.initialSide ?? BUY)
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
    () =>
      options.provider ??
      new LocalPaperTradingProvider(
        source,
        options.portfolioRepository,
        options.simulatorOptions,
      ),
    [
      options.provider,
      options.portfolioRepository,
      options.simulatorOptions,
      source,
    ],
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
    let release: (() => void) | undefined
    void marketData
      .getInstruments()
      .then(async (loaded) => {
        if (!active) return
        source.ingestInstruments(loaded)
        setInstruments(loaded)
        if (loaded.length > 0) {
          setSelectedInstrumentId((current) =>
            current === null
              ? (loaded.find(
                  (instrument) => instrument.id === options.initialInstrumentId,
                )?.id ?? loaded[0]!.id)
              : current,
          )
        }
        release = marketData.subscribe(
          loaded.map((instrument) => instrument.id),
          (quote) => {
            if (!active) return
            source.ingestQuote(quote)
            setPrices((current) => {
              const next = new Map(current)
              next.set(quote.instrumentId, quote.price)
              return next
            })
          },
        )
        await refreshAccount()
      })
      .catch(() => {
        if (active) setInstruments([])
      })
    return () => {
      active = false
      release?.()
    }
  }, [marketData, source, refreshAccount, options.initialInstrumentId])

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

  const confirmOrder = useCallback(async (): Promise<boolean> => {
    if (preview === null || pendingKeyRef.current === null) return false
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
      return true
    } catch (error) {
      setSubmitError(errorMessage(error))
      return false
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

  const refreshCash = useCallback(async (): Promise<void> => {
    await refreshAccount()
  }, [refreshAccount])

  const cashMovement = useCallback(
    async (
      type: 'deposit' | 'withdrawal',
      currency: string,
      amount: Money,
      movementOptions?: CashMovementOptions,
    ): Promise<CashMovement | null> => {
      const ledger = provider as unknown as {
        deposit?: (
          currency: string,
          amount: Money,
          options?: CashMovementOptions,
        ) => Promise<CashMovement>
        withdraw?: (
          currency: string,
          amount: Money,
          options?: CashMovementOptions,
        ) => Promise<CashMovement>
      }
      const operation = type === 'deposit' ? ledger.deposit : ledger.withdraw
      if (operation === undefined) return null
      const movement = await operation.call(
        ledger,
        currency,
        amount,
        movementOptions,
      )
      await refreshAccount()
      return movement
    },
    [provider, refreshAccount],
  )

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
    refreshAccount: refreshCash,
    deposit: (currency: string, amount: Money, options?: CashMovementOptions) =>
      cashMovement('deposit', currency, amount, options),
    withdraw: (
      currency: string,
      amount: Money,
      options?: CashMovementOptions,
    ) => cashMovement('withdrawal', currency, amount, options),
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return 'Ocurrió un problema inesperado.'
}
