import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import StrategyAnalyticsPanel from './StrategyAnalyticsPanel.tsx'
import PositionLifecycleTable from './PositionLifecycleTable.tsx'
import type { PaperTradePosition } from './types.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const metric = (
  strategy_id: string,
  name: string,
  toll_ratio: number | null = null,
) => ({
  strategy_id,
  name,
  total_signals: 0,
  gate_rejections: 0,
  approval_rate_pct: 0,
  executed_buys: 0,
  executed_sells: 0,
  open_positions_count: 0,
  assigned_capital_eur: 30,
  current_exposure: 'flat',
  closed_trades: 0,
  wins: 0,
  win_rate_pct: 0,
  profit_factor: null,
  avg_holding_bars_15m: 0,
  gross_pnl_eur: 0,
  avg_target_pct: 0,
  total_fees_eur: 0,
  total_slippage_eur: 0,
  net_pnl_eur: 0,
  net_pnl_pct: 0,
  toll_ratio,
  brier_score: null,
})

describe('StrategyAnalyticsPanel', () => {
  it('renders exact API arrays, four cards, Fast Replay Brier separately, and empty tabs', async () => {
    const metrics = [
      metric('micro-trend-pullback', 'C25: Trend Pullback', 0.1234),
      metric('micro-bollinger-reversion', 'C26: Bollinger Reversion'),
      metric('micro-donchian-breakout', 'C27: Donchian Breakout'),
      metric('micro-regime-adapter', 'C28: Regime Adapter'),
    ]
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      const payload = url.includes('strategies-summary')
        ? metrics
        : url.includes('/positions?')
          ? []
          : {
              runs: [
                {
                  strategyId: 'micro-trend-pullback',
                  createdAt: 100,
                  brierScoreMulticlass: 0.9999,
                },
                {
                  strategyId: 'micro-trend-pullback',
                  createdAt: 200,
                  brierScoreMulticlass: 0.2345,
                },
              ],
            }
      return new Response(JSON.stringify(payload), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock as typeof fetch)
    render(<StrategyAnalyticsPanel />)
    expect(screen.getByText('Cargando auditoría…')).toBeInTheDocument()
    expect(await screen.findByText('C25: Trend Pullback')).toBeInTheDocument()
    expect(screen.getByText('C26: Bollinger Reversion')).toBeInTheDocument()
    expect(screen.getByText('C27: Donchian Breakout')).toBeInTheDocument()
    expect(screen.getByText('C28: Regime Adapter')).toBeInTheDocument()
    const firstCard = screen.getByText('C25: Trend Pullback').closest('article')
    expect(firstCard).toHaveTextContent('Brier en vivo: N/A')
    expect(firstCard).toHaveTextContent(
      'Brier Fast Replay 0.2345 vs baseline uniforme 0.6667',
    )
    expect(firstCard).toHaveTextContent('baseline uniforme 0.6667')
    expect(firstCard).toHaveTextContent('Peaje / bruto 12.34%')
    expect(firstCard).toHaveTextContent('Factor —')
    expect(screen.getByText('Sin posiciones abiertas.')).toBeInTheDocument()
    await userEventClick(screen.getByRole('tab', { name: 'Historial cerrado' }))
    expect(screen.getByText('No hay operaciones cerradas.')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/paper-trading/strategies-summary',
      expect.any(Object),
    )
    expect(
      fetchMock.mock.calls.filter(([input]) =>
        String(input).includes('/api/replay/fast-run/history'),
      ),
    ).toHaveLength(1)
  })

  it('renders separate closed and open lifecycle column layouts', () => {
    const common: PaperTradePosition = {
      id: 8,
      strategy_id: 'micro-trend-pullback',
      status: 'CLOSED',
      entry_time: '2026-09-25T10:00:00.000Z',
      exit_time: '2026-09-25T10:15:00.000Z',
      entry_price: 100,
      exit_price: 105,
      amount_eur: 30,
      holding_bars_15m: 1,
      gross_pnl_eur: 1.4,
      fee_eur: 0.06,
      total_slippage_eur: 0.04,
      net_pnl_eur: 1.3,
      current_price: null,
      unrealized_net_pnl_eur: null,
      exit_distance_pct: null,
      exit_distance_label: 'Sin datos',
    }
    const { rerender } = render(
      <PositionLifecycleTable positions={[common]} status="closed" />,
    )
    expect(
      screen.getByRole('columnheader', { name: 'Entrada (UTC)' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('columnheader', { name: 'Salida (UTC)' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('columnheader', { name: 'Fricción total' }),
    ).toBeInTheDocument()
    expect(screen.getByText(/0,10/)).toBeInTheDocument()
    expect(screen.getByText(/1,40/)).toBeInTheDocument()
    expect(screen.getByText('1 velas de 15 min')).toBeInTheDocument()
    const open: PaperTradePosition = {
      ...common,
      status: 'OPEN',
      exit_time: null,
      exit_price: null,
      gross_pnl_eur: null,
      net_pnl_eur: null,
      current_price: 104,
      unrealized_net_pnl_eur: 1.1,
      exit_distance_pct: -0.5,
      exit_distance_label: 'Distancia al nivel de salida',
    }
    rerender(<PositionLifecycleTable positions={[open]} status="open" />)
    expect(
      screen.getByRole('columnheader', { name: 'Precio actual' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('columnheader', { name: 'PnL flotante neto' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('columnheader', { name: 'Distancia a salida' }),
    ).toBeInTheDocument()
    expect(screen.getByText(/-0,50%/)).toBeInTheDocument()
    rerender(
      <PositionLifecycleTable
        positions={[
          {
            ...open,
            exit_distance_pct: 0,
            exit_distance_label: 'Salida inmediata',
          },
        ]}
        status="open"
      />,
    )
    expect(screen.getByText('Salida inmediata (0,00%)')).toBeInTheDocument()
  })
})

async function userEventClick(element: HTMLElement) {
  element.click()
  await waitFor(() => expect(element).toHaveAttribute('aria-selected', 'true'))
}
