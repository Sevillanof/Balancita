export const KRAKEN_PRO_SPOT_TIER1_TAKER_FEE_SCENARIO = {
  version: 'kraken-pro-spot-btc-eur-tier1-taker.v1',
  venue: 'Kraken Pro Spot',
  pair: 'BTC-EUR',
  tier: 'Tier 1 (0+ USD qualifying 30-day volume)',
  role: 'taker',
  sourceUrl: 'https://www.kraken.com/features/fee-schedule',
  verifiedAt: '2026-09-26',
  commissionRate: 0.008,
  slippageRate: 0.0005,
  accountTier: 'unknown',
  classification: 'model-scenario-not-account-fee',
} as const

export const SIMULATED_COSTS_CAVEAT =
  'Applies to new runs and future paper orders only; historical recorded fees and results are unchanged.' as const
