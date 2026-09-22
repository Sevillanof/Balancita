import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AnalysisInput,
  AnalysisProvider,
  AnalysisResult,
} from './domain/analysis'
import {
  FakeMarketDataProvider,
  WATCHLIST_INSTRUMENTS,
  makeCandle,
  makeQuote,
} from './test/fake-market-data-provider'
import { LocalStoragePortfolioRepository } from './portfolio/local-storage-portfolio-repository'
import App from './App'

const mocks = vi.hoisted(() => ({
  createChart: vi.fn(),
  series: { setData: vi.fn() },
  chart: { addSeries: vi.fn(), remove: vi.fn() },
}))

mocks.createChart.mockReturnValue(mocks.chart)
mocks.chart.addSeries.mockReturnValue(mocks.series)

vi.mock('lightweight-charts', () => ({
  ColorType: { Solid: 'solid' },
  CandlestickSeries: {},
  createChart: (...args: unknown[]) => mocks.createChart(...args),
}))

beforeEach(() => {
  vi.clearAllMocks()
  window.localStorage.clear()
})

function renderApp(options: { analysis?: AnalysisProvider } = {}) {
  const historyByInstrument = Object.fromEntries(
    WATCHLIST_INSTRUMENTS.map((instrument) => [
      instrument.id,
      [makeCandle({ time: '2024-01-01T00:00:00.000Z' })],
    ]),
  )
  const provider = new FakeMarketDataProvider(WATCHLIST_INSTRUMENTS, {
    historyByInstrument,
  })
  return {
    provider,
    ...render(
      <App
        provider={provider}
        portfolioRepository={new LocalStoragePortfolioRepository()}
        analysis={options.analysis}
      />,
    ),
  }
}

function localResult(overrides: Partial<AnalysisResult> = {}): AnalysisResult {
  return {
    instrumentId: 'BTC-EUR',
    classification: 'watch',
    recommendation: 'hold',
    reasons: ['La cotización requiere observación.'],
    warnings: [],
    volatility: {
      lookbackCandles: 1,
      averageTrueRangePercent: 2,
      level: 'low',
    },
    disclaimer: 'Recomendación educativa: no ejecuta órdenes.',
    ...overrides,
  }
}

class FakeAnalysisProvider implements AnalysisProvider {
  analyzeCall = vi.fn<(input: AnalysisInput) => Promise<AnalysisResult>>()
  analyze = this.analyzeCall
}

describe('dashboard BTC-EUR', () => {
  it('starts with one accessible BTC-EUR dashboard and no tab navigation', async () => {
    renderApp()

    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: 'Balancita (BTC/EUR)',
      }),
    ).toBeInTheDocument()
    expect(
      screen.queryByText('Un espacio personal de inversión local y educativo.'),
    ).not.toBeInTheDocument()
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
    expect(
      await screen.findByRole('form', { name: 'Orden del simulador' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', {
        name: 'Información general del instrumento en este caso (BTC-EUR)',
      }),
    ).toBeInTheDocument()
  })

  it('uses the active market provider price for the dashboard and paper preview', async () => {
    const user = userEvent.setup()
    const { provider } = renderApp()

    await screen.findByRole('heading', { name: 'BTC-EUR' })
    await waitFor(() =>
      expect(provider.subscribeCalls.length).toBeGreaterThanOrEqual(3),
    )
    act(() =>
      provider.emit(makeQuote({ instrumentId: 'BTC-EUR', price: 60_000 })),
    )

    await waitFor(() =>
      expect(
        screen.getByText(
          (_, element) => element?.textContent === 'Precio en vivo: €60,000.00',
        ),
      ).toBeInTheDocument(),
    )
    await user.type(screen.getByLabelText('Cantidad'), '0.1')
    await user.click(
      screen.getByRole('button', { name: 'Vista previa de la orden' }),
    )

    const preview = await screen.findByRole('region', {
      name: 'Vista previa de la orden',
    })
    expect(preview).toHaveTextContent('€60,000.00')
    expect(preview).toHaveTextContent('€6,000.00')
  })

  it('keeps the order flow while running no analysis on the Phase 1 main screen', async () => {
    const analysis = new FakeAnalysisProvider()
    analysis.analyzeCall.mockResolvedValue(localResult())
    const { provider } = renderApp({ analysis })

    await screen.findByRole('form', { name: 'Orden del simulador' })
    await waitFor(() =>
      expect(provider.subscribeCalls.length).toBeGreaterThanOrEqual(3),
    )
    act(() =>
      provider.emit(makeQuote({ instrumentId: 'BTC-EUR', price: 60_000 })),
    )

    await waitFor(() =>
      expect(
        screen.getByText(
          (_, element) => element?.textContent === 'Precio en vivo: €60,000.00',
        ),
      ).toBeInTheDocument(),
    )
    expect(analysis.analyzeCall).not.toHaveBeenCalled()
    expect(
      screen.queryByRole('button', { name: 'Confirmar orden' }),
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('form', { name: 'Orden del simulador' }),
    ).toBeInTheDocument()
  })

  it('does not expose credentials or secrets', () => {
    renderApp()
    expect(
      screen.queryByLabelText(/api key|secret|token|password|credential/i),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByPlaceholderText(/api key|secret|token|password|key/i),
    ).not.toBeInTheDocument()
  })
})

describe('dashboard Gemini boundary', () => {
  it('keeps analysis providers idle on the main screen', async () => {
    const local = new FakeAnalysisProvider()
    const gemini = new FakeAnalysisProvider()
    local.analyzeCall.mockResolvedValue(localResult())
    gemini.analyzeCall.mockResolvedValue(localResult())
    const historyByInstrument = Object.fromEntries(
      WATCHLIST_INSTRUMENTS.map((instrument) => [
        instrument.id,
        [makeCandle()],
      ]),
    )
    const provider = new FakeMarketDataProvider(WATCHLIST_INSTRUMENTS, {
      historyByInstrument,
    })
    render(
      <App
        provider={provider}
        analysis={local}
        geminiAnalysis={gemini}
        portfolioRepository={new LocalStoragePortfolioRepository()}
      />,
    )

    await screen.findByRole('form', { name: 'Orden del simulador' })
    await waitFor(() =>
      expect(provider.subscribeCalls.length).toBeGreaterThanOrEqual(3),
    )
    act(() => provider.emit(makeQuote({ instrumentId: 'BTC-EUR' })))

    await waitFor(() =>
      expect(screen.getByLabelText('Cantidad')).toBeInTheDocument(),
    )
    // Phase 1 renders only the six wireframe areas: there is no analysis
    // surface and no IA toggle, so neither provider may ever be invoked.
    expect(
      screen.queryByRole('switch', { name: /análisis con ia/i }),
    ).not.toBeInTheDocument()
    expect(local.analyzeCall).not.toHaveBeenCalled()
    expect(gemini.analyzeCall).not.toHaveBeenCalled()
  })
})
