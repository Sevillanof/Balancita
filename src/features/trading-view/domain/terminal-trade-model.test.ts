import { describe, expect, it } from 'vitest'
import {
  layoutTradeLabels,
  readTradeSpan,
  timeLogicalIndex,
  tradeIdentity,
  tradeHistoryNotice,
  tradeTone,
  type TerminalChartTrade,
  type TradeCoordinates,
} from './terminal-trade-model.ts'

const entryMs = Date.UTC(2026, 9, 31, 0)
const trade = (
  change: Partial<TerminalChartTrade> = {},
): TerminalChartTrade => ({
  product: 'PF_ETHUSD',
  tradeNo: 2,
  open: true,
  side: 'SHORT',
  entryMs,
  exitMs: null,
  entryPrice: 2241.6574077,
  exitPrice: null,
  markPrice: 2242.7,
  markMs: entryMs + 300_000,
  netUsd: -1.63,
  fundingComplete: true,
  ...change,
})

describe('registered Terminal trade visuals', () => {
  it('keeps identity and entry price independent of new prices and opinions', () => {
    const first = trade()
    const marked = trade({ markPrice: 2200, netUsd: 10 })
    expect(tradeIdentity(first)).toBe(tradeIdentity(marked))
    const a = readTradeSpan(first, entryMs + 300_000)
    const b = readTradeSpan(marked, entryMs + 600_000)
    expect(a).toMatchObject({
      state: 'ready',
      startMs: entryMs,
      endMs: entryMs + 300_000,
      price: 2241.6574077,
    })
    expect(b).toMatchObject({
      state: 'ready',
      startMs: entryMs,
      endMs: entryMs + 600_000,
      price: 2241.6574077,
    })
  })

  it('freezes closed lines at the actual recorded exit, including later market candles', () => {
    const closed = trade({
      open: false,
      exitMs: entryMs + 36_000_000,
      exitPrice: 2200,
    })
    expect(readTradeSpan(closed, entryMs + 40_000_000)).toEqual(
      readTradeSpan(closed, entryMs + 90_000_000),
    )
    expect(readTradeSpan(closed, entryMs + 90_000_000)).toMatchObject({
      endMs: closed.exitMs,
    })
  })

  it('does not invent a price or an exit for incomplete operation records', () => {
    expect(readTradeSpan(trade({ entryPrice: null }), entryMs)).toMatchObject({
      state: 'unavailable',
      reason: expect.stringMatching(/precio de entrada/i),
    })

    expect(
      readTradeSpan(trade({ open: false, exitMs: null }), entryMs),
    ).toMatchObject({
      state: 'unavailable',
      reason: expect.stringMatching(/cierre/i),
    })
  })

  it('makes unavailable historical periods explicit rather than pretending an older trade began at the first candle', () => {
    expect(tradeHistoryNotice(trade(), entryMs + 60_000)).toMatch(
      /anterior al historial/,
    )
    expect(
      tradeHistoryNotice(
        trade({ open: false, exitMs: entryMs + 60_000 }),
        entryMs + 120_000,
      ),
    ).toMatch(/no hay velas/)
    expect(tradeHistoryNotice(trade(), entryMs)).toBeNull()
  })

  it('uses recorded net, not direction or gross price, and marks unavailable/provisional results', () => {
    expect(tradeTone(trade({ netUsd: 10 }), true)).toBe('gain')
    expect(tradeTone(trade({ netUsd: -1 }), true)).toBe('loss')
    expect(tradeTone(trade({ side: 'LONG', netUsd: -1 }), true)).toBe('loss')
    expect(tradeTone(trade({ netUsd: 0 }), true)).toBe('neutral')
    expect(tradeTone(trade({ netUsd: null }), true)).toBe('unknown')
    expect(tradeTone(trade({ fundingComplete: false }), true)).toBe(
      'provisional',
    )
    expect(tradeTone(trade(), false)).toBe('unknown')
  })

  it('places timestamps between candles rather than moving them to the start of another interval', () => {
    const times = [entryMs / 1000, entryMs / 1000 + 300, entryMs / 1000 + 600]
    expect(timeLogicalIndex(times, entryMs + 150_000, 300)).toBe(0.5)
    expect(timeLogicalIndex(times, entryMs - 300_000, 300)).toBe(-1)
    expect(timeLogicalIndex(times, entryMs + 900_000, 300)).toBe(3)
    expect(timeLogicalIndex([], entryMs, 300)).toBeNull()
  })

  it.each([234, 980])(
    'keeps entry and result badges readable across a same-time reversal in a %ipx pane',
    (width) => {
      const point = (operation: TerminalChartTrade): TradeCoordinates => ({
        id: tradeIdentity(operation),
        trade: operation,
        startMs: operation.entryMs,
        endMs: operation.exitMs ?? entryMs + 600_000,
        startX: 0,
        endX: width * 0.55,
        entryY: 220,
        entryX: operation.open ? width * 0.5 : -50,
        entryVisible: operation.open,
        resultX: width * (operation.open ? 0.55 : 0.5),
        resultY: 220,
        resultVisible: true,
        area: [],
      })
      const open = trade()
      const closed = trade({
        tradeNo: 1,
        side: 'LONG',
        open: false,
        entryMs: entryMs - 10_000,
        exitMs: entryMs,
      })
      const layout = layoutTradeLabels(
        [point(open), point(closed)],
        width,
        289,
        tradeIdentity(open),
      )
      const boxes = layout
        .flatMap((item) => [item.entry, item.result])
        .filter((box) => box !== null)
      expect(boxes).toHaveLength(4)
      for (const box of boxes) {
        expect(box.left).toBeGreaterThanOrEqual(0)
        expect(box.top).toBeGreaterThanOrEqual(0)
        expect(box.left + box.width).toBeLessThanOrEqual(width)
        expect(box.top + box.height).toBeLessThanOrEqual(289)
      }
      for (const [index, a] of boxes.entries())
        for (const b of boxes.slice(index + 1))
          expect(
            Math.min(a.left + a.width, b.left + b.width) <=
              Math.max(a.left, b.left) ||
              Math.min(a.top + a.height, b.top + b.height) <=
                Math.max(a.top, b.top),
          ).toBe(true)
    },
  )
})
