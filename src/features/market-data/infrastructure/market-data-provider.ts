import type { MarketDataProvider } from '../domain/market-data.ts'
import { KrakenMarketDataProvider } from './kraken-market-data.ts'
import type { KrakenMarketDataProviderOptions } from './kraken-market-data.ts'
import { DeterministicMockMarketDataProvider } from './deterministic-mock-market-data.ts'

export type MarketDataProviderMode = 'mock' | 'kraken'

export type CreateMarketDataProviderOptions = {
  mode?: unknown
  mockSeed?: number
  krakenOptions?: KrakenMarketDataProviderOptions
}

export function resolveMarketDataProviderMode(
  value: unknown = import.meta.env.VITE_MARKET_DATA_PROVIDER,
): MarketDataProviderMode {
  if (value === undefined || value === '') return 'kraken'
  if (value === 'mock' || value === 'kraken') return value
  throw new Error(
    'VITE_MARKET_DATA_PROVIDER must be mock or kraken when provided',
  )
}

export function createMarketDataProvider(
  options: CreateMarketDataProviderOptions = {},
): MarketDataProvider {
  const mode = resolveMarketDataProviderMode(options.mode)
  if (mode === 'mock') {
    return new DeterministicMockMarketDataProvider(options.mockSeed ?? 1)
  }
  return new KrakenMarketDataProvider(options.krakenOptions)
}
