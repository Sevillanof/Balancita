import { act, render, screen } from '@testing-library/react'
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

function panel() {
  return (
    <TerminalChartPanel
      candles={[candle(1_000), candle(1_060)]}
      markers={[]}
      selectedId=""
      onSelect={() => undefined}
      apiBase="http://x"
      live
      ticker={null}
      position={{}}
      orders={[]}
    />
  )
}

beforeEach(() => {
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
