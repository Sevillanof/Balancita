import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createDemoSnapshot,
  createDemoTradingProvider,
  openUnrealizedPnl,
} from './provider.ts'

afterEach(() => vi.useRealTimers())

describe('deterministic demo trading source', () => {
  it('recreates the same stable market and event identities', () => {
    const first = createDemoSnapshot()
    const second = createDemoSnapshot()
    expect(first).toEqual(second)
    expect(first.decisions.map(({ id }) => id)).toEqual(
      expect.arrayContaining(['decision-02', 'decision-05']),
    )
    expect(
      first.decisions.find(({ id }) => id === 'decision-02')?.executionId,
    ).toBe('execution-01')
    expect(
      first.decisions.find(({ id }) => id === 'decision-05')?.executionId,
    ).toBe('execution-03')
  })

  it('keeps illustrative trade PnL equal to direction-adjusted gross less both fees', () => {
    const { trades } = createDemoSnapshot()
    for (const trade of trades) {
      const direction = trade.direction === 'long' ? 1 : -1
      const gross = (trade.exitEur - trade.entryEur) * trade.sizeBtc * direction
      expect(trade.realizedPnlEur).toBeCloseTo(
        gross - trade.entryFeeEur - trade.exitFeeEur,
        2,
      )
    }
  })

  it('marks open position PnL after entry and estimated exit fees', () => {
    const snapshot = createDemoSnapshot()
    const position = snapshot.positions[0]!
    expect(openUnrealizedPnl(position, position.entryEur)).toBeLessThan(0)
    expect(
      openUnrealizedPnl(position, position.entryEur + 100),
    ).toBeGreaterThan(openUnrealizedPnl(position, position.entryEur))
  })

  it('emits a coordinated illustrative entry and position on a simulated candle boundary', () => {
    vi.useFakeTimers()
    const provider = createDemoTradingProvider(10)
    let latest = provider.getSnapshot()
    const unsubscribe = provider.subscribe((snapshot) => {
      latest = snapshot
    })
    provider.resume()
    vi.advanceTimersByTime(80)
    expect(latest.decisions.some(({ id }) => id === 'demo-decision-8')).toBe(
      true,
    )
    expect(latest.positions.some(({ id }) => id === 'demo-position-8')).toBe(
      true,
    )
    unsubscribe()
  })
})
