import type {
  HistoricalEquityPoint,
  HistoricalProvider,
  HistoricalRequest,
  HistoricalResult,
  HistoricalTrade,
} from './types.ts'
import { validateHistoricalRequest } from './validation.ts'

const BASE_PRICE_EUR = 60_000
const COMMISSION_RATE = 0.0004
const INTERVAL_DAYS: Record<HistoricalRequest['interval'], number> = {
  '1m': 1,
  '5m': 2,
  '15m': 3,
  '1h': 5,
}

export function runHistoricalExample(
  submitted: Readonly<HistoricalRequest>,
): HistoricalResult {
  const parameters = Object.freeze({ ...submitted })
  const days =
    Math.floor(
      (Date.parse(`${parameters.to}T00:00:00.000Z`) -
        Date.parse(`${parameters.from}T00:00:00.000Z`)) /
        86_400_000,
    ) + 1
  const strategySeed = hash(parameters.strategy)
  const intervalDays = INTERVAL_DAYS[parameters.interval]
  const count = Math.max(1, Math.min(24, Math.ceil(days / intervalDays)))
  const trades: HistoricalTrade[] = []
  const equity: HistoricalEquityPoint[] = [
    { date: parameters.from, value: parameters.capital },
  ]
  let capital = parameters.capital

  for (let index = 0; index < count; index += 1) {
    const seed = hash(
      `${parameters.asset}|${parameters.from}|${parameters.to}|${parameters.interval}|${parameters.strategy}|${index}`,
    )
    const entry = BASE_PRICE_EUR * (0.96 + (seed % 8000) / 100000)
    const direction: HistoricalTrade['direction'] =
      ((seed ^ strategySeed) & 1) === 0 ? 'long' : 'short'
    const signedMove =
      (((seed >>> 4) % 1401) - 650 + ((strategySeed % 101) - 50)) / 10000
    const exit = entry * (1 + signedMove)
    const sizeBtc = (capital * 0.12) / entry
    const feesEur = (entry + exit) * sizeBtc * COMMISSION_RATE
    const netEur =
      (direction === 'long' ? exit - entry : entry - exit) * sizeBtc - feesEur
    const trade: HistoricalTrade = {
      id: `example-${index + 1}`,
      direction,
      sizeBtc,
      entryEur: entry,
      exitEur: exit,
      netEur,
      feesEur,
    }
    trades.push(trade)
    capital += netEur
    const offset = Math.min(days - 1, (index + 1) * intervalDays)
    equity.push({
      date: new Date(
        Date.parse(`${parameters.from}T00:00:00.000Z`) + offset * 86_400_000,
      )
        .toISOString()
        .slice(0, 10),
      value: capital,
    })
  }

  let peak = parameters.capital
  let maximumDrawdown = 0
  for (const point of equity) {
    peak = Math.max(peak, point.value)
    if (peak > 0)
      maximumDrawdown = Math.max(
        maximumDrawdown,
        ((peak - point.value) / peak) * 100,
      )
  }
  return {
    parameters,
    trades,
    equity: equity as HistoricalEquityPoint[],
    finalCapital: capital,
    drawdown: maximumDrawdown,
    winRate:
      (trades.filter((trade) => trade.netEur > 0).length / trades.length) * 100,
  }
}

export const historicalDemoProvider: HistoricalProvider = {
  async run(request, signal) {
    if (signal.aborted)
      throw new DOMException('Simulation cancelled', 'AbortError')
    const error = validateHistoricalRequest(request as HistoricalRequest)
    if (error) throw new Error(error)
    return runHistoricalExample(request)
  },
}

function hash(value: string): number {
  let result = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index)
    result = Math.imul(result, 16777619)
  }
  return result >>> 0
}
