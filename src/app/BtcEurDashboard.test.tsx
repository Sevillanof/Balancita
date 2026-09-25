import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AnalysisProvider } from '../domain/analysis.ts'
import type {
  Candle,
  Instrument,
  MarketDataProvider,
} from '../features/market-data/domain/market-data.ts'
import { LocalStoragePortfolioRepository } from '../features/portfolio/infrastructure/local-storage-portfolio-repository.ts'
import {
  FakeMarketDataProvider,
  WATCHLIST_INSTRUMENTS,
  makeCandle,
  makeQuote,
} from '../shared/testing/fake-market-data-provider.ts'
import BtcEurDashboard from './BtcEurDashboard.tsx'
import type { UseAlertsResult } from '../features/alerts/presentation/useAlerts.ts'
import { NEWS_FIXTURES } from '../features/news/presentation/news-fixtures.ts'

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

vi.mock('../features/news/presentation/useNewsStream.ts', () => newsStreamMock)

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
      stream: {
        status: 'ready',
        snapshot: null,
        error: null,
        reconnectAttempt: 0,
        clientReceivedAtMs: 1_800_000_000_000,
        transportStatus: 'reconnecting',
      },
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('renders ONLY the six wireframe areas A–F', async () => {
    renderDashboard(readyProvider())
    await waitForReady()

    const chartMode = screen.getByRole('group', { name: 'Modo de gráfico' })
    expect(
      within(chartMode).getByRole('button', {
        name: 'Fast Replay Histórico',
      }),
    ).toBeInTheDocument()

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
    expect(
      screen.getByRole('switch', { name: 'Trading automático simulado' }),
    ).toBeDisabled()
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

  it('shows OHLC ingestion independently from the optional intelligence WebSocket', async () => {
    const provider = readyProvider()
    renderDashboard(provider)
    await waitForReady()

    const status = screen.getByRole('region', { name: 'Estado de servicios' })
    expect(status).toHaveTextContent('Ingesta de velas OHLC · Kraken')
    expect(status).toHaveTextContent('Pausada')
    expect(status).toHaveTextContent('WebSocket de inteligencia de mercado')
    expect(status).toHaveTextContent('Inactivo (Opcional)')
  })

  it('renders exactly the three action buttons', async () => {
    renderDashboard(readyProvider())
    await waitForReady()

    const actions = screen.getByRole('group', {
      name: 'Acciones de trading',
    })
    // Comprar / Vender / Auto Trade stay untouched; Simulaciones is the
    // additive fourth control opening the strategy visualization.
    expect(within(actions).getAllByRole('button')).toHaveLength(3)
    expect(
      within(actions).getByRole('button', { name: 'Comprar' }),
    ).toBeEnabled()
    expect(
      within(actions).getByRole('button', { name: 'Vender' }),
    ).toBeEnabled()
    expect(
      within(actions).getByRole('switch', {
        name: 'Trading automático simulado',
      }),
    ).toBeDisabled()
    expect(
      within(actions).getByRole('button', { name: 'Simulaciones' }),
    ).toBeEnabled()
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

  it('opens an accessible empty order-history popover and dismisses it with Escape', async () => {
    const user = userEvent.setup()
    renderDashboard(readyProvider())
    await waitForReady()

    const balance = await screen.findByRole('button', { name: '€10,000.00' })
    expect(balance).toHaveAttribute('aria-expanded', 'false')
    expect(balance).toHaveAttribute('aria-controls', 'dashboard-order-history')
    await user.click(balance)

    expect(balance).toHaveAttribute('aria-expanded', 'true')
    expect(
      screen.getByText('Aún no hay órdenes de compra o venta.'),
    ).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(balance).toHaveAttribute('aria-expanded', 'false')
    expect(balance).toHaveFocus()
  })

  it('shows dashboard order history newest first', async () => {
    const user = userEvent.setup()
    const provider = readyProvider()
    renderDashboard(provider)
    await waitForReady()
    act(() =>
      provider.emit(makeQuote({ instrumentId: 'BTC-EUR', price: 60_000 })),
    )

    for (const quantity of ['0.01', '0.02']) {
      await user.click(screen.getByRole('button', { name: 'Comprar' }))
      await screen.findByRole('form', { name: 'Orden del simulador' })
      act(() =>
        provider.emit(makeQuote({ instrumentId: 'BTC-EUR', price: 60_000 })),
      )
      await user.type(screen.getByLabelText('Cantidad'), quantity)
      await user.click(
        screen.getByRole('button', { name: 'Vista previa de la orden' }),
      )
      await user.click(screen.getByRole('button', { name: 'Confirmar orden' }))
      await screen.findByRole('region', { name: 'Resultado de la orden' })
      await user.click(screen.getByRole('button', { name: 'Cerrar' }))
      await waitFor(() =>
        expect(
          screen.queryByRole('form', { name: 'Orden del simulador' }),
        ).not.toBeInTheDocument(),
      )
    }

    const balance = within(
      screen.getByRole('region', { name: 'Dinero disponible' }),
    ).getByRole('button')
    await user.click(balance)
    const history = screen.getByRole('region', { name: 'Historial de órdenes' })
    const items = within(history).getAllByRole('listitem')
    expect(items).toHaveLength(2)
    expect(items[0]).toHaveTextContent('0.02')
    expect(items[1]).toHaveTextContent('0.01')
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
    await waitFor(() => expect(mocks.series.setData).toHaveBeenCalled())

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
    expect(
      screen.getByRole('switch', { name: 'Trading automático simulado' }),
    ).toBeDisabled()

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

  it('uses the server news stream and reads paper telemetry from its endpoints', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(
        async () => ({ ok: true, json: async () => ({}) }) as Response,
      )

    renderDashboard(readyProvider())
    await waitForReady()

    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/paper-trading/status',
      expect.any(Object),
    )
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/paper-trading/orders?limit=500',
      expect.any(Object),
    )
    expect(newsStreamMock.useNewsStream).toHaveBeenCalled()
  })

  it('shows paper trading OFF when enabled but its engine is not running', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      const body = url.includes('/paper-trading/status')
        ? {
            enabled: true,
            running: false,
            stream_state: 'waiting_for_ohlc',
            account: { balance_eur: 10_000, total_equity_eur: 10_000 },
            execution_summary: { gate_rejections: 0, executed_trades: 0 },
          }
        : url.includes('/paper-trading/orders')
          ? { orders: [] }
          : {
              running: true,
              total_candles: 10,
              oldest_candle_iso: null,
              newest_candle_iso: null,
              coverage_hours: 0,
              gaps_detected: 0,
            }
      return { ok: true, json: async () => body } as Response
    })

    renderDashboard(readyProvider())
    await waitForReady()
    const status = screen.getByRole('region', {
      name: 'Estado de paper trading',
    })
    expect(status).toHaveTextContent('OFF')
    expect(status).not.toHaveTextContent('ON')
  })
})
