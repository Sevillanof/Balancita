import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import TerminalChartPanel from './TerminalChartPanel.tsx'

const state = vi.hoisted(() => ({ remote: null as unknown }))

vi.mock('../infrastructure/terminal-chart-client.ts', async (original) => ({
  ...(await original<object>()),
  useTerminalChart: () => state.remote,
}))
vi.mock('./ApprovedTerminalChart.tsx', () => ({
  default: () => <div data-testid="chart" />,
}))

const candle = (time: number) => ({
  time,
  open: 100,
  high: 101,
  low: 99,
  close: 100,
  volume: 1,
})
const flow = (extra: Record<string, number | null>) => ({
  time_ms: 1_000_000,
  buy_volume: null,
  sell_volume: null,
  liquidation_volume: null,
  open_interest: null,
  long_percent: null,
  top_long_percent: null,
  premium_bp: null,
  volatility: null,
  ...extra,
})

function panel(live = true, product?: string, viewport = false) {
  return (
    <TerminalChartPanel
      candles={[candle(1_000), candle(1_060)]}
      markers={[]}
      selectedId=""
      onSelect={() => undefined}
      apiBase="http://x"
      live={live}
      viewport={viewport}
      product={product}
      ticker={null}
      position={{}}
      orders={[]}
    />
  )
}

beforeEach(() => {
  state.remote = null
  vi.useFakeTimers()
  localStorage.setItem(
    'balancita.terminal-chart.v1',
    JSON.stringify({
      intervalMs: 60_000,
      overlays: [],
      panes: ['positioning', 'premium'],
    }),
  )
})

describe('chart controls and market facts', () => {
  it('keeps all timeframes, indicators and market facts accessible in bounded mode', () => {
    render(panel(true, 'PF_ETHUSD', true))
    fireEvent.change(screen.getByRole('combobox', { name: 'Temporalidad' }), {
      target: { value: '300000' },
    })
    expect(screen.getByText('Cargando velas de 5m…')).toBeTruthy()
    fireEvent.click(
      screen.getByRole('button', { name: 'Indicadores y paneles' }),
    )
    fireEvent.click(screen.getByLabelText('EMA 9'))
    expect(screen.getByLabelText('EMA 9')).toBeChecked()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Datos del mercado' }))
    const dialog = screen.getByRole('dialog', { name: 'Datos del mercado' })
    expect(dialog).toHaveTextContent('Funding (por hora)')
    expect(dialog).toHaveTextContent('Bid / ask')
    expect(dialog).toHaveTextContent('Cuentas en largo')
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: 'Leyenda del gráfico' }))
    expect(
      screen.getByRole('dialog', { name: 'Leyenda del gráfico' }),
    ).toHaveTextContent('entrada larga')
  })
  it('keeps the two market fact groups and their source labels', () => {
    render(panel())
    const compact = screen.getByLabelText('Datos del mercado')
    expect(within(compact).getByText('Cambio 24 h')).toBeTruthy()
    expect(within(compact).getByText('Funding (por hora)')).toBeTruthy()
    expect(within(compact).getByText('Bid / ask')).toBeTruthy()
    expect(within(compact).getByText('Interés abierto')).toBeTruthy()
    const more = screen.getByLabelText('Más datos del mercado')
    expect(within(more).getByText('Máx / mín 24 h')).toBeTruthy()
    expect(within(more).getByText('Cuentas en largo')).toBeTruthy()
    expect(screen.getByLabelText('Leyenda del gráfico')).toHaveTextContent(
      'entrada larga',
    )
  })

  it('preserves indicator and pane selection and persists both settings', () => {
    render(panel())
    fireEvent.click(screen.getByLabelText('EMA 9'))
    fireEvent.click(screen.getByLabelText('RSI 14'))
    expect(screen.getByLabelText('EMA 9')).toBeChecked()
    expect(screen.getByLabelText('RSI 14')).toBeChecked()
    expect(
      JSON.parse(localStorage.getItem('balancita.terminal-chart.v1')!),
    ).toEqual({
      intervalMs: 60_000,
      overlays: ['ema9'],
      panes: ['positioning', 'premium', 'rsi'],
    })
  })

  it('keeps the selected timeframe pressed and reports missing candles explicitly', () => {
    render(panel())
    fireEvent.click(screen.getByRole('button', { name: '5m' }))
    expect(screen.getByRole('button', { name: '5m' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(screen.getByRole('button', { name: '1m' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
    expect(screen.getByText('Cargando velas de 5m…')).toHaveAttribute(
      'role',
      'status',
    )
    expect(screen.queryByTestId('chart')).toBeNull()
  })

  it('keeps unavailable live-only panels disabled in historical mode', () => {
    render(panel(false))
    for (const name of [
      'Compra/venta',
      'Interés abierto',
      'Liquidaciones',
      'Long/short',
      'Prima perpetuo-contado (pb)',
    ])
      expect(screen.getByLabelText(name)).toBeDisabled()
    expect(screen.getByLabelText('RSI 14')).toBeEnabled()
    expect(screen.getByLabelText('EMA 9')).toBeEnabled()
    expect(
      screen.getByText(/solo están disponibles con el mercado real/),
    ).toBeTruthy()
    expect(screen.queryByText('Cargando Long/short…')).toBeNull()
  })
})
afterEach(() => {
  vi.useRealTimers()
  localStorage.clear()
})

describe('terminal chart panes still loading', () => {
  it('shows «Cargando …» for every enabled pane while the series has not arrived', () => {
    state.remote = null
    render(panel())
    expect(screen.getByText('Cargando Long/short…')).toBeTruthy()
    expect(
      screen.getByText('Cargando Prima perpetuo-contado (pb)…'),
    ).toBeTruthy()
  })

  it('keeps «Cargando» for ETH panes (captured alongside BTC) and says at once when another product has no capture', () => {
    state.remote = { candles: [], flow: [], depth: null, ticker: null }
    const { unmount } = render(panel(true, 'PF_ETHUSD'))
    expect(screen.getByText('Cargando Long/short…')).toBeTruthy()
    expect(screen.queryByText(/no hay datos de ETH/)).toBeNull()
    unmount()

    render(panel(true, 'PF_SOLUSD'))
    expect(
      screen.getByText(
        'Long/short solo se captura para ETH y BTC: no hay datos de SOL',
      ),
    ).toBeTruthy()
    expect(screen.queryByText('Cargando Long/short…')).toBeNull()
  })

  it('keeps «Cargando» for a pane the server has no points for yet, then says «Sin datos»', () => {
    state.remote = {
      candles: [],
      flow: [flow({ long_percent: 60 })],
      depth: null,
      ticker: null,
    }
    render(panel())
    // Long/short has points: no placeholder. The premium is still being downloaded.
    expect(screen.queryByText('Cargando Long/short…')).toBeNull()
    expect(
      screen.getByText('Cargando Prima perpetuo-contado (pb)…'),
    ).toBeTruthy()
    act(() => {
      vi.advanceTimersByTime(91_000)
    })
    expect(
      screen.getByText('Sin datos de Prima perpetuo-contado (pb) por ahora'),
    ).toBeTruthy()
  })
})
