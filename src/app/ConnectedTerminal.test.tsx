import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import ConnectedTerminal from './ConnectedTerminal.tsx'

vi.mock('../features/price-chart/presentation/PriceChart.tsx', () => ({
  default: () => null,
}))

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('ConnectedTerminal', () => {
  it('shows a connected paper state from validated backend data', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        const body = url.includes('/market/ohlc')
          ? {
              candles: [
                {
                  timestamp: 1_700_000_000_000,
                  open: 10,
                  high: 12,
                  low: 9,
                  close: 11,
                  volume: 2,
                },
              ],
            }
          : url.includes('/paper-trading/status')
            ? {
                enabled: true,
                running: true,
                account: {
                  balance_eur: 10,
                  btc_balance: 0,
                  total_equity_eur: 10,
                },
                execution_summary: {
                  total_signals: 0,
                  gate_rejections: 0,
                  executed_trades: 0,
                  closed_pnl_eur: 0,
                },
              }
            : url.includes('/collector/status')
              ? { enabled: true, running: true, newest_candle_iso: null }
              : { orders: [], strategies: [], positions: [] }
        return { ok: true, status: 200, json: async () => body }
      }),
    )
    render(<ConnectedTerminal />)
    expect(await screen.findByText('Simulación paper')).toBeInTheDocument()
    expect(screen.getByText('CONECTADO · PAPER')).toBeInTheDocument()
    expect(
      screen.getAllByText((_, element) => element?.textContent === '10,00 €')
        .length,
    ).toBeGreaterThan(0)
    expect(
      screen.queryByText(/datos simulados|modo demo/i),
    ).not.toBeInTheDocument()
  })

  it('does not substitute demo data when the backend is unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })),
    )
    render(<ConnectedTerminal />)
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'No se pudo cargar',
    )
    expect(
      screen.getByRole('button', { name: 'Reintentar' }),
    ).toBeInTheDocument()
  })
})
