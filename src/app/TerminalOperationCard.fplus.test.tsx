// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import TerminalOperationCard from './TerminalOperationCard.tsx'
import type { QwenTrade } from './useQwenTrades.ts'

const HOUR = 3_600_000
const MIN = 60_000
// 9 nov 2026, 22:15 UTC = 23:15 in Madrid (CET).
const ENTRY = Date.UTC(2026, 10, 9, 22, 15)

const trade: QwenTrade = {
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
}
const NOW = ENTRY + 23 * HOUR + 9 * MIN
const master = { score: -0.4, master: -2, atMs: NOW - 5 * MIN }

const card = (over: Partial<QwenTrade> = {}, extra = {}) =>
  render(
    <TerminalOperationCard
      compact
      trade={{ ...trade, ...over }}
      source={{ state: 'ok' }}
      nowMs={NOW}
      onFocus={vi.fn()}
      master={master}
      {...extra}
    />,
  )

const hover = (element: Element) => fireEvent.mouseEnter(element)
const tooltip = () => screen.getByRole('tooltip').textContent ?? ''

afterEach(cleanup)

describe('operation card F+: header, ring and net', () => {
  it('shows the side tag, the number, the occupied places as dots and entry → now', () => {
    card({}, { place: { index: 1, open: 2, max: 3, usedUsd: 600 } })
    expect(screen.getByText('▼ SHORT')).toHaveClass('text-short')
    expect(screen.getByText('#15')).toBeTruthy()
    const places = screen.getByTestId('operation-places')
    expect(places.textContent).toContain('Abiertas 2 de 3')
    expect(places.querySelectorAll('i[data-filled="true"]')).toHaveLength(2)
    expect(places.querySelectorAll('i[data-filled="false"]')).toHaveLength(1)
    expect(screen.getByTestId('operation-entry')).toHaveTextContent('2148,41')
    expect(screen.getByTestId('operation-now-price')).toHaveTextContent(
      '2125,00',
    )
  })

  it('draws the hours held in the center of the ring, with the 24 h mark in its tooltip', () => {
    card()
    const ring = screen.getByTestId('operation-ring')
    expect(ring).toHaveTextContent('23h')
    hover(screen.getByRole('img', { name: /Horas abiertas/ }))
    expect(tooltip()).toContain('23 h 9 min de 36 h')
    expect(tooltip()).toContain('24 h')
    expect(tooltip()).toContain('9 nov, 23:15')
    expect(tooltip()).toContain('hora de Madrid')
  })

  it('shows the net big and coloured with the percent of the size below', () => {
    card()
    expect(screen.getByTestId('operation-net')).toHaveClass('text-long')
    expect(screen.getByTestId('operation-percent')).toHaveTextContent('+0,98 %')
  })

  it('marks a provisional net and says so under it', () => {
    card({ fundingComplete: false })
    expect(screen.getByTestId('operation-net')).toHaveClass('text-warn')
    expect(screen.getByTestId('operation-percent')).toHaveTextContent(
      'provisional',
    )
  })
})

describe('operation card F+: range bar', () => {
  it('shows worst and best in US$ with the zero tick and a marker for now, explained in its tooltip', () => {
    card()
    const range = screen.getByTestId('operation-range')
    expect(range).toHaveTextContent('−4,20')
    expect(range).toHaveTextContent('+5,02')
    expect(within(range).getByTestId('range-now')).toBeTruthy()
    expect(within(range).getByTestId('range-zero')).toBeTruthy()
    hover(within(range).getByRole('img', { name: /Rango desde la entrada/ }))
    expect(tooltip()).toContain('lo peor que llegó a ir fue −4,20 US$')
    expect(tooltip()).toContain('lo mejor +5,02 US$')
    expect(tooltip()).toContain('+3,11 US$')
  })

  it('hides the bar and says sin dato in the tooltip when the excursion is missing', () => {
    card({ mfeBp: null, maeBp: null })
    const range = screen.getByTestId('operation-range')
    expect(within(range).queryByTestId('range-now')).toBeNull()
    expect(within(range).queryByTestId('range-zero')).toBeNull()
    hover(within(range).getByRole('img', { name: /Rango desde la entrada/ }))
    expect(tooltip()).toContain('sin dato')
  })
})

describe('operation card F+: rule icons', () => {
  const rules = () => screen.getByRole('group', { name: 'Reglas de salida' })

  it('shows three icons without text and each detail only in its tooltip', () => {
    card()
    expect(rules().textContent).toBe('')
    const icons = within(rules()).getAllByRole('img')
    expect(icons).toHaveLength(3)
    hover(within(rules()).getByRole('img', { name: /^Maestro:/ }))
    expect(tooltip()).toContain('a favor del corto')
    expect(tooltip()).toContain('puntaje −0,40')
  })

  it('says the maestro goes against the operation when the score turns', () => {
    card({}, { master: { score: 0.3, master: 1, atMs: NOW } })
    const icon = within(rules()).getByRole('img', { name: /^Maestro:/ })
    expect(icon).toHaveAccessibleName(/en contra/)
    hover(icon)
    expect(tooltip()).toContain('en contra del corto')
  })

  it('says sin dato when no look has a score', () => {
    card({}, { master: null })
    const icon = within(rules()).getByRole('img', { name: /^Maestro:/ })
    expect(icon).toHaveAccessibleName(/sin dato/)
    hover(icon)
    expect(tooltip()).toContain('sin dato')
  })

  it('counts the minutes to the 24 h check and the time left to the cap', () => {
    card({}, { nowMs: ENTRY + 23 * HOUR + 10 * MIN })
    hover(within(rules()).getByRole('img', { name: /agotado/i }))
    expect(tooltip()).toContain('faltan 50 min')
    cleanup()
    card({}, { nowMs: ENTRY + 23 * HOUR + 9 * MIN })
    hover(within(rules()).getByRole('img', { name: /Tope/ }))
    expect(tooltip()).toContain('faltan 12 h 51 min')
    expect(tooltip()).toContain('11 nov, 11:15')
  })

  it('says activo once the 24 h passed', () => {
    card({}, { nowMs: ENTRY + 25 * HOUR })
    const icon = within(rules()).getByRole('img', { name: /agotado/i })
    expect(icon).toHaveAccessibleName(/activo/)
    hover(icon)
    expect(tooltip()).toContain('activo')
  })

  it('gives the forced close in Madrid time across the DST change (CEST → CET)', () => {
    // Entered 24 oct 20:00 UTC = 22:00 CEST; the 36 h cap lands on 26 oct 08:00 UTC = 09:00 CET.
    const entry = Date.UTC(2026, 9, 24, 20, 0)
    card({ entryMs: entry }, { nowMs: entry + 2 * HOUR })
    hover(within(rules()).getByRole('img', { name: /Tope/ }))
    expect(tooltip()).toContain('26 oct, 09:00')
    expect(tooltip()).not.toContain('UTC')
  })

  it('has no rules for a closed operation', () => {
    card({ open: false, exitMs: ENTRY + 6 * HOUR })
    expect(screen.queryByRole('group', { name: 'Reglas de salida' })).toBeNull()
  })
})

describe('operation card F+: actions and Madrid times', () => {
  it('keeps centrar operación and datos y costes as icon buttons with a tooltip', () => {
    const onFocus = vi.fn()
    card({}, { onFocus })
    const center = screen.getByRole('button', { name: 'Centrar operación' })
    hover(center)
    expect(tooltip()).toContain('Centrar')
    fireEvent.click(center)
    expect(onFocus).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: /Datos y costes/ }))
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveTextContent('9/11/2026, 23:15')
    expect(dialog.textContent).not.toMatch(/UTC/)
  })

  it('writes no UTC label anywhere on the card', () => {
    const { container } = card({ entryReason: 'rebote' })
    expect(container.textContent).not.toMatch(/UTC/)
  })
})
