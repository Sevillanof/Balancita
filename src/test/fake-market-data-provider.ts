import type {
  Candle,
  Instrument,
  InstrumentId,
  MarketDataProvider,
  Quote,
} from '../domain/market-data'

export const BTC_EUR: Instrument = {
  id: 'BTC-EUR',
  symbol: 'BTC-EUR',
  displayName: 'Bitcoin / Euro',
  assetClass: 'crypto',
  currency: 'EUR',
  exchange: 'Mock',
  providerSymbols: { mock: 'BTC-EUR' },
}

export const TTWO: Instrument = {
  id: 'TTWO',
  symbol: 'TTWO',
  displayName: 'Take-Two Interactive',
  assetClass: 'equity',
  currency: 'USD',
  exchange: 'NASDAQ',
  providerSymbols: { mock: 'TTWO' },
}

export const SPCX: Instrument = {
  id: 'SPCX',
  symbol: 'SPCX',
  displayName: 'SPCX',
  assetClass: 'unknown',
  currency: 'USD',
  providerSymbols: { mock: 'SPCX' },
}

export const WATCHLIST_INSTRUMENTS: readonly Instrument[] = [
  BTC_EUR,
  TTWO,
  SPCX,
]

type FakeProviderOptions = {
  getInstrumentsError?: Error
  historyByInstrument?: Readonly<Record<InstrumentId, readonly Candle[]>>
  getHistoryError?: Error
}

export class FakeMarketDataProvider implements MarketDataProvider {
  instruments: readonly Instrument[]
  getInstrumentsError?: Error
  getHistoryError?: Error
  getInstrumentsCalls = 0
  subscribeCalls: InstrumentId[][] = []
  unsubscribeCalls = 0
  getHistoryCalls: InstrumentId[] = []

  private readonly listeners = new Set<(quote: Quote) => void>()
  private readonly historyByInstrument: Readonly<
    Record<InstrumentId, readonly Candle[]>
  >

  constructor(
    instruments: readonly Instrument[],
    options: FakeProviderOptions = {},
  ) {
    this.instruments = instruments
    this.getInstrumentsError = options.getInstrumentsError
    this.getHistoryError = options.getHistoryError
    this.historyByInstrument = options.historyByInstrument ?? {}
  }

  async getInstruments(): Promise<Instrument[]> {
    this.getInstrumentsCalls += 1
    if (this.getInstrumentsError) {
      throw this.getInstrumentsError
    }
    return this.instruments.map((instrument) => ({ ...instrument }))
  }

  async getHistory(instrumentId: InstrumentId): Promise<Candle[]> {
    this.getHistoryCalls.push(instrumentId)
    if (this.getHistoryError) {
      throw this.getHistoryError
    }
    const candles = this.historyByInstrument[instrumentId] ?? []
    return candles.map((candle) => ({ ...candle }))
  }

  subscribe(
    instrumentIds: InstrumentId[],
    onQuote: (quote: Quote) => void,
  ): () => void {
    this.subscribeCalls.push([...instrumentIds])
    this.listeners.add(onQuote)
    return () => {
      if (this.listeners.delete(onQuote)) {
        this.unsubscribeCalls += 1
      }
    }
  }

  emit(quote: Quote): void {
    for (const listener of [...this.listeners]) {
      listener(quote)
    }
  }

  get listenerCount(): number {
    return this.listeners.size
  }
}

export function makeQuote(overrides: Partial<Quote> = {}): Quote {
  return {
    instrumentId: overrides.instrumentId ?? 'BTC-EUR',
    price: overrides.price ?? 60_000,
    change: overrides.change ?? 0,
    changePercent: overrides.changePercent ?? 0,
    timestamp: overrides.timestamp ?? '2026-09-20T12:00:00.000Z',
    status: overrides.status ?? 'mock',
  }
}

export function makeCandle(overrides: Partial<Candle> = {}): Candle {
  return {
    time: overrides.time ?? '2024-01-01T00:00:00.000Z',
    open: overrides.open ?? 100,
    high: overrides.high ?? 105,
    low: overrides.low ?? 99,
    close: overrides.close ?? 104,
    volume: overrides.volume ?? 1000,
  }
}
