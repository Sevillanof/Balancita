import { STRATEGIES_API_BASE } from './strategy-api.ts'

/** Funding carry counter (long spot + short perpetual); it opens no orders. */
export type CarryProduct = {
  product_id: string
  cycles: number
  open: boolean
  active_hours: number
  unknown_hours: number
  funding_usd: number
  basis_usd: number
  costs_usd: number
  net_usd: number
  net_pct_of_capital: number
  max_drawdown_usd: number
}

export type CarrySummary = {
  id: string
  name: string
  label: string
  note: string
  enabled: boolean
  start_ms: number | null
  end_ms: number | null
  updated_ms: number | null
  notional_usd_per_product: number
  totals: {
    funding_usd: number
    basis_usd: number
    costs_usd: number
    net_usd: number
    max_drawdown_usd: number
  } | null
  closed_or_open_cycles: number
  products: CarryProduct[]
}

export async function loadCarry(
  fetcher: typeof fetch = (...args) => fetch(...args),
): Promise<CarrySummary | null> {
  try {
    const response = await fetcher(`${STRATEGIES_API_BASE}/carry`)
    return response.ok ? ((await response.json()) as CarrySummary) : null
  } catch {
    return null
  }
}

export async function setCarryEnabled(
  enabled: boolean,
  fetcher: typeof fetch = (...args) => fetch(...args),
): Promise<CarrySummary | null> {
  try {
    const response = await fetcher(`${STRATEGIES_API_BASE}/carry/enabled`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled }),
    })
    return response.ok ? ((await response.json()) as CarrySummary) : null
  } catch {
    return null
  }
}
