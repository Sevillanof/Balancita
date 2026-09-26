import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
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
  it('renders the TanStack strategy table, separates Brier sources, and keeps empty tabs', async () => {
    const metrics = [
      {
        ...metric('micro-trend-pullback', 'C25: Trend Pullback', 0.1234),
        total_signals: 12,
        gate_rejections: 3,
        executed_buys: 5,
        approval_rate_pct: 75,
        net_pnl_eur: 1.25,
        net_pnl_pct: 4.17,
        gross_pnl_eur: 1.5,
        total_fees_eur: 0.15,
        total_slippage_eur: 0.1,
        win_rate_pct: 60,
        profit_factor: 1.5,
        avg_holding_bars_15m: 2.5,
      },
      {
        ...metric('micro-bollinger-reversion', 'C26: Bollinger Reversion'),
        net_pnl_eur: -0.5,
      },
      metric('micro-donchian-breakout', 'C27: Donchian Breakout'),
      metric('micro-regime-adapter', 'C28: Regime Adapter'),
    ]
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      const payload = url.includes('strategies-summary')
        ? metrics
        : url.includes('/api/paper-trading/status')
          ? { stream_state: 'connected', last_processed_event_time: null }
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
    const strategyTable = await screen.findByRole('table', {
      name: 'Resumen de métricas por estrategia',
    })
    expect(strategyTable).toBeInTheDocument()
    expect(
      within(strategyTable).getByText('C25: Trend Pullback'),
    ).toBeInTheDocument()
    expect(
      within(strategyTable).getByText('C26: Bollinger Reversion'),
    ).toBeInTheDocument()
    expect(
      within(strategyTable).getByText('C27: Donchian Breakout'),
    ).toBeInTheDocument()
    expect(
      within(strategyTable).getByText('C28: Regime Adapter'),
    ).toBeInTheDocument()
    expect(strategyTable.parentElement).toHaveClass('table-scroll')
    expect(within(strategyTable).getAllByRole('row')).toHaveLength(5)
    for (const heading of [
      'Estrategia / estado',
      'Señales',
      'Rechazos Gate',
      'Compras / fills',
      'Aprobación',
      'PnL neto',
      'PnL bruto',
      'Comisiones',
      'Deslizamiento',
      'Peaje / bruto',
      'Acierto',
      'Factor de beneficio',
      'Tenencia media',
      'Brier en vivo',
      'Brier Fast Replay',
    ])
      expect(
        within(strategyTable).getByRole('columnheader', { name: heading }),
      ).toBeInTheDocument()
    const firstRow = within(strategyTable).getByRole('row', {
      name: /C25: Trend Pullback/,
    })
    expect(firstRow).toHaveTextContent('12')
    expect(firstRow).toHaveTextContent('3')
    expect(firstRow).toHaveTextContent('5')
    expect(firstRow).toHaveTextContent('75,00%')
    expect(firstRow).toHaveTextContent('1,25')
    expect(firstRow).toHaveTextContent('12,34%')
    expect(firstRow).toHaveTextContent('1,50')
    expect(firstRow).toHaveTextContent('2,50 velas')
    expect(firstRow.children[5].firstElementChild).toHaveClass(
      'strategy-analytics__positive',
    )
    expect(firstRow).toHaveTextContent('N/A')
    expect(firstRow).toHaveTextContent('0.2345 vs baseline uniforme 0.6667')
    const secondRow = within(strategyTable).getByRole('row', {
      name: /C26: Bollinger/,
    })
    expect(secondRow).toHaveTextContent('-0,50')
    expect(secondRow.children[5].firstElementChild).toHaveClass(
      'strategy-analytics__negative',
    )
    const thirdRow = within(strategyTable).getByRole('row', {
      name: /C27: Donchian/,
    })
    expect(thirdRow.children[11]).toHaveTextContent('—')
    expect(thirdRow).toHaveTextContent(
      'Sin muestras vs baseline uniforme 0.6667',
    )
    expect(screen.getByText('Sin posiciones abiertas.')).toBeInTheDocument()
    expect(screen.getByText('Flujo ascendente: connected')).toBeInTheDocument()
    expect(screen.getByLabelText('Última vela evaluada')).toHaveTextContent(
      'Sin velas procesadas',
    )
    await userEventClick(screen.getByRole('tab', { name: 'Historial cerrado' }))
    expect(screen.getByText('No hay operaciones cerradas.')).toBeInTheDocument()
    expect(
      screen.getByRole('tab', { name: 'Historial cerrado' }),
    ).toHaveAttribute('aria-selected', 'true')
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

  it('shows the exact retry badge while a poll fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes('strategies-summary'))
          return new Response('{}', { status: 503 })
        return new Response(JSON.stringify({ runs: [] }), { status: 200 })
      }),
    )
    render(<StrategyAnalyticsPanel />)
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Desconectado / Reintentando...',
    )
    expect(screen.getByLabelText('Última sincronización')).toHaveTextContent(
      'Sin sincronizar',
    )
    expect(screen.queryByText('Cargando auditoría…')).not.toBeInTheDocument()
    expect(
      screen.queryByText('Sin posiciones abiertas.'),
    ).not.toBeInTheDocument()
  })

  it('keeps a newly selected tab loading until its own positions response settles', async () => {
    let resolveClosed!: (value: Response) => void
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('strategies-summary')) return new Response('[]')
        if (url.endsWith('/api/paper-trading/status'))
          return new Response(
            JSON.stringify({
              stream_state: 'connected',
              last_processed_event_time: null,
            }),
          )
        if (url.includes('status=closed'))
          return new Promise<Response>((resolve) => {
            resolveClosed = resolve
          })
        if (url.includes('/positions?')) return new Response('[]')
        return new Response(JSON.stringify({ runs: [] }))
      }),
    )
    render(<StrategyAnalyticsPanel />)
    expect(
      await screen.findByText('Sin posiciones abiertas.'),
    ).toBeInTheDocument()
    await userEventClick(screen.getByRole('tab', { name: 'Historial cerrado' }))
    expect(screen.getByText('Cargando auditoría…')).toBeInTheDocument()
    expect(
      screen.queryByText('No hay operaciones cerradas.'),
    ).not.toBeInTheDocument()
    await act(async () => {
      resolveClosed(new Response('[]'))
    })
    expect(
      await screen.findByText('No hay operaciones cerradas.'),
    ).toBeInTheDocument()
  })
})

async function userEventClick(element: HTMLElement) {
  element.click()
  await waitFor(() => expect(element).toHaveAttribute('aria-selected', 'true'))
}
