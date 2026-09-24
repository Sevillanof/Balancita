import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  Instrument,
  InstrumentId,
  MarketDataProvider,
  Quote,
} from '../../market-data/domain/market-data.ts'
import type { Money } from '../../../shared/finance/money.ts'
import {
  moneyFromNumber,
  moneyIsPositive,
} from '../../../shared/finance/money.ts'
import {
  BUY,
  type OrderExecutionProvider,
  type OrderIntent,
  type OrderPreview,
  type OrderReceipt,
  type OrderSide,
  type OrderSimulatorConfig,
  type FeePolicy,
  SELL,
} from '../domain/orders.ts'
import type { PortfolioRepository } from '../../portfolio/domain/portfolio.ts'
import {
  type CashMovement,
  type CashMovementOptions,
  LocalPaperTradingProvider,
  type PaperTradingAccount,
  type PaperTradingMarketSource,
} from '../infrastructure/local-paper-trading-provider'
import {
  calculateMomentumIndicators,
  evaluateMomentumSignal,
  largestAffordableQuantity,
  MOMENTUM_CANDLE_MS,
  MOMENTUM_STRATEGY_VERSION,
} from '../domain/ema-macd-momentum'
import type { Candle } from '../../market-data/domain/market-data.ts'

export type UseTradingOptions = {
  provider?: OrderExecutionProvider
  makeIdempotencyKey?: () => string
  portfolioRepository?: PortfolioRepository
  initialInstrumentId?: InstrumentId
  initialSide?: OrderSide
  simulatorOptions?: Partial<OrderSimulatorConfig> & { now?: () => number }
  strategySeed?: readonly Candle[]
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
  const [autoTradingEnabled, setAutoTradingEnabled] = useState(false)
  const [strategyMetrics, setStrategyMetrics] = useState<
    ReturnType<typeof calculateMomentumIndicators>
  >(() => calculateMomentumIndicators(options.strategySeed ?? []))
  const strategyReady = strategyMetrics.ready

  const pendingKeyRef = useRef<string | null>(null)
  const closedCandlesRef = useRef<Candle[]>([...(options.strategySeed ?? [])])
  const liveCandleRef = useRef<Candle | null>(null)
  const liveCandleStrategyEligibleRef = useRef(false)
  const lastEventTimeRef = useRef<number | null>(null)
  const executedSignalsRef = useRef(new Set<string>())
  const executionInFlightRef = useRef(false)
  const autoEnabledRef = useRef(false)
  const liveMarketRef = useRef(false)
  const optionsRef = useRef(options)
  useEffect(() => {
    optionsRef.current = options
  }, [options])
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

  const runStrategy = useCallback(
    async (candle: Candle): Promise<void> => {
      const closed = [...closedCandlesRef.current, candle]
      const previous = calculateMomentumIndicators(closedCandlesRef.current)
      closedCandlesRef.current = closed
      const current = calculateMomentumIndicators(closed)
      const metrics = { ...current, previous }
      setStrategyMetrics(metrics)
      if (
        !autoEnabledRef.current ||
        !liveMarketRef.current ||
        !current.ready ||
        executionInFlightRef.current
      )
        return
      const local =
        provider instanceof LocalPaperTradingProvider ? provider : null
      if (local === null) return
      executionInFlightRef.current = true
      try {
        const holdings =
          (await optionsRef.current.portfolioRepository?.list()) ?? []
        const holding = holdings.find((item) => item.instrumentId === 'BTC-EUR')
        const exposure = holding === undefined ? 'flat' : 'long'
        const signal = evaluateMomentumSignal(closed, metrics, exposure)
        if (signal === null) return
        const timestamp = Date.parse(candle.time) + MOMENTUM_CANDLE_MS
        const key = `${MOMENTUM_STRATEGY_VERSION}:${timestamp}:${signal}`
        if (executedSignalsRef.current.has(key)) return
        executedSignalsRef.current.add(key)
        console.info('[paper-momentum]', {
          side: signal,
          candleClose: new Date(timestamp).toISOString(),
          price: candle.close,
          ema8: current.ema8,
          ema21: current.ema21,
          macd: current.macd?.line,
          macdSignal: current.macd?.signal,
          histogram: current.macd?.histogram,
          volume: candle.volume,
          reason:
            signal === 'buy'
              ? 'EMA/MACD/volume entry'
              : 'bearish EMA or MACD cross',
        })
        const account = await local.account()
        const executionQuote = await source.getPrice('BTC-EUR')
        const quantity =
          signal === 'sell' && holding !== undefined
            ? holding.quantity
            : (() => {
                const cash = account.cash.EUR ?? moneyFromNumber(0)
                const price = moneyFromNumber(
                  executionQuote?.price ?? candle.close,
                )
                const policy: FeePolicy = optionsRef.current.simulatorOptions
                  ?.feePolicy ?? {
                  id: 'simulated-btc-eur-0.075-percent',
                  percentage: moneyFromNumber(0.00075),
                  minimum: moneyFromNumber(0),
                  currency: 'EUR',
                  label: 'Comisión simulada (estimación)',
                }
                return largestAffordableQuantity(cash, price, policy.percentage)
              })()
        if (!moneyIsPositive(quantity)) return
        const idempotencyKey = key
        const preview = await local.preview({
          instrumentId: 'BTC-EUR',
          side: signal === 'buy' ? BUY : SELL,
          quantity,
          idempotencyKey,
        })
        if (!autoEnabledRef.current) return
        const receipt = await local.submit({
          previewReference: preview.reference,
          idempotencyKey,
        })
        if (receipt.status === 'executed') {
          await refreshAccount()
        }
      } catch {
        // Keep the closed-candle identity consumed and avoid quote-by-quote retries.
      } finally {
        executionInFlightRef.current = false
      }
    },
    [provider, refreshAccount, source],
  )

  const setAutoTrading = useCallback(
    (enabled: boolean) => {
      const available =
        provider instanceof LocalPaperTradingProvider &&
        liveMarketRef.current &&
        strategyReady
      const value = enabled && available
      autoEnabledRef.current = value
      setAutoTradingEnabled(value)
    },
    [provider, strategyReady],
  )

  useEffect(() => {
    let active = true
    let release: (() => void) | undefined
    liveCandleRef.current = null
    liveCandleStrategyEligibleRef.current = false
    lastEventTimeRef.current = null
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
            if (quote.instrumentId === 'BTC-EUR') {
              if (
                closedCandlesRef.current.length === 0 &&
                (optionsRef.current.strategySeed?.length ?? 0) > 0
              ) {
                closedCandlesRef.current = [...optionsRef.current.strategySeed!]
                const seeded = calculateMomentumIndicators(
                  closedCandlesRef.current,
                )
                setStrategyMetrics(seeded)
              }
              liveMarketRef.current = quote.status === 'live'
              if (!liveMarketRef.current) {
                autoEnabledRef.current = false
                setAutoTradingEnabled(false)
              }
              const eventTime = Date.parse(quote.eventTime ?? quote.timestamp)
              const bucket =
                Math.floor(eventTime / MOMENTUM_CANDLE_MS) * MOMENTUM_CANDLE_MS
              if (
                Number.isFinite(eventTime) &&
                (lastEventTimeRef.current === null ||
                  eventTime >= lastEventTimeRef.current)
              ) {
                lastEventTimeRef.current = eventTime
                const current = liveCandleRef.current
                if (current !== null && bucket > Date.parse(current.time)) {
                  if (liveCandleStrategyEligibleRef.current) {
                    void runStrategy({ ...current, isClosed: true })
                  }
                  liveCandleRef.current = null
                  liveCandleStrategyEligibleRef.current = true
                }
                if (current === null || bucket > Date.parse(current.time)) {
                  liveCandleRef.current = {
                    time: new Date(bucket).toISOString(),
                    open: quote.price,
                    high: quote.price,
                    low: quote.price,
                    close: quote.price,
                    volume: quote.tradeQuantity ?? 0,
                    isClosed: false,
                  }
                } else if (bucket === Date.parse(current.time)) {
                  liveCandleRef.current = {
                    ...current,
                    high: Math.max(current.high, quote.price),
                    low: Math.min(current.low, quote.price),
                    close: quote.price,
                    volume: current.volume + (quote.tradeQuantity ?? 0),
                  }
                }
              }
            }
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
  }, [
    marketData,
    source,
    refreshAccount,
    options.initialInstrumentId,
    runStrategy,
  ])

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
    autoTradingEnabled,
    setAutoTrading,
    strategyReady,
    strategyMetrics,
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
