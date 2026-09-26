import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AnalysisProvider } from '../../../domain/analysis.ts'
import { LocalStoragePortfolioRepository } from '../../portfolio/infrastructure/local-storage-portfolio-repository'
import {
  FakeMarketDataProvider,
  WATCHLIST_INSTRUMENTS,
  makeCandle,
} from '../../../shared/testing/fake-market-data-provider'
import BtcEurDashboard from '../../../app/BtcEurDashboard.tsx'
import type { UseAlertsResult } from '../../alerts/presentation/useAlerts'

const mocks = vi.hoisted(() => {
  const series = { setData: vi.fn(), update: vi.fn() }
  const chart = {
    addSeries: vi.fn(() => series),
    timeScale: vi.fn(() => ({ fitContent: vi.fn() })),
    remove: vi.fn(),
  }
  const createChart = vi.fn()
  return { createChart, chart, series }
})

const newsStreamMock = vi.hoisted(() => ({ useNewsStream: vi.fn() }))

vi.mock('lightweight-charts', () => ({
  ColorType: { Solid: 'solid' },
  CandlestickSeries: {},
  createChart: (...args: unknown[]) => mocks.createChart(...args),
}))

vi.mock('../intelligence/useNewsStream', () => newsStreamMock)

mocks.createChart.mockReturnValue(mocks.chart)

function fakeAlerts(): UseAlertsResult {
  return {
    status: 'empty',
    alerts: [],
    instruments: new Map(),
    loadError: null,
    operationError: null,
    retry: () => {},
    reset: () => {},
    create: async () => false,
    remove: async () => false,
    acknowledge: async () => false,
    triggered: [],
  }
}

const noopAnalysis: AnalysisProvider = {
  analyze: () => new Promise(() => {}),
}

function renderDashboard() {
  const historyByInstrument = Object.fromEntries(
    WATCHLIST_INSTRUMENTS.map((instrument) => [
      instrument.id,
      [makeCandle({ time: '2024-01-01T00:00:00.000Z' })],
    ]),
  )
  const provider = new FakeMarketDataProvider(WATCHLIST_INSTRUMENTS, {
    historyByInstrument,
  })
  return render(
    <BtcEurDashboard
      provider={provider}
      labProvider={new FakeMarketDataProvider(WATCHLIST_INSTRUMENTS)}
      portfolioRepository={new LocalStoragePortfolioRepository()}
      alerts={fakeAlerts()}
      analysis={noopAnalysis}
      analysisMode="local"
      dataMode="simulated"
    />,
  )
}

describe('Simulaciones navigation', () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.clearAllMocks()
    newsStreamMock.useNewsStream.mockReturnValue({
      status: 'ready',
      items: [],
      error: null,
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 404 })),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('shows an enabled Simulaciones button and the disabled automation switch during warmup', async () => {
    renderDashboard()
    await screen.findByRole('region', { name: 'Gráfico BTC-EUR' })
    await userEvent
      .setup()
      .click(screen.getByRole('tab', { name: 'Estrategias' }))

    const actions = screen.getByRole('group', {
      name: 'Acciones de trading',
    })
    const buttons = within(actions).getAllByRole('button')
    expect(buttons.map((button) => button.textContent)).toEqual([
      'Comprar',
      'Vender',
      'Simulaciones',
    ])
    expect(
      within(actions).getByRole('switch', {
        name: 'Trading automático simulado',
      }),
    ).toBeDisabled()
    expect(
      within(actions).getByRole('button', { name: 'Simulaciones' }),
    ).toBeEnabled()
  })

  it('opens the strategy visualization on click and closes it on a second click', async () => {
    const user = userEvent.setup()
    renderDashboard()
    await screen.findByRole('region', { name: 'Gráfico BTC-EUR' })
    await user.click(screen.getByRole('tab', { name: 'Estrategias' }))

    const toggle = screen.getByRole('button', { name: 'Simulaciones' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(
      screen.queryByRole('region', { name: 'Simulaciones BTC-EUR' }),
    ).not.toBeInTheDocument()

    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await waitFor(() =>
      expect(
        screen.getByRole('region', { name: 'Simulaciones BTC-EUR' }),
      ).toBeInTheDocument(),
    )
    expect(
      screen.getByText(/pnpm --dir server simulations:run/),
    ).toBeInTheDocument()

    await user.click(toggle)
    expect(
      screen.queryByRole('region', { name: 'Simulaciones BTC-EUR' }),
    ).not.toBeInTheDocument()
  })

  it('degrades a fetch failure to the error state with retry', async () => {
    const user = userEvent.setup()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down')
      }),
    )
    renderDashboard()
    await screen.findByRole('region', { name: 'Gráfico BTC-EUR' })
    await user.click(screen.getByRole('tab', { name: 'Estrategias' }))

    await user.click(screen.getByRole('button', { name: 'Simulaciones' }))
    await waitFor(() =>
      expect(
        screen.getByText('No se pudieron cargar las simulaciones.'),
      ).toBeInTheDocument(),
    )
    expect(
      screen.getByRole('button', { name: /reintentar/i }),
    ).toBeInTheDocument()
  })
})
