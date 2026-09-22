import { act, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AnalysisProvider } from '../domain/analysis'
import type {
  Candle,
  Instrument,
  MarketDataProvider,
} from '../domain/market-data'
import { LocalStoragePortfolioRepository } from '../portfolio/local-storage-portfolio-repository'
import {
  FakeMarketDataProvider,
  WATCHLIST_INSTRUMENTS,
  makeCandle,
  makeQuote,
} from '../test/fake-market-data-provider'
import BtcEurDashboard from './BtcEurDashboard'
import type { UseAlertsResult } from './alerts/useAlerts'
import { NEWS_FIXTURES } from './intelligence/news-fixtures'

const mocks = vi.hoisted(() => {
  const series = { setData: vi.fn() }
  const chart = { addSeries: vi.fn(() => series), remove: vi.fn() }
  const createChart = vi.fn()
  return { createChart, chart, series }
})

vi.mock('lightweight-charts', () => ({
  ColorType: { Solid: 'solid' },
  CandlestickSeries: {},
  createChart: (...args: unknown[]) => mocks.createChart(...args),
}))

mocks.createChart.mockReturnValue(mocks.chart)

class PendingProvider implements MarketDataProvider {
  getInstruments(): Promise<Instrument[]> {
    return new Promise(() => {})
  }

  getHistory(): Promise<Candle[]> {
    return new Promise(() => {})
  }

  subscribe(): () => void {
    return () => {}
  }
}

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

function readyProvider(): FakeMarketDataProvider {
  const historyByInstrument = Object.fromEntries(
    WATCHLIST_INSTRUMENTS.map((instrument) => [
      instrument.id,
      [makeCandle({ time: '2024-01-01T00:00:00.000Z' })],
    ]),
  )
  return new FakeMarketDataProvider(WATCHLIST_INSTRUMENTS, {
    historyByInstrument,
  })
}

function renderDashboard(provider: MarketDataProvider) {
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

describe('BtcEurDashboard main screen (Phase 1)', () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.clearAllMocks()
  })

  it('renders the six areas A–F in the one-screen grid', async () => {
    renderDashboard(readyProvider())
    await screen.findByRole('form', { name: 'Orden del simulador' })

    // A. Brand/title
    expect(
      screen.getByRole('heading', { name: 'Balancita (BTC/EUR)' }),
    ).toBeInTheDocument()
    // B. Available money
    expect(
      screen.getByRole('region', { name: 'Dinero disponible' }),
    ).toBeInTheDocument()
    // C. Dominant chart
    expect(
      screen.getByRole('region', { name: 'Gráfico BTC-EUR' }),
    ).toBeInTheDocument()
    // D. News
    expect(
      screen.getByRole('region', { name: 'Noticias BTC-EUR' }),
    ).toBeInTheDocument()
    // E. Buy / sell / auto control
    expect(screen.getByRole('button', { name: /Auto/ })).toBeInTheDocument()
    // F. BTC-EUR summary
    expect(
      screen.getByRole('region', { name: 'Resumen BTC-EUR' }),
    ).toBeInTheDocument()
  })

  it('shows the local paper ledger available EUR in area B', async () => {
    renderDashboard(readyProvider())

    const available = await screen.findByRole('region', {
      name: 'Dinero disponible',
    })
    await waitFor(() =>
      expect(within(available).getByText('€10,000.00')).toBeInTheDocument(),
    )
  })

  it('renders the local news fixtures in area D', async () => {
    renderDashboard(readyProvider())
    await screen.findByRole('form', { name: 'Orden del simulador' })

    const news = screen.getByRole('region', { name: 'Noticias BTC-EUR' })
    expect(within(news).getAllByRole('listitem')).toHaveLength(
      NEWS_FIXTURES.length,
    )
  })

  it('derives the BTC-EUR summary in area F from the mock quote', async () => {
    const provider = readyProvider()
    renderDashboard(provider)
    await screen.findByRole('form', { name: 'Orden del simulador' })

    act(() =>
      provider.emit(
        makeQuote({
          instrumentId: 'BTC-EUR',
          price: 60_000,
          change: 120,
          changePercent: 0.2,
        }),
      ),
    )

    const summary = screen.getByRole('region', { name: 'Resumen BTC-EUR' })
    await waitFor(() =>
      expect(within(summary).getByText('€60,000.00')).toBeInTheDocument(),
    )
  })

  it('keeps the paper trading flow with a disabled auto control in area E', async () => {
    renderDashboard(readyProvider())
    await screen.findByRole('form', { name: 'Orden del simulador' })

    expect(
      screen.getByRole('button', { name: 'Vista previa de la orden' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Auto/ })).toBeDisabled()
  })

  it('shows a loading state while keeping the brand shell (no layout jump)', () => {
    renderDashboard(new PendingProvider())

    expect(
      screen.getByRole('heading', { name: 'Balancita (BTC/EUR)' }),
    ).toBeInTheDocument()
    const state = screen.getByRole('region', { name: 'Estado del dashboard' })
    expect(within(state).getByRole('status')).toHaveTextContent(
      'Cargando BTC-EUR',
    )
  })

  it('shows an error state with retry when the provider fails', async () => {
    renderDashboard(
      new FakeMarketDataProvider([], {
        getInstrumentsError: new Error('provider down'),
      }),
    )

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'No se pudo cargar BTC-EUR',
      ),
    )
    expect(
      screen.getByRole('button', { name: 'Reintentar' }),
    ).toBeInTheDocument()
  })

  it('shows an empty state when no instruments are available', async () => {
    renderDashboard(new FakeMarketDataProvider([]))

    await waitFor(() =>
      expect(
        screen.getByText(
          'BTC-EUR no está disponible en la fuente seleccionada.',
        ),
      ).toBeInTheDocument(),
    )
  })

  it('surfaces a stale quote without hiding the areas', async () => {
    const provider = readyProvider()
    renderDashboard(provider)
    await screen.findByRole('form', { name: 'Orden del simulador' })

    act(() =>
      provider.emit(makeQuote({ instrumentId: 'BTC-EUR', status: 'stale' })),
    )

    await waitFor(() =>
      expect(
        screen.getByText('Desactualizada', {
          selector: '.dashboard__quote-status',
        }),
      ).toBeInTheDocument(),
    )
  })

  it('never performs a network request while rendering', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('network is disabled in tests')
    })

    renderDashboard(readyProvider())
    await screen.findByRole('form', { name: 'Orden del simulador' })

    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })
})
