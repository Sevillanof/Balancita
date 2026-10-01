import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import ConnectedTerminal from './ConnectedTerminal.tsx'

const chartProbe = vi.hoisted(() => ({
  candleTimes: [] as number[],
  candleVolumes: [] as number[],
  markers: [] as Array<{
    id: string
    time: number
    type: string
    label: string
  }>,
}))

vi.mock(
  '../features/trading-view/presentation/ApprovedTerminalChart.tsx',
  () => ({
    default: (props: {
      candles: Array<{ time: number; volume: number }>
      markers: Array<{ id: string; time: number; type: string; label: string }>
    }) => {
      chartProbe.candleTimes = props.candles.map((candle) => candle.time)
      chartProbe.candleVolumes = props.candles.map((candle) => candle.volume)
      chartProbe.markers = props.markers
      return (
        <div
          data-testid="approved-chart-renderer"
          className="demo-terminal__chart"
        />
      )
    },
  }),
)

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
              : url.includes('/paper-trading/decisions')
                ? {
                    decisions: [
                      {
                        id: 'native-decision-01',
                        instrumentId: 'BTC-EUR',
                        eventTime: 1_700_000_030_000,
                        receivedAt: 1_700_000_031_000,
                        strategyId: 'native-paper-fixture',
                        strategyVersion: 'native-v1',
                        direction: 'long',
                        outcome: 'pending',
                        reasonCode: null,
                        sessionId: null,
                        reason: 'Declared API fixture decision; not a fill.',
                        conditions: [],
                      },
                    ],
                  }
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
    const approvedLayout = screen.getByTestId('approved-terminal-layout')
    expect(approvedLayout).toHaveClass('demo-terminal__grid')
    expect(
      approvedLayout.querySelector(
        ':scope > [aria-label="Gráfico de velas BTC-EUR"]',
      ),
    ).not.toBeNull()
    expect(
      approvedLayout.querySelector(
        ':scope > [aria-label="Decisiones del motor"]',
      ),
    ).not.toBeNull()
    expect(screen.getByTestId('approved-trading-header')).toBeInTheDocument()
    expect(screen.getByTestId('approved-market-row')).toBeInTheDocument()
    expect(screen.getByTestId('approved-chart-toolbar')).toBeInTheDocument()
    expect(screen.getByTestId('approved-portfolio-tables')).toBeInTheDocument()
    expect(
      screen
        .getByLabelText('Balancita, volver a la aplicación')
        .querySelector('.demo-shell__brand-mark'),
    ).not.toBeNull()
    expect(approvedLayout.querySelector('.demo-terminal__chart')).not.toBeNull()
    expect(screen.getByTestId('approved-chart-renderer')).toBeInTheDocument()
    expect(chartProbe.candleTimes).toEqual([1_699_999_980])
    expect(chartProbe.candleVolumes).toEqual([2])
    expect(chartProbe.markers).toEqual([
      {
        id: 'native-decision-01',
        time: 1_700_000_030,
        type: 'decision',
        direction: 'long',
        label: 'PEND',
        decisionStatus: 'pending',
      },
    ])
    expect(
      screen.getByText('Declared API fixture decision; not a fill.'),
    ).toBeInTheDocument()
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
