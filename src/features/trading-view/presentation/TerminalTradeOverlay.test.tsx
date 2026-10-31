// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import TerminalTradeOverlay from './TerminalTradeOverlay.tsx'
import type { TradeCoordinates } from '../domain/terminal-trade-model.ts'

const item: TradeCoordinates = {
  id: 'terminal:PF_ETHUSD:2',
  trade: {
    product: 'PF_ETHUSD',
    tradeNo: 2,
    side: 'SHORT',
    open: true,
    entryMs: 1000,
    exitMs: null,
    entryPrice: 2241.65,
    exitPrice: null,
    markPrice: 2245,
    markMs: 2000,
    netUsd: -2,
    fundingComplete: true,
  },
  startMs: 1000,
  endMs: 3000,
  startX: 40,
  endX: 500,
  entryX: 40,
  entryY: 150,
  entryVisible: true,
  resultX: 470,
  resultY: 130,
  resultVisible: true,
  area: [
    { x: 40, y: 150 },
    { x: 470, y: 130 },
  ],
}
afterEach(cleanup)

describe('operation indicators', () => {
  it('draws a time-bounded horizontal line from the real entry, not across all chart history', () => {
    const select = vi.fn()
    render(
      <TerminalTradeOverlay
        items={[item]}
        width={600}
        height={350}
        selectedId={item.id}
        confirmed
        onSelect={select}
      />,
    )
    const line = screen.getByTestId('trade-entry-line')
    expect(line).toHaveAttribute('x1', '40')
    expect(line).toHaveAttribute('x2', '500')
    expect(line).toHaveAttribute('y1', '150')
    expect(line).toHaveAttribute('y2', '150')
    expect(line).toHaveAttribute('data-entry-ms', '1000')
    expect(line).toHaveAttribute('data-end-ms', '3000')
    fireEvent.click(screen.getByRole('button', { name: /Entrada SHORT/ }))
    expect(select).toHaveBeenCalledWith(item.id)
  })

  it('keeps an older entry as labeled context without inventing a fill on the first visible candle', () => {
    render(
      <TerminalTradeOverlay
        items={[{ ...item, entryVisible: false, entryX: -500, startX: 0 }]}
        width={600}
        height={350}
        selectedId={item.id}
        confirmed
        onSelect={vi.fn()}
      />,
    )
    expect(
      screen.getByRole('button', { name: /Entrada anterior SHORT/ }),
    ).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Entrada SHORT/ })).toBeNull()
  })
})
