import type { MarketDataProvider } from '../domain/market-data'
import { CoinbaseMarketDataProvider } from './coinbase-market-data'
import type { CoinbaseMarketDataProviderOptions } from './coinbase-market-data'
import { DeterministicMockMarketDataProvider } from './deterministic-mock-market-data'

export type MarketDataProviderMode = 'mock' | 'coinbase'

export type CreateMarketDataProviderOptions = {
  mode?: unknown
  mockSeed?: number
  coinbaseOptions?: CoinbaseMarketDataProviderOptions
}

export function resolveMarketDataProviderMode(
  value: unknown = import.meta.env.VITE_MARKET_DATA_PROVIDER,
): MarketDataProviderMode {
  if (value === undefined || value === '') return 'mock'
  if (value === 'mock' || value === 'coinbase') return value
  throw new Error(
    'VITE_MARKET_DATA_PROVIDER must be mock or coinbase when provided',
  )
}

export function createMarketDataProvider(
  options: CreateMarketDataProviderOptions = {},
): MarketDataProvider {
  const mode = resolveMarketDataProviderMode(options.mode)
  if (mode === 'mock') {
    return new DeterministicMockMarketDataProvider(options.mockSeed ?? 1)
  }
  return new CoinbaseMarketDataProvider(options.coinbaseOptions)
}
