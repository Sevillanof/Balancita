import { describe, expect, it, vi } from 'vitest'
import type { CoinbaseWebSocket } from './coinbase-market-data'
import {
  createMarketDataProvider,
  resolveMarketDataProviderMode,
} from './market-data-provider'
import { DeterministicMockMarketDataProvider } from './deterministic-mock-market-data'
import { CoinbaseMarketDataProvider } from './coinbase-market-data'

const product = {
  id: 'BTC-EUR',
  base_currency: 'BTC',
  quote_currency: 'EUR',
  display_name: 'BTC-EUR',
}

function response(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response
}

function webSocketFactory(): CoinbaseWebSocket {
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

  it('creates Coinbase mode only when explicitly selected and keeps its catalog BTC-EUR only', async () => {
    const fetch = vi.fn(async () => response(product))
    const provider = createMarketDataProvider({
      mode: 'coinbase',
      coinbaseOptions: { fetch, webSocketFactory },
    })

    expect(resolveMarketDataProviderMode('coinbase')).toBe('coinbase')
    expect(provider).toBeInstanceOf(CoinbaseMarketDataProvider)
    await expect(provider.getInstruments()).resolves.toEqual([
      expect.objectContaining({ id: 'BTC-EUR', currency: 'EUR' }),
    ])
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('rejects unsupported configuration instead of silently falling back', () => {
    expect(() => resolveMarketDataProviderMode('live')).toThrow(
      /VITE_MARKET_DATA_PROVIDER must be mock or coinbase/i,
    )
    expect(() => createMarketDataProvider({ mode: 'real' })).toThrow(
      /VITE_MARKET_DATA_PROVIDER must be mock or coinbase/i,
    )
  })
})
