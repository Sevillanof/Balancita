export type InstrumentId = string

export type InstrumentCurrency = 'EUR' | 'USD'

export type Instrument = {
  id: InstrumentId
  symbol: string
  displayName: string
  assetClass: 'crypto' | 'equity' | 'etf' | 'unknown'
  currency: InstrumentCurrency
  exchange?: string
  providerSymbols: Record<string, string>
  providerMetadata?: Record<string, unknown>
}

export type Quote = {
  instrumentId: InstrumentId
  price: number
  change: number
  changePercent: number
  timestamp: string
  status: 'live' | 'delayed' | 'mock' | 'stale'
  /** Present only for individual trade messages; never inferred from ticker updates. */
  tradeQuantity?: number
  eventTime?: string
  receivedTime?: string
  displayTime?: string
  freshnessAgeMs?: number
  freshnessIsStale?: boolean
}

export type MarketSubscriptionStatus =
  'mock' | 'connecting' | 'connected' | 'reconnecting' | 'stale' | 'stopped'

export type Candle = {
  time: string
  open: number
  high: number
  low: number
  close: number
  volume: number
  isClosed?: boolean
}

export interface MarketDataProvider {
  getInstruments(): Promise<Instrument[]>
  getHistory(instrumentId: InstrumentId): Promise<Candle[]>
  subscribe(
    instrumentIds: InstrumentId[],
    onQuote: (quote: Quote) => void,
    onStatus?: (status: MarketSubscriptionStatus) => void,
  ): () => void
}
