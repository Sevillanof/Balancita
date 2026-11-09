import { describe, expect, it } from 'vitest'
import {
  holdView,
  rangeView,
  ruleViews,
  usdSigned,
} from './terminal-operation-view.ts'
import type { QwenTrade } from './useQwenTrades.ts'

const HOUR = 3_600_000
const MIN = 60_000
// 9 nov 2026, 22:15 UTC = 23:15 in Madrid (CET).
const ENTRY = Date.UTC(2026, 10, 9, 22, 15)

const trade = (over: Partial<QwenTrade> = {}): QwenTrade => ({
  product: 'PF_ETHUSD',
  tradeNo: 15,
  open: true,
  side: 'SHORT',
  entryMs: ENTRY,
  exitMs: null,
  entryPrice: 2148.41,
  exitPrice: null,
  netUsd: 3.11,
  feesUsd: 0.3,
  fundingUsd: 0,
  fundingComplete: true,
  markMs: ENTRY + 23 * HOUR,
  markPrice: 2125,
  closedBy: null,
  holdMin: null,
  notionalUsd: 317.3,
  leverage: 1,
  marginUsd: 317.3,
  maxHoldMs: 36 * HOUR,
  mfeBp: 158.2,
  maeBp: -132.4,
  ...over,
})

describe('holdView: hours held against the cap', () => {
  it('fills the ring with the share of the 36 h cap and marks the 24 h check', () => {
    const view = holdView(trade(), ENTRY + 23 * HOUR + 9 * MIN)
    expect(view.label).toBe('23h')
    expect(view.fraction).toBeCloseTo((23 * 60 + 9) / (36 * 60), 5)
    expect(view.exhaustMark).toBeCloseTo(24 / 36, 5)
    expect(view.text).toBe('23 h 9 min de 36 h')
  })

  it('says minutes under an hour, never passes the cap and keeps the mark inside', () => {
    expect(holdView(trade(), ENTRY + 42 * MIN).label).toBe('42m')
    const over = holdView(trade(), ENTRY + 40 * HOUR)
    expect(over.fraction).toBe(1)
    expect(over.label).toBe('40h')
  })

  it('uses the operation own cap and drops the 24 h mark when the cap is shorter (rebound, 4 h)', () => {
    const view = holdView(trade({ maxHoldMs: 4 * HOUR }), ENTRY + 1 * HOUR)
    expect(view.fraction).toBeCloseTo(0.25, 5)
    expect(view.exhaustMark).toBeNull()
    expect(view.text).toBe('1 h 0 min de 4 h')
  })

  it('counts a closed operation until its exit and says nothing for a missing one', () => {
    const closed = trade({ open: false, exitMs: ENTRY + 6 * HOUR })
    expect(holdView(closed, ENTRY + 99 * HOUR).label).toBe('6h')
    const lost = holdView(trade({ open: false, exitMs: null }), ENTRY + HOUR)
    expect(lost.label).toBe('—')
    expect(lost.fraction).toBe(0)
  })
})

describe('rangeView: worst and best since entry, in US$', () => {
  it('converts basis points of the notional to US$ and places the zero tick and now', () => {
    // 317,3 US$ · 158,2 bp = 5,02 US$; −132,4 bp = −4,20 US$.
    const view = rangeView(trade())!
    expect(view.worstUsd).toBeCloseTo(-4.2, 2)
    expect(view.bestUsd).toBeCloseTo(5.02, 2)
    expect(view.zero).toBeCloseTo(4.2 / (4.2 + 5.02), 3)
    expect(view.now).toBeCloseTo((3.11 + 4.2) / (4.2 + 5.02), 3)
    expect(view.tip).toContain('−4,20 US$')
    expect(view.tip).toContain('+5,02 US$')
    expect(view.tip).toContain('+3,11 US$')
  })

  it('keeps the marker at the edge when costs put the net outside the excursion', () => {
    expect(rangeView(trade({ netUsd: -9 }))!.now).toBe(0)
    expect(rangeView(trade({ netUsd: 50 }))!.now).toBe(1)
  })

  it('is null (sin dato) when the excursion or the size is missing, never guessed', () => {
    expect(rangeView(trade({ mfeBp: null }))).toBeNull()
    expect(rangeView(trade({ maeBp: undefined }))).toBeNull()
    expect(rangeView(trade({ notionalUsd: null }))).toBeNull()
  })

  it('is null when the price has not moved yet (both zero)', () => {
    expect(rangeView(trade({ mfeBp: 0, maeBp: 0 }))).toBeNull()
  })

  it('has no marker when the net is unknown', () => {
    expect(rangeView(trade({ netUsd: null }))!.now).toBeNull()
  })
})

describe('ruleViews: the three exit rules of an open operation', () => {
  const at = (ms: number) => ENTRY + ms
  const master = (score: number | null, verdict: number | null) => ({
    score,
    master: verdict,
    atMs: ENTRY,
  })

  it('is empty for a closed operation', () => {
    expect(ruleViews(trade({ open: false }), at(HOUR), master(-1, -2))).toEqual(
      [],
    )
  })

  it('reads the maestro from the score against the side: a short with a negative score goes in favour', () => {
    const [rule] = ruleViews(trade(), at(HOUR), master(-0.4, -2))
    expect(rule!.id).toBe('master')
    expect(rule!.state).toBe('favor')
    expect(rule!.progress).toBe(1)
    expect(rule!.tip).toContain('a favor del corto')
    const [long] = ruleViews(
      trade({ side: 'LONG' }),
      at(HOUR),
      master(-0.4, -1),
    )
    expect(long!.state).toBe('contra')
    expect(long!.progress).toBeCloseTo(0.25, 5)
    expect(long!.tip).toContain('en contra del largo')
  })

  it('says sin dato when no look has a score', () => {
    const [rule] = ruleViews(trade(), at(HOUR), null)
    expect(rule!.state).toBe('sin_dato')
    expect(rule!.progress).toBeNull()
    expect(rule!.tip).toContain('sin dato')
  })

  it('counts the minutes to the 24 h check, then says activo', () => {
    const before = ruleViews(trade(), at(23 * HOUR + 10 * MIN), null)[1]!
    expect(before.id).toBe('exhaust')
    expect(before.state).toBe('espera')
    expect(before.progress).toBeCloseTo((23 * 60 + 10) / (24 * 60), 5)
    expect(before.tip).toContain('faltan 50 min')
    const after = ruleViews(trade(), at(25 * HOUR), master(-0.2, -1))[1]!
    expect(after.state).toBe('activo')
    expect(after.progress).toBe(1)
    expect(after.tip).toContain('activo')
  })

  it('does not apply the 24 h check to an operation with a shorter cap', () => {
    const rule = ruleViews(trade({ maxHoldMs: 4 * HOUR }), at(HOUR), null)[1]!
    expect(rule.state).toBe('no_aplica')
    expect(rule.tip).toContain('4 h')
  })

  it('counts the time left to the cap with the Madrid hour of the forced close', () => {
    const cap = ruleViews(trade(), at(23 * HOUR + 9 * MIN), null)[2]!
    expect(cap.id).toBe('cap')
    expect(cap.state).toBe('espera')
    expect(cap.progress).toBeCloseTo((23 * 60 + 9) / (36 * 60), 5)
    expect(cap.tip).toContain('faltan 12 h 51 min')
    // Entry 23:15 Madrid + 36 h = 11:15 two days later in Madrid.
    expect(cap.tip).toContain('11 nov, 11:15')
    expect(cap.tip).not.toContain('UTC')
  })

  it('says the cap is reached once it is', () => {
    const cap = ruleViews(trade(), at(37 * HOUR), null)[2]!
    expect(cap.state).toBe('llego')
    expect(cap.progress).toBe(1)
  })
})

describe('usdSigned', () => {
  it('uses a comma, an explicit sign and a real minus', () => {
    expect(usdSigned(5.02)).toBe('+5,02 US$')
    expect(usdSigned(-4.2)).toBe('−4,20 US$')
    expect(usdSigned(0)).toBe('0,00 US$')
  })
})
