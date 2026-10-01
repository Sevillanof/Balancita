export const HISTORICAL_INTERVALS = ['1m', '5m', '15m', '1h'] as const
export type HistoricalInterval = (typeof HISTORICAL_INTERVALS)[number]

export const HISTORICAL_STRATEGIES = [
  'Ruptura + volumen (ejemplo)',
  'Tendencia y retroceso (ejemplo)',
  'Reversión a la media (ejemplo)',
] as const
export type HistoricalStrategy = (typeof HISTORICAL_STRATEGIES)[number]

export type HistoricalRequest = {
  asset: 'BTC/EUR'
  from: string
  to: string
  interval: HistoricalInterval
  strategy: HistoricalStrategy
  capital: number
}

export type HistoricalTrade = {
  id: string
  direction: 'long' | 'short'
  sizeBtc: number
  entryEur: number
  exitEur: number
  netEur: number
  feesEur: number
}

export type HistoricalEquityPoint = { date: string; value: number }

export type HistoricalResult = {
  parameters: Readonly<HistoricalRequest>
  trades: readonly HistoricalTrade[]
  equity: readonly HistoricalEquityPoint[]
  finalCapital: number
  drawdown: number
  winRate: number
}

export interface HistoricalProvider {
  run(
    request: Readonly<HistoricalRequest>,
    signal: AbortSignal,
  ): Promise<HistoricalResult>
}
