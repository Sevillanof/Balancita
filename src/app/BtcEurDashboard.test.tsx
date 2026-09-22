import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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

vi.mock('./intelligence/useNewsStream', () => newsStreamMock)

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

async function waitForReady(): Promise<void> {
  await screen.findByRole('region', { name: 'Gráfico BTC-EUR' })
}

describe('BtcEurDashboard main screen (Phase 1)', () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.clearAllMocks()
    newsStreamMock.useNewsStream.mockReturnValue({
      status: 'ready',
      items: NEWS_FIXTURES,
      error: null,
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('renders ONLY the six wireframe areas A–F', async () => {
    renderDashboard(readyProvider())
    await waitForReady()

    // A. Brand/title with the nested BTC-EUR summary.
    const brand = screen.getByRole('banner')
    expect(
      within(brand).getByRole('heading', { name: 'Balancita (BTC/EUR)' }),
    ).toBeInTheDocument()
    expect(
      within(brand).getByRole('region', { name: 'Resumen BTC-EUR' }),
    ).toBeInTheDocument()
    expect(
      document.querySelector('.dashboard__grid > .summary'),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Simulación' }),
    ).not.toBeInTheDocument()
    // B. Available money from the local paper ledger.
    expect(
      screen.getByRole('region', { name: 'Dinero disponible' }),
    ).toBeInTheDocument()
    // C. Chart without redundant visual titles.
    expect(
      screen.getByRole('region', { name: 'Gráfico BTC-EUR' }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('heading', { name: 'BTC-EUR' }),
    ).not.toBeInTheDocument()
    expect(screen.queryByText('Gráfico dominante')).not.toBeInTheDocument()
    expect(screen.queryByText('Velas BTC-EUR (mock)')).not.toBeInTheDocument()
    // D. Real-time news without a redundant heading.
    expect(
      screen.getByRole('region', { name: 'Noticias BTC-EUR' }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('heading', { name: 'NOTICIAS EN TIEMPO REAL' }),
    ).not.toBeInTheDocument()
    expect(
      document.querySelector('#dashboard-news-title'),
    ).not.toBeInTheDocument()
    // E. Buy / sell / auto control.
    expect(screen.getByRole('button', { name: 'Comprar' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Vender' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Auto Trade' })).toBeDisabled()
    // F. BTC-EUR instrument summary.
    expect(
      screen.getByRole('region', { name: 'Resumen BTC-EUR' }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('heading', {
        name: 'Información general del instrumento en este caso (BTC-EUR)',
      }),
    ).not.toBeInTheDocument()
  })

  it('renders exactly the three action buttons', async () => {
    renderDashboard(readyProvider())
    await waitForReady()

    const actions = screen.getByRole('group', {
      name: 'Acciones de trading',
    })
    expect(within(actions).getAllByRole('button')).toHaveLength(3)
    expect(
      within(actions).getByRole('button', { name: 'Comprar' }),
    ).toBeEnabled()
    expect(
      within(actions).getByRole('button', { name: 'Vender' }),
    ).toBeEnabled()
    expect(
      within(actions).getByRole('button', { name: 'Auto Trade' }),
    ).toBeDisabled()
    expect(
      screen.queryByRole('button', { name: 'Simulación' }),
    ).not.toBeInTheDocument()
  })

  it('does not render any surface that is outside the wireframe', async () => {
    renderDashboard(readyProvider())
    await waitForReady()

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
    await waitForReady()

    const news = screen.getByRole('region', { name: 'Noticias BTC-EUR' })
    expect(within(news).getAllByRole('listitem')).toHaveLength(
      NEWS_FIXTURES.length,
    )
  })

  it('derives the BTC-EUR summary in area F from the mock quote', async () => {
    const provider = readyProvider()
    renderDashboard(provider)
    await waitForReady()

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
    expect(
      [...summary.querySelectorAll('dt')].map((label) => label.textContent),
    ).toEqual(['Última cotización', 'Variación', 'Máximo'])
    expect(within(summary).queryByText('Mínimo')).not.toBeInTheDocument()
    expect(within(summary).queryByText('Volumen')).not.toBeInTheDocument()
    await waitFor(() =>
      expect(within(summary).getByText('€60,000.00')).toBeInTheDocument(),
    )
  })

  it('updates the chart latest close from the subscribed BTC-EUR quote', async () => {
    const provider = readyProvider()
    renderDashboard(provider)
    await waitForReady()

    act(() =>
      provider.emit(
        makeQuote({
          instrumentId: 'BTC-EUR',
          price: 60_123,
          timestamp: '2024-01-01T00:00:30.000Z',
        }),
      ),
    )

    expect(mocks.series.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ close: 60_123 }),
    )
  })

  it('keeps the order flow reachable behind the disabled auto control', async () => {
    const user = userEvent.setup()
    renderDashboard(readyProvider())
    await waitForReady()

    expect(
      screen.queryByRole('button', { name: 'Vista previa de la orden' }),
    ).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Auto Trade' })).toBeDisabled()

    await user.click(screen.getByRole('button', { name: 'Comprar' }))

    expect(
      await screen.findByRole('button', { name: 'Vista previa de la orden' }),
    ).toBeInTheDocument()
  })

  it('opens the paper trading flow from Comprar and Vender, preselecting the side', async () => {
    const user = userEvent.setup()
    renderDashboard(readyProvider())
    await waitForReady()

    await user.click(screen.getByRole('button', { name: 'Comprar' }))
    const buyForm = await screen.findByRole('form', {
      name: 'Orden del simulador',
    })
    expect(
      within(buyForm).getByRole('button', { name: 'Comprar' }),
    ).toHaveAttribute('aria-pressed', 'true')
    expect(
      within(buyForm).getByRole('button', { name: 'Vender' }),
    ).toHaveAttribute('aria-pressed', 'false')

    await user.click(screen.getByRole('button', { name: 'Cerrar' }))
    await waitFor(() =>
      expect(
        screen.queryByRole('form', { name: 'Orden del simulador' }),
      ).not.toBeInTheDocument(),
    )

    await user.click(screen.getByRole('button', { name: 'Vender' }))
    const sellForm = await screen.findByRole('form', {
      name: 'Orden del simulador',
    })
    expect(
      within(sellForm).getByRole('button', { name: 'Vender' }),
    ).toHaveAttribute('aria-pressed', 'true')
    expect(
      within(sellForm).getByRole('button', { name: 'Comprar' }),
    ).toHaveAttribute('aria-pressed', 'false')
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
    await waitForReady()

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
    expect(screen.getByTestId('chart-freshness')).toHaveTextContent(
      'Mercado stale',
    )
  })

  it('uses the server news stream without opening a browser fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('network is disabled in tests')
    })

    renderDashboard(readyProvider())
    await waitForReady()

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(newsStreamMock.useNewsStream).toHaveBeenCalled()
  })
})
