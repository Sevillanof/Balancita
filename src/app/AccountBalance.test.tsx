// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { AccountBalanceView } from './AccountBalance.tsx'
import { formatSigned, qwenAccount } from './account-balance.ts'

afterEach(cleanup)

const HOUR = 3_600_000
/** Currency formats separate the symbol with a no-break space. */
const plain = (value: Element | string) =>
  (typeof value === 'string' ? value : (value.textContent ?? '')).replace(
    /\u00a0/g,
    ' ',
  )
// 2 nov 2026 12:00 UTC = 13:00 in Madrid.
const START = Date.UTC(2026, 10, 2, 12, 0)

const payload = (over: Record<string, unknown> = {}) => ({
  status: 'ok',
  start_usd: 1000,
  start_ms: START,
  as_of_ms: START + 3 * 24 * HOUR,
  eth_start_price: 2000,
  eth_now_price: 1900,
  balance_usd: 1003.5,
  realized_usd: 3,
  open_usd: 0.5,
  open_count: 1,
  funding_incomplete: false,
  steps: [
    {
      product: 'PF_ETHUSD',
      trade_no: 1,
      side: 'LONG',
      exit_ms: START + 14 * HOUR,
      net_usd: 5,
      balance_usd: 1005,
      entry_ms: START,
      entry_price: 2000,
      exit_price: 2010.5,
      closed_by: 'formula',
      exit_reason: 'maestro_vuelta',
      max_hold_ms: 36 * HOUR,
      eth_price: 2010.5,
    },
    {
      product: 'PF_XBTUSD',
      trade_no: 1,
      side: 'SHORT',
      exit_ms: START + 40 * HOUR,
      net_usd: -2,
      balance_usd: 1003,
      entry_ms: START + 16 * HOUR,
      entry_price: 90_000,
      exit_price: 90_250.5,
      closed_by: 'tiempo',
      exit_reason: null,
      max_hold_ms: 36 * HOUR,
      eth_price: 1950,
    },
  ],
  ...over,
})
const account = qwenAccount(payload())!

const open = (view = account) => {
  render(<AccountBalanceView account={view} />)
  fireEvent.click(screen.getByTestId('account-balance'))
}

describe('AccountBalanceView', () => {
  it('distinguishes current equity from capital after closed operations in the compact header', () => {
    render(<AccountBalanceView account={account} compact />)
    expect(screen.getByText('Valor actual')).toBeTruthy()
    expect(screen.getByText('Realizado')).toBeTruthy()
    expect(screen.getByTestId('account-realized')).toHaveTextContent('1003,00')
    expect(screen.getByTestId('account-balance')).toHaveTextContent('1003,50')
  })

  it('shows only the formatted number, and the chart after a click', () => {
    render(<AccountBalanceView account={account} />)
    const button = screen.getByTestId('account-balance')
    expect(button.textContent).toMatch(/1003,50/)
    expect(screen.queryByTestId('account-balance-panel')).toBeNull()
    fireEvent.click(button)
    expect(screen.getByTestId('account-curve')).toBeTruthy()
    expect(screen.getAllByTestId('bar-win')).toHaveLength(1)
    expect(screen.getAllByTestId('bar-loss')).toHaveLength(1)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByTestId('account-balance-panel')).toBeNull()
  })

  it('says there are no closed operations yet', () => {
    render(
      <AccountBalanceView account={{ ...account, steps: [], openCount: 0 }} />,
    )
    fireEvent.click(screen.getByTestId('account-balance'))
    expect(screen.getByRole('status').textContent).toMatch(/Todavía no/)
  })

  it('ignores an off or malformed answer', () => {
    expect(qwenAccount({ status: 'off', reason: 'x' })).toBeNull()
    expect(qwenAccount({ status: 'ok' })).toBeNull()
  })

  it('drops the sentence under the curve: the bars speak for themselves', () => {
    open()
    expect(screen.queryByText(/Ganó \(verde\)/)).toBeNull()
    expect(screen.queryByText(/perdió \(rojo\)/)).toBeNull()
  })
})

describe('KPIs of the balance panel', () => {
  it('shows three numbers without text labels: Terminal, tener ETH, and the difference', () => {
    open()
    const terminal = screen.getByTestId('account-kpi-terminal')
    const eth = screen.getByTestId('account-kpi-eth')
    const delta = screen.getByTestId('account-kpi-delta')
    expect(plain(terminal)).toContain(plain(formatSigned(3.5)))
    expect(plain(eth)).toContain(plain(formatSigned(-50)))
    // Terminal +3,50 against ETH -50,00: ahead by 53,50.
    expect(delta).toHaveTextContent('▲')
    expect(plain(delta)).toContain(plain(formatSigned(53.5)))
    expect(terminal.textContent).not.toMatch(/Terminal|ETH/)
    expect(eth.textContent).not.toMatch(/Terminal|ETH/)
  })

  it('draws the swatches: solid for the Terminal, dashed for tener ETH', () => {
    open()
    const solid = screen
      .getByTestId('account-kpi-terminal')
      .querySelector('line')!
    const dashed = screen.getByTestId('account-kpi-eth').querySelector('line')!
    expect(solid.getAttribute('stroke-dasharray')).toBeNull()
    expect(dashed.getAttribute('stroke-dasharray')).toBeTruthy()
  })

  it('points down in red when the Terminal is behind tener ETH', () => {
    open(qwenAccount(payload({ eth_now_price: 2200 }))!)
    const delta = screen.getByTestId('account-kpi-delta')
    expect(delta).toHaveTextContent('▼')
    expect(plain(delta)).toContain(plain(formatSigned(-96.5)))
    expect(delta.className).toMatch(/text-short/)
  })

  it('says «sin dato» for ETH and the difference when the ETH price is unknown', () => {
    open(qwenAccount(payload({ eth_now_price: null }))!)
    expect(screen.getByTestId('account-kpi-eth')).toHaveTextContent('sin dato')
    expect(screen.getByTestId('account-kpi-delta')).toHaveTextContent(
      'sin dato',
    )
    expect(plain(screen.getByTestId('account-kpi-terminal'))).toContain(
      plain(formatSigned(3.5)),
    )
  })

  it('opens a tooltip with balance and % on hover and on keyboard focus, and closes it after', () => {
    open()
    const terminal = screen.getByTestId('account-kpi-terminal')
    expect(terminal.getAttribute('tabindex')).toBe('0')
    expect(screen.queryByRole('tooltip')).toBeNull()
    fireEvent.mouseEnter(terminal)
    expect(screen.getByRole('tooltip')).toHaveTextContent('1003,50')
    expect(screen.getByRole('tooltip')).toHaveTextContent('+0,4 %')
    fireEvent.mouseLeave(terminal)
    expect(screen.queryByRole('tooltip')).toBeNull()
    const eth = screen.getByTestId('account-kpi-eth')
    fireEvent.focus(eth)
    expect(screen.getByRole('tooltip')).toHaveTextContent('950,00')
    expect(screen.getByRole('tooltip')).toHaveTextContent('-5,0 %')
    fireEvent.blur(eth)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('explains the difference in its tooltip', () => {
    open()
    fireEvent.focus(screen.getByTestId('account-kpi-delta'))
    expect(screen.getByRole('tooltip').textContent).toMatch(/mejor/)
    expect(screen.getByRole('tooltip')).toHaveTextContent('53,50')
  })

  it('dates the tooltip start in Madrid time', () => {
    open()
    fireEvent.focus(screen.getByTestId('account-kpi-terminal'))
    expect(screen.getByRole('tooltip')).toHaveTextContent('2 nov, 13:00')
  })
})

describe('the two curves', () => {
  it('draws the Terminal line solid and the ETH hold dashed, with no text legend', () => {
    open()
    const curve = screen.getByTestId('account-curve')
    expect(curve.querySelectorAll('polyline')).toHaveLength(2)
    expect(
      screen
        .getByTestId('account-curve-terminal')
        .getAttribute('stroke-dasharray'),
    ).toBeNull()
    expect(
      screen.getByTestId('account-curve-eth').getAttribute('stroke-dasharray'),
    ).toBeTruthy()
    expect(curve.querySelector('text')).toBeNull()
    expect(screen.queryByText(/Saldo después de cada operación/)).toBeNull()
  })

  it('draws only the Terminal line when ETH has no start price', () => {
    open(qwenAccount(payload({ eth_start_price: null }))!)
    expect(screen.getByTestId('account-curve-terminal')).toBeTruthy()
    expect(screen.queryByTestId('account-curve-eth')).toBeNull()
  })
})

describe('review progress', () => {
  it('fills 30 slots, green for a win and red for a loss', () => {
    open()
    const slots = screen.getAllByTestId('review-slot')
    expect(slots).toHaveLength(30)
    expect(slots.slice(0, 3).map((s) => s.dataset.state)).toEqual([
      'win',
      'loss',
      'empty',
    ])
    expect(slots[0]!.className).toMatch(/bg-long/)
    expect(slots[1]!.className).toMatch(/bg-short/)
  })

  it('shows the N/30 and operations-per-day chips', () => {
    open()
    expect(screen.getByTestId('review-count')).toHaveTextContent('2/30')
    // 2 operations in 3 days.
    expect(screen.getByTestId('review-pace')).toHaveTextContent('⏱ 0,7/d')
  })

  it('tells in a tooltip how many remain and the days left, on hover and focus', () => {
    open()
    const review = screen.getByTestId('account-review')
    expect(review.getAttribute('tabindex')).toBe('0')
    fireEvent.mouseEnter(review)
    // 28 left at 0,67 per day: 42 days.
    expect(screen.getByRole('tooltip')).toHaveTextContent('28')
    expect(screen.getByRole('tooltip')).toHaveTextContent('42')
    fireEvent.mouseLeave(review)
    expect(screen.queryByRole('tooltip')).toBeNull()
    fireEvent.focus(review)
    expect(screen.getByRole('tooltip')).toHaveTextContent('28')
  })

  it('has no pace to show when the start is unknown', () => {
    open(qwenAccount(payload({ start_ms: null }))!)
    expect(screen.getByTestId('review-pace')).toHaveTextContent('⏱ —')
  })
})

describe('the card of each operation bar', () => {
  const bars = () => [
    ...screen.queryAllByTestId('bar-win'),
    ...screen.queryAllByTestId('bar-loss'),
  ]

  it('opens on hover with side, net, hold against the cap, Madrid times, prices and the reason', () => {
    open()
    const [win] = screen.getAllByTestId('bar-win')
    expect(win!.getAttribute('tabindex')).toBe('0')
    fireEvent.mouseEnter(win!)
    const card = screen.getByRole('tooltip')
    expect(screen.getByTestId('op-side')).toHaveTextContent('LONG')
    expect(plain(screen.getByTestId('op-net'))).toContain(
      plain(formatSigned(5)),
    )
    expect(screen.getByTestId('op-net').className).toMatch(/text-long/)
    // 14 h of a 36 h cap.
    expect(screen.getByTestId('op-hold-fill').getAttribute('style')).toContain(
      '38.8',
    )
    expect(card).toHaveTextContent('14,0 h')
    expect(card).toHaveTextContent('2 nov, 13:00')
    expect(card).toHaveTextContent('3 nov, 03:00')
    expect(card).toHaveTextContent('2000,00')
    expect(card).toHaveTextContent('2010,50')
    expect(screen.getByTestId('op-reason')).toHaveTextContent('↺')
    expect(screen.getByTestId('op-reason')).toHaveTextContent('vuelta')
    expect(card.textContent).not.toMatch(/UTC/)
  })

  it('opens on keyboard focus too, shows SHORT in red and the time cap as ⏲', () => {
    open()
    const loss = screen.getAllByTestId('bar-loss')[0]!
    fireEvent.focus(loss)
    expect(screen.getByTestId('op-side')).toHaveTextContent('SHORT')
    expect(screen.getByTestId('op-side').className).toMatch(/text-short/)
    expect(screen.getByTestId('op-net').className).toMatch(/text-short/)
    expect(screen.getByTestId('op-reason')).toHaveTextContent('⏲')
    expect(screen.getByTestId('op-reason')).toHaveTextContent('tiempo')
    // 24 h of 36 h.
    expect(screen.getByTestId('op-hold-fill').getAttribute('style')).toContain(
      '66.6',
    )
    fireEvent.blur(loss)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('writes an unusual reason as text and leaves out what the answer lacks', () => {
    const odd = qwenAccount(
      payload({
        steps: [
          {
            product: 'PF_ETHUSD',
            trade_no: 9,
            side: 'LONG',
            exit_ms: START + HOUR,
            net_usd: 1,
            balance_usd: 1001,
            closed_by: 'stop',
          },
        ],
      }),
    )!
    open(odd)
    fireEvent.mouseEnter(bars()[0]!)
    expect(screen.getByTestId('op-reason')).toHaveTextContent('stop')
    expect(screen.queryByTestId('op-hold-fill')).toBeNull()
  })

  it('keeps one bar per operation', () => {
    open()
    expect(bars()).toHaveLength(2)
  })
})
