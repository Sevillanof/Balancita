// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { AccountBalanceView } from './AccountBalance.tsx'
import { qwenAccount } from './account-balance.ts'

afterEach(cleanup)

const account = qwenAccount({
  status: 'ok',
  start_usd: 1000,
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
      exit_ms: 1_700_000_000_000,
      net_usd: 5,
      balance_usd: 1005,
    },
    {
      product: 'PF_XBTUSD',
      trade_no: 1,
      side: 'SHORT',
      exit_ms: 1_700_000_900_000,
      net_usd: -2,
      balance_usd: 1003,
    },
  ],
})!

describe('AccountBalanceView', () => {
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
})
