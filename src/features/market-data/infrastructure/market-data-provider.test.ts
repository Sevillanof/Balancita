import { describe, expect, it, vi } from 'vitest'
import type { KrakenWebSocket } from './kraken-market-data.ts'
import {
  createMarketDataProvider,
  resolveMarketDataProviderMode,
} from './market-data-provider.ts'
import { DeterministicMockMarketDataProvider } from './deterministic-mock-market-data.ts'
import { KrakenMarketDataProvider } from './kraken-market-data.ts'

const assetPairs = {
  error: [],
  result: {
    XBTEUR: {
      altname: 'XBTEUR',
      wsname: 'BTC/EUR',
      aclass_base: 'currency',
      base: 'XXBT',
      aclass_quote: 'currency',
      quote: 'ZEUR',
      status: 'online',
    },
  },
}

function response(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response
}

function webSocketFactory(): KrakenWebSocket {
  return {
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    send: vi.fn(),
    close: vi.fn(),
  }
}

describe('market data provider selection', () => {
  it('defaults to mock when the environment setting is absent', async () => {
    expect(resolveMarketDataProviderMode(undefined)).toBe('mock')
    const provider = createMarketDataProvider({ mode: undefined })

    expect(provider).toBeInstanceOf(DeterministicMockMarketDataProvider)
    await expect(provider.getInstruments()).resolves.toHaveLength(3)
  })

  it('accepts explicit mock mode without creating a network provider', () => {
    const provider = createMarketDataProvider({ mode: 'mock', mockSeed: 42 })

    expect(provider).toBeInstanceOf(DeterministicMockMarketDataProvider)
    expect('fetcher' in provider).toBe(false)
  })

  it('creates Kraken mode only when explicitly selected and keeps its catalog BTC-EUR only', async () => {
    const fetch = vi.fn(async () => response(assetPairs))
    const provider = createMarketDataProvider({
      mode: 'kraken',
      krakenOptions: { fetch, webSocketFactory },
    })

    expect(resolveMarketDataProviderMode('kraken')).toBe('kraken')
    expect(provider).toBeInstanceOf(KrakenMarketDataProvider)
    await expect(provider.getInstruments()).resolves.toEqual([
      expect.objectContaining({ id: 'BTC-EUR', currency: 'EUR' }),
    ])
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('rejects unsupported configuration instead of silently falling back', () => {
    expect(() => resolveMarketDataProviderMode('live')).toThrow(
      /VITE_MARKET_DATA_PROVIDER must be mock or kraken/i,
    )
    expect(() => createMarketDataProvider({ mode: 'real' })).toThrow(
      /VITE_MARKET_DATA_PROVIDER must be mock or kraken/i,
    )
    expect(() => createMarketDataProvider({ mode: 'coinbase' })).toThrow(
      /VITE_MARKET_DATA_PROVIDER must be mock or kraken/i,
    )
  })
})
