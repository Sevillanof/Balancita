import type { InstrumentId } from '../domain/market-data'

const PAIR = {
  instrumentId: 'BTC-EUR',
  restPair: 'XBTEUR',
  webSocketSymbol: 'BTC/EUR',
} as const

export const KRAKEN_PAIR = PAIR

export function domainToKrakenRestPair(instrumentId: InstrumentId): string {
  if (instrumentId !== PAIR.instrumentId) throw unsupported(instrumentId)
  return PAIR.restPair
}

export function domainToKrakenWebSocketSymbol(
  instrumentId: InstrumentId,
): string {
  if (instrumentId !== PAIR.instrumentId) throw unsupported(instrumentId)
  return PAIR.webSocketSymbol
}

export function krakenRestPairToDomain(restPair: string): InstrumentId {
  if (restPair !== PAIR.restPair) throw unsupported(restPair)
  return PAIR.instrumentId
}

export function krakenWebSocketSymbolToDomain(symbol: string): InstrumentId {
  if (symbol !== PAIR.webSocketSymbol) throw unsupported(symbol)
  return PAIR.instrumentId
}

function unsupported(value: string): Error {
  return new Error(`Unsupported instrument for Kraken market data: ${value}`)
}
