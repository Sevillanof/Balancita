// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import QwenTradesPanel from './QwenTradesPanel.tsx'
import { qwenTradesNotice, signedUsd } from './qwen-trades-text.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function answer(body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => body })),
  )
}

describe('QwenTradesPanel', () => {
  it('shows the open trade with its result now and the closed ones with their net', async () => {
    answer({
      status: 'ok',
      trades: [
        {
          product: 'PF_XBTUSD',
          trade_no: 2,
          status: 'open',
          side: 'SHORT',
          entry_ms: 1_700_000_000_000,
          entry_price: '100',
          net_usd: '0.25',
        },
        {
          product: 'PF_XBTUSD',
          trade_no: 1,
          status: 'closed',
          side: 'LONG',
          entry_ms: 1_699_000_000_000,
          exit_ms: 1_699_010_000_000,
          net_usd: '-0.40',
          closed_by: 'stop',
          hold_min: 90,
          funding_status: 'partial',
        },
      ],
    })
    render(<QwenTradesPanel product="PF_XBTUSD" enabled />)
    const open = await screen.findByTestId('qwen-open-trade')
    expect(open.textContent).toMatch(/corta/)
    expect(open.textContent).toMatch(/\+0,25/)
    const closed = screen.getByTestId('qwen-closed-trade')
    expect(closed.textContent).toMatch(/LARGO/)
    expect(closed.textContent).toMatch(/saltó el stop automático/)
    expect(closed.textContent).toMatch(/1 h 30 min/)
    expect(closed.textContent).toMatch(/funding todavía incompleto/)
  })

  it('says plainly why there is nothing to show', async () => {
    answer({ status: 'off', reason: 'file_not_found' })
    render(<QwenTradesPanel product="PF_XBTUSD" enabled />)
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toMatch(
        /Qwen no está operando/,
      ),
    )
    expect(qwenTradesNotice({ state: 'ok' }, 0)).toMatch(/todavía no operó/)
    expect(qwenTradesNotice({ state: 'loading' }, 0)).toBeNull()
    expect(qwenTradesNotice({ state: 'ok' }, 2)).toBeNull()
    expect(signedUsd(null)).toBe('no disponible')
  })

  it('draws nothing and asks nothing when the live gateway is not in use', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { container } = render(
      <QwenTradesPanel product="PF_XBTUSD" enabled={false} />,
    )
    expect(container.textContent).toBe('')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
