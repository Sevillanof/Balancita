import { describe, expect, it } from 'vitest'
import {
  KRAKEN_PAIR,
  domainToKrakenRestPair,
  domainToKrakenWebSocketSymbol,
  krakenRestPairToDomain,
  krakenWebSocketSymbolToDomain,
} from './kraken-pairs.ts'

describe('Kraken pair mapping', () => {
  it('defines the single supported pair across all three identifier forms', () => {
    expect(KRAKEN_PAIR).toEqual({
      instrumentId: 'BTC-EUR',
      restPair: 'XBTEUR',
      webSocketSymbol: 'BTC/EUR',
    })
  })

  it('maps the domain instrument BTC-EUR to the Kraken REST pair XBTEUR', () => {
    expect(domainToKrakenRestPair('BTC-EUR')).toBe('XBTEUR')
  })

  it('maps the domain instrument BTC-EUR to the Kraken WebSocket v2 symbol BTC/EUR', () => {
    expect(domainToKrakenWebSocketSymbol('BTC-EUR')).toBe('BTC/EUR')
  })

  it('round-trips the Kraken REST pair XBTEUR back to the domain instrument', () => {
    expect(krakenRestPairToDomain('XBTEUR')).toBe('BTC-EUR')
  })

  it('round-trips the Kraken WebSocket v2 symbol BTC/EUR back to the domain instrument', () => {
    expect(krakenWebSocketSymbolToDomain('BTC/EUR')).toBe('BTC-EUR')
  })

  it('rejects unsupported domain instruments with an informative error', () => {
    expect(() => domainToKrakenRestPair('ETH-EUR')).toThrow(
      /Unsupported instrument for Kraken market data: ETH-EUR/i,
    )
    expect(() => domainToKrakenWebSocketSymbol('TTWO')).toThrow(
      /Unsupported instrument for Kraken market data: TTWO/i,
    )
  })

  it('rejects unknown Kraken REST pair names', () => {
    expect(() => krakenRestPairToDomain('XETHZEUR')).toThrow(
      /Unsupported instrument for Kraken market data: XETHZEUR/i,
    )
  })

  it('rejects unknown Kraken WebSocket v2 symbols', () => {
    expect(() => krakenWebSocketSymbolToDomain('ETH/EUR')).toThrow(
      /Unsupported instrument for Kraken market data: ETH\/EUR/i,
    )
  })
})
