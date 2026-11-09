import { describe, expect, it } from 'vitest'
import {
  comparison,
  curveLines,
  curveSeries,
  ethHoldUsd,
  exitReasonView,
  holdShare,
  qwenAccount,
  reviewPace,
  reviewSlots,
  formatPercent,
  type AccountStep,
  type QwenAccount,
} from './account-balance.ts'

const DAY = 86_400_000
const START = 1_793_400_000_000

const step = (over: Partial<AccountStep> = {}): AccountStep => ({
  product: 'PF_ETHUSD',
  tradeNo: 1,
  side: 'LONG',
  exitMs: START + DAY,
  netUsd: 5,
  balanceUsd: 1005,
  entryMs: START,
  entryPrice: 2000,
  exitPrice: 2010,
  closedBy: 'formula',
  exitReason: 'maestro_vuelta',
  maxHoldMs: 129_600_000,
  ethPrice: 2000,
  ...over,
})

const account = (over: Partial<QwenAccount> = {}): QwenAccount => ({
  startUsd: 1000,
  startMs: START,
  asOfMs: START + 4 * DAY,
  balanceUsd: 1000,
  realizedUsd: 0,
  openUsd: 0,
  openCount: 0,
  fundingIncomplete: false,
  ethStartPrice: 2000,
  ethNowPrice: 2000,
  steps: [],
  ...over,
})

describe('ethHoldUsd: what buying ETH at the start would be worth', () => {
  it('scales the capital by the price ratio (1000 US$ bought at 2000, now 1900 → 950)', () => {
    expect(ethHoldUsd(1000, 2000, 1900)).toBe(950)
    expect(ethHoldUsd(1000, 2000, 2000)).toBe(1000)
    expect(ethHoldUsd(1000, 2000, 2400)).toBe(1200)
    expect(ethHoldUsd(500, 1600, 2000)).toBe(625)
  })
  it('is null, never a guess, when a price is missing or not a positive number', () => {
    expect(ethHoldUsd(1000, null, 1900)).toBeNull()
    expect(ethHoldUsd(1000, 2000, null)).toBeNull()
    expect(ethHoldUsd(1000, 0, 1900)).toBeNull()
    expect(ethHoldUsd(1000, 2000, -1)).toBeNull()
    expect(ethHoldUsd(1000, Number.NaN, 1900)).toBeNull()
  })
})

describe('curveSeries', () => {
  it('walks start, each close and now for both lines', () => {
    const a = account({
      balanceUsd: 990,
      ethNowPrice: 1900,
      steps: [
        step({ balanceUsd: 1005, ethPrice: 2100 }),
        step({ balanceUsd: 990, ethPrice: 1800 }),
      ],
    })
    expect(curveSeries(a)).toEqual({
      terminal: [1000, 1005, 990, 990],
      eth: [1000, 1050, 900, 950],
    })
  })
  it('has no ETH line without the start price and holes where one close lacks its price', () => {
    expect(
      curveSeries(account({ ethStartPrice: null, steps: [step()] })).eth,
    ).toBeNull()
    expect(
      curveSeries(
        account({
          steps: [step({ ethPrice: null }), step({ ethPrice: 2200 })],
        }),
      ).eth,
    ).toEqual([1000, null, 1100, 1000])
  })
})

describe('curveLines', () => {
  it('draws both lines on one scale and breaks the ETH line at a hole', () => {
    const lines = curveLines(
      { terminal: [0, 10, 5, 5], eth: [0, null, 10, 5] },
      100,
      10,
    )
    expect(lines.terminal).toBe('0.0,10.0 33.3,0.0 66.7,5.0 100.0,5.0')
    expect(lines.eth).toEqual(['66.7,0.0 100.0,5.0'])
  })
  it('keeps a flat series on the middle instead of dividing by zero', () => {
    expect(curveLines({ terminal: [5, 5], eth: null }, 100, 10).terminal).toBe(
      '0.0,5.0 100.0,5.0',
    )
  })
})

describe('comparison', () => {
  it('gives net and % since the start for both and the difference', () => {
    const c = comparison(account({ balanceUsd: 979.81, ethNowPrice: 1918 }))
    expect(c.terminal.net).toBeCloseTo(-20.19, 2)
    expect(c.terminal.pct).toBeCloseTo(-2.019, 3)
    expect(c.eth?.balance).toBeCloseTo(959, 6)
    expect(c.eth?.net).toBeCloseTo(-41, 6)
    expect(c.eth?.pct).toBeCloseTo(-4.1, 6)
    expect(c.delta).toBeCloseTo(20.81, 2)
  })
  it('says the Terminal is behind with a negative difference', () => {
    expect(
      comparison(account({ balanceUsd: 1010, ethNowPrice: 2100 })).delta,
    ).toBeCloseTo(-40, 6)
  })
  it('has no ETH and no difference when the ETH price is unknown', () => {
    const c = comparison(account({ ethNowPrice: null, balanceUsd: 990 }))
    expect(c.eth).toBeNull()
    expect(c.delta).toBeNull()
    expect(c.terminal.net).toBeCloseTo(-10, 6)
  })
})

describe('reviewPace', () => {
  it('counts closed operations over the 30 and the pace per day since the start', () => {
    const steps = Array.from({ length: 10 }, (_, i) => step({ tradeNo: i }))
    const pace = reviewPace(account({ steps, asOfMs: START + 4 * DAY }))
    expect(pace).toMatchObject({ done: 10, target: 30, remaining: 20 })
    expect(pace.perDay).toBeCloseTo(2.5, 9)
    expect(pace.daysLeft).toBeCloseTo(8, 9)
  })
  it('does not inflate the pace in the first day', () => {
    const pace = reviewPace(
      account({ steps: [step(), step()], asOfMs: START + 3_600_000 }),
    )
    expect(pace.perDay).toBe(2)
  })
  it('has no pace or estimate without a start, nor with no operations', () => {
    expect(
      reviewPace(account({ startMs: null, steps: [step()] })),
    ).toMatchObject({ perDay: null, daysLeft: null, remaining: 29 })
    expect(reviewPace(account({ steps: [] }))).toMatchObject({
      done: 0,
      perDay: 0,
      daysLeft: null,
    })
  })
  it('is done at 30 and more, with nothing remaining', () => {
    const steps = Array.from({ length: 34 }, (_, i) => step({ tradeNo: i }))
    expect(reviewPace(account({ steps }))).toMatchObject({
      done: 34,
      remaining: 0,
      daysLeft: 0,
    })
  })
})

describe('reviewSlots', () => {
  it('fills one slot per closed operation, green for a win and red for a loss, of 30', () => {
    const slots = reviewSlots([
      step({ netUsd: 3 }),
      step({ netUsd: -1 }),
      step({ netUsd: 0 }),
    ])
    expect(slots).toHaveLength(30)
    expect(slots.slice(0, 4)).toEqual(['win', 'loss', 'win', 'empty'])
    expect(slots.filter((s) => s === 'empty')).toHaveLength(27)
  })
  it('keeps the first 30 operations when there are more', () => {
    const steps = Array.from({ length: 35 }, (_, i) =>
      step({ netUsd: i < 30 ? 1 : -1 }),
    )
    expect(reviewSlots(steps).every((s) => s === 'win')).toBe(true)
  })
})

describe('exitReasonView', () => {
  it.each([
    [{ closedBy: 'formula', exitReason: 'maestro_vuelta' }, '↺', 'vuelta'],
    [{ closedBy: 'formula', exitReason: 'maestro_agotado' }, '∅', 'agotado'],
    [{ closedBy: 'tiempo', exitReason: null }, '⏲', 'tiempo'],
    [{ closedBy: 'stop', exitReason: null }, null, 'stop'],
    [{ closedBy: 'formula', exitReason: 'noticia_12h' }, null, 'noticia 12h'],
    [{ closedBy: null, exitReason: null }, null, ''],
  ])('%j → %s %s', (over, icon, text) => {
    expect(exitReasonView(step(over))).toEqual({ icon, text })
  })
})

describe('holdShare', () => {
  it('is the time held against the cap of the operation, 36 h when it has none', () => {
    expect(holdShare(step({ exitMs: START + 18 * 3_600_000 }))).toEqual({
      hours: 18,
      share: 0.5,
    })
    expect(
      holdShare(step({ exitMs: START + 40 * 3_600_000, maxHoldMs: null })),
    ).toEqual({ hours: 40, share: 1 })
    expect(holdShare(step({ entryMs: null }))).toBeNull()
  })
})

describe('formatPercent', () => {
  it('shows a signed percentage with one decimal', () => {
    expect(formatPercent(-2.019)).toBe('-2,0 %')
    expect(formatPercent(4.14)).toBe('+4,1 %')
    expect(formatPercent(0)).toBe('0,0 %')
  })
})

describe('qwenAccount: ETH fields', () => {
  const body = {
    status: 'ok',
    start_usd: 1000,
    start_ms: START,
    as_of_ms: START + DAY,
    eth_start_price: 2000,
    eth_now_price: 1900,
    balance_usd: 990,
    realized_usd: -10,
    open_usd: 0,
    open_count: 0,
    funding_incomplete: false,
    steps: [
      {
        product: 'PF_ETHUSD',
        trade_no: 1,
        side: 'LONG',
        exit_ms: START + DAY,
        net_usd: -10,
        balance_usd: 990,
        entry_ms: START,
        entry_price: 2000,
        exit_price: 1990,
        closed_by: 'tiempo',
        exit_reason: null,
        max_hold_ms: 129_600_000,
        eth_price: 1990,
      },
    ],
  }
  it('reads the new fields', () => {
    expect(qwenAccount(body)).toMatchObject({
      startMs: START,
      asOfMs: START + DAY,
      ethStartPrice: 2000,
      ethNowPrice: 1900,
      steps: [
        {
          entryMs: START,
          entryPrice: 2000,
          exitPrice: 1990,
          closedBy: 'tiempo',
          maxHoldMs: 129_600_000,
          ethPrice: 1990,
        },
      ],
    })
  })
  it('still reads an answer without them, as unknown', () => {
    const old = qwenAccount({
      status: 'ok',
      start_usd: 1000,
      balance_usd: 1000,
      realized_usd: 0,
      open_usd: 0,
      steps: [
        {
          product: 'PF_ETHUSD',
          trade_no: 1,
          side: 'LONG',
          exit_ms: 1,
          net_usd: 0,
          balance_usd: 1000,
        },
      ],
    })
    expect(old).toMatchObject({
      startMs: null,
      ethStartPrice: null,
      ethNowPrice: null,
      steps: [{ entryMs: null, exitPrice: null, ethPrice: null }],
    })
  })
  it('does not trust a non-positive price', () => {
    const odd = qwenAccount({ ...body, eth_start_price: 0, eth_now_price: -5 })
    expect(odd).toMatchObject({ ethStartPrice: null, ethNowPrice: null })
  })
})
