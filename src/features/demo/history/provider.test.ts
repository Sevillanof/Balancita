import { describe, expect, it } from 'vitest'
import { runHistoricalExample } from './provider.ts'
import type { HistoricalRequest } from './types.ts'
import { validateHistoricalRequest } from './validation.ts'

const request: HistoricalRequest = {
  asset: 'BTC/EUR',
  from: '2026-08-01',
  to: '2026-09-30',
  interval: '15m',
  strategy: 'Ruptura + volumen (ejemplo)',
  capital: 10_000,
}

describe('historical demo provider', () => {
  it('validates inclusive UTC dates and finite positive capital', () => {
    expect(validateHistoricalRequest(request)).toBeNull()
    expect(
      validateHistoricalRequest({ ...request, from: '2026-10-01' }),
    ).toMatch(/anterior/i)
    expect(
      validateHistoricalRequest({ ...request, capital: Number.NaN }),
    ).toMatch(/capital/i)
    expect(
      validateHistoricalRequest({ ...request, interval: '2m' as never }),
    ).toMatch(/intervalo/i)
  })

  it('is deterministic, binds the submitted request, and derives metrics from fills', () => {
    const first = runHistoricalExample(request)
    const second = runHistoricalExample(request)
    expect(first).toEqual(second)
    expect(first.parameters).toEqual(request)
    expect(first.trades.length).toBeGreaterThan(0)
    expect(first.finalCapital).toBeCloseTo(
      request.capital +
        first.trades.reduce((sum, trade) => sum + trade.netEur, 0),
    )
    expect(first.winRate).toBeCloseTo(
      (first.trades.filter((trade) => trade.netEur > 0).length /
        first.trades.length) *
        100,
    )
    expect(first.drawdown).toBeGreaterThanOrEqual(0)
  })

  it('changes reproducibly with the submitted instrument, range, interval, strategy, or capital', () => {
    expect(
      runHistoricalExample({ ...request, capital: 5000 }).finalCapital,
    ).not.toBe(runHistoricalExample(request).finalCapital)
    expect(
      runHistoricalExample({ ...request, interval: '1h' }).trades,
    ).not.toEqual(runHistoricalExample(request).trades)
  })
})
