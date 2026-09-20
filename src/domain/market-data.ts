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
}

export type Candle = {
  time: string
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface MarketDataProvider {
  getInstruments(): Promise<Instrument[]>
  getHistory(instrumentId: InstrumentId): Promise<Candle[]>
  subscribe(
    instrumentIds: InstrumentId[],
    onQuote: (quote: Quote) => void,
  ): () => void
}
