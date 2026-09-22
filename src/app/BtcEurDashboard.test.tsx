import { act, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('renders ONLY the six wireframe areas A–F', async () => {
    renderDashboard(readyProvider())
    await screen.findByRole('form', { name: 'Orden del simulador' })

    // A. Brand/title, with no badges, mode label or timestamps.
    expect(
      screen.getByRole('heading', { name: 'Balancita (BTC/EUR)' }),
    ).toBeInTheDocument()
    // B. Available money from the local paper ledger.
    expect(
      screen.getByRole('region', { name: 'Dinero disponible' }),
    ).toBeInTheDocument()
    // C. Dominant chart.
    expect(
      screen.getByRole('region', { name: 'Gráfico BTC-EUR' }),
    ).toBeInTheDocument()
    // D. Real-time news, headed with the wireframe text.
    expect(
      screen.getByRole('region', { name: 'Noticias BTC-EUR' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: 'NOTICIAS EN TIEMPO REAL' }),
    ).toBeInTheDocument()
    // E. Buy / sell / auto control.
    expect(screen.getByRole('button', { name: 'Comprar' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Vender' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Auto Trading/ })).toBeDisabled()
    // F. BTC-EUR instrument summary.
    expect(
      screen.getByRole('region', { name: 'Resumen BTC-EUR' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', {
        name: 'Información general del instrumento en este caso (BTC-EUR)',
      }),
    ).toBeInTheDocument()
  })

  it('does not render any surface that is outside the wireframe', async () => {
    renderDashboard(readyProvider())
    await screen.findByRole('form', { name: 'Orden del simulador' })

    // No instrument detail.
    expect(
      screen.queryByRole('region', { name: /BTC-EUR detalle/i }),
    ).not.toBeInTheDocument()
    // No portfolio section.
    expect(
      screen.queryByRole('region', { name: 'Cartera' }),
    ).not.toBeInTheDocument()
    expect(screen.queryByText('Efectivo y posición')).not.toBeInTheDocument()
    // No alerts surface.
    expect(
      screen.queryByRole('region', { name: 'Alertas' }),
    ).not.toBeInTheDocument()
    expect(screen.queryByText('Alertas BTC-EUR')).not.toBeInTheDocument()
    // No mock watchlist lab.
    expect(
      screen.queryByRole('region', { name: 'Lista de seguimiento' }),
    ).not.toBeInTheDocument()
    expect(screen.queryByText(/Laboratorio mock/i)).not.toBeInTheDocument()
    // No intelligence status panel.
    expect(
      screen.queryByRole('heading', { name: /Estado de inteligencia/i }),
    ).not.toBeInTheDocument()
    // No disclaimer note.
    expect(screen.queryByRole('note')).not.toBeInTheDocument()
    expect(screen.queryByText(/Operación simulada\./)).not.toBeInTheDocument()
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
    expect(screen.getByRole('button', { name: /Auto Trading/ })).toBeDisabled()
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

  it('keeps every area visible when the quote turns stale', async () => {
    const provider = readyProvider()
    renderDashboard(provider)
    await screen.findByRole('form', { name: 'Orden del simulador' })

    act(() =>
      provider.emit(makeQuote({ instrumentId: 'BTC-EUR', status: 'stale' })),
    )

    expect(
      screen.getByRole('region', { name: 'Gráfico BTC-EUR' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('region', { name: 'Noticias BTC-EUR' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('region', { name: 'Resumen BTC-EUR' }),
    ).toBeInTheDocument()
  })

  it('never opens a network connection or SSE stream while rendering', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('network is disabled in tests')
    })
    const eventSourceSpy = vi.fn()
    vi.stubGlobal('EventSource', eventSourceSpy)

    renderDashboard(readyProvider())
    await screen.findByRole('form', { name: 'Orden del simulador' })

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(eventSourceSpy).not.toHaveBeenCalled()
  })
})
