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
})

function renderApp() {
  const historyByInstrument = Object.fromEntries(
    WATCHLIST_INSTRUMENTS.map((instrument) => [
      instrument.id,
      [makeCandle({ time: '2024-01-01T00:00:00.000Z' })],
    ]),
  )
  const provider = new FakeMarketDataProvider(WATCHLIST_INSTRUMENTS, {
    historyByInstrument,
  })
  return { provider, ...render(<App provider={provider} />) }
}

describe('App', () => {
  it('renders the Balancita product identity', () => {
    renderApp()

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'Balancita',
    )
  })

  it('does not ask for credentials, keys or secrets', () => {
    renderApp()

    expect(
      screen.queryByLabelText(/api key|secret|token|password|credential/i),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByPlaceholderText(/api key|secret|token|password|key/i),
    ).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('shows no detail until an instrument is selected', async () => {
    renderApp()

    await waitFor(() =>
      expect(screen.getByRole('row', { name: /BTC-EUR/ })).toBeInTheDocument(),
    )
    expect(
      screen.queryByRole('region', { name: /details$/i }),
    ).not.toBeInTheDocument()
    expect(mocks.createChart).not.toHaveBeenCalled()
  })

  it('renders the detail for the selected instrument and swaps it', async () => {
    const user = userEvent.setup()
    renderApp()

    await waitFor(() =>
      expect(screen.getByRole('row', { name: /BTC-EUR/ })).toBeInTheDocument(),
    )

    await user.click(screen.getByRole('button', { name: /BTC-EUR/ }))

    expect(
      screen.getByRole('region', { name: /BTC-EUR details/i }),
    ).toBeInTheDocument()
    await waitFor(() => expect(mocks.createChart).toHaveBeenCalledTimes(1))

    await user.click(screen.getByRole('button', { name: /TTWO/ }))

    expect(
      screen.getByRole('region', { name: /TTWO details/i }),
    ).toBeInTheDocument()
    await waitFor(() => expect(mocks.chart.remove).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(mocks.createChart).toHaveBeenCalledTimes(2))
    await waitFor(() =>
      expect(mocks.series.setData).toHaveBeenLastCalledWith(
        expect.arrayContaining([expect.any(Object)]),
      ),
    )
  })
})

describe('App workspace tabs', () => {
  function renderApp() {
    const historyByInstrument = Object.fromEntries(
      WATCHLIST_INSTRUMENTS.map((instrument) => [
        instrument.id,
        [makeCandle({ time: '2024-01-01T00:00:00.000Z' })],
      ]),
    )
    const provider = new FakeMarketDataProvider(WATCHLIST_INSTRUMENTS, {
      historyByInstrument,
    })
    const portfolioRepository = new LocalStoragePortfolioRepository()
    return {
      provider,
      ...render(
        <App provider={provider} portfolioRepository={portfolioRepository} />,
      ),
    }
  }

  it('renders Watchlist and Portfolio tabs and starts on Watchlist', async () => {
    renderApp()

    await waitFor(() =>
      expect(screen.getByRole('row', { name: /BTC-EUR/ })).toBeInTheDocument(),
    )

    const watchlistTab = screen.getByRole('tab', { name: /watchlist/i })
    const portfolioTab = screen.getByRole('tab', { name: /portfolio/i })
    expect(watchlistTab).toHaveAttribute('aria-selected', 'true')
    expect(portfolioTab).toHaveAttribute('aria-selected', 'false')
    expect(
      screen.getByRole('table', { name: /realtime prices/i }),
    ).toBeInTheDocument()
  })

  it('switches to the Trade tab and shows the paper trading workspace', async () => {
    const user = userEvent.setup()
    renderApp()

    await waitFor(() =>
      expect(screen.getByRole('tab', { name: /trade/i })).toBeInTheDocument(),
    )

    await user.click(screen.getByRole('tab', { name: /trade/i }))

    expect(screen.getByRole('heading', { name: 'Trade' })).toBeInTheDocument()
    expect(screen.getByLabelText('Paper trading order')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /trade/i })).toHaveAttribute(
      'aria-selected',
      'true',
    )
  })

  it('switches to the Portfolio tab and back with the keyboard', async () => {
    const user = userEvent.setup()
    renderApp()

    await waitFor(() =>
      expect(
        screen.getByRole('tab', { name: /portfolio/i }),
      ).toBeInTheDocument(),
    )

    await user.click(screen.getByRole('tab', { name: /portfolio/i }))

    expect(
      screen.getByRole('heading', { name: 'Portfolio' }),
    ).toBeInTheDocument()
    expect(screen.getByText('No positions yet.')).toBeInTheDocument()
    expect(
      screen.queryByRole('table', { name: /realtime prices/i }),
    ).not.toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: /watchlist/i }))
    await waitFor(() =>
      expect(
        screen.getByRole('table', { name: /realtime prices/i }),
      ).toBeInTheDocument(),
    )
  })
})

class FakeAnalysisProvider implements AnalysisProvider {
  analyzeCall = vi.fn<(input: AnalysisInput) => Promise<AnalysisResult>>()
  analyze = this.analyzeCall
}

describe('App analysis integration', () => {
  it('runs analysis only on the user click, never on arriving quotes', async () => {
    const user = userEvent.setup()
    const analysis = new FakeAnalysisProvider()
    analysis.analyzeCall.mockResolvedValue({
      instrumentId: 'BTC-EUR',
      classification: 'watch',
      reasons: ['Latest quote moved up 2.50%; noteworthy move.'],
      warnings: [],
      volatility: {
        lookbackCandles: 1,
        averageTrueRangePercent: 2,
        level: 'low',
      },
    })
    const historyByInstrument = Object.fromEntries(
      WATCHLIST_INSTRUMENTS.map((instrument) => [
        instrument.id,
        [makeCandle({ time: '2024-01-01T00:00:00.000Z' })],
      ]),
    )
    const provider = new FakeMarketDataProvider(WATCHLIST_INSTRUMENTS, {
      historyByInstrument,
    })
    render(<App provider={provider} analysis={analysis} />)

    await waitFor(() =>
      expect(screen.getByRole('row', { name: /BTC-EUR/ })).toBeInTheDocument(),
    )
    await user.click(screen.getByRole('button', { name: /BTC-EUR/ }))
    await waitFor(() => expect(mocks.createChart).toHaveBeenCalledTimes(1))

    expect(analysis.analyzeCall).not.toHaveBeenCalled()

    act(() =>
      provider.emit(makeQuote({ instrumentId: 'BTC-EUR', price: 60_000 })),
    )
    expect(analysis.analyzeCall).not.toHaveBeenCalled()

    const analyzeButton = screen.getByRole('button', { name: /analyze/i })
    expect(analyzeButton).toBeEnabled()
    await user.click(analyzeButton)

    await waitFor(() =>
      expect(screen.getByText('watch', { exact: true })).toBeInTheDocument(),
    )
    expect(analysis.analyzeCall).toHaveBeenCalledTimes(1)
    const input = analysis.analyzeCall.mock.calls[0]![0]
    expect(input.instrumentId).toBe('BTC-EUR')
    expect(screen.getByRole('tab', { name: /trade/i })).toHaveAttribute(
      'aria-selected',
      'false',
    )
  })
})

describe('App AI analysis toggle', () => {
  const localResult = (
    overrides: Partial<AnalysisResult> = {},
  ): AnalysisResult => ({
    instrumentId: 'BTC-EUR',
    classification: 'watch',
    reasons: ['Latest quote moved up 2.50%; noteworthy move.'],
    warnings: [],
    volatility: {
      lookbackCandles: 1,
      averageTrueRangePercent: 2,
      level: 'low',
    },
    ...overrides,
  })

  function renderAppWithGemini(
    options: { geminiAnalysis?: AnalysisProvider } = {},
  ) {
    const historyByInstrument = Object.fromEntries(
      WATCHLIST_INSTRUMENTS.map((instrument) => [
        instrument.id,
        [makeCandle({ time: '2024-01-01T00:00:00.000Z' })],
      ]),
    )
    const provider = new FakeMarketDataProvider(WATCHLIST_INSTRUMENTS, {
      historyByInstrument,
    })
    const analysis = new FakeAnalysisProvider()
    analysis.analyzeCall.mockResolvedValue(localResult())
    return {
      provider,
      analysis,
      ...render(
        <App
          provider={provider}
          analysis={analysis}
          geminiAnalysis={options.geminiAnalysis}
        />,
      ),
    }
  }

  async function openDetail(provider: FakeMarketDataProvider) {
    const user = userEvent.setup()
    await waitFor(() =>
      expect(screen.getByRole('row', { name: /BTC-EUR/ })).toBeInTheDocument(),
    )
    await user.click(screen.getByRole('button', { name: /BTC-EUR/ }))
    await waitFor(() => expect(mocks.createChart).toHaveBeenCalledTimes(1))
    act(() => provider.emit(makeQuote({ instrumentId: 'BTC-EUR' })))
  }

  it('renders an AI switch that starts off', async () => {
    renderAppWithGemini({ geminiAnalysis: new FakeAnalysisProvider() })

    const toggle = await screen.findByRole('switch', { name: /ai analysis/i })
    expect(toggle).toHaveAttribute('aria-checked', 'false')
  })

  it('keeps the AI switch available without exposing a browser key', async () => {
    renderAppWithGemini()

    const toggle = await screen.findByRole('switch', { name: /ai analysis/i })
    expect(toggle).toBeEnabled()
    expect(toggle).toHaveAttribute('aria-checked', 'false')
  })

  it('does not trigger any analysis by merely enabling AI mode', async () => {
    const user = userEvent.setup()
    const gemini = new FakeAnalysisProvider()
    gemini.analyzeCall.mockResolvedValue(localResult())
    const { analysis } = renderAppWithGemini({ geminiAnalysis: gemini })

    const toggle = await screen.findByRole('switch', { name: /ai analysis/i })
    await user.click(toggle)
    expect(analysis.analyzeCall).not.toHaveBeenCalled()
    expect(gemini.analyzeCall).not.toHaveBeenCalled()
  })

  it('runs the Gemini provider when AI is on and labels the source', async () => {
    const user = userEvent.setup()
    const gemini = new FakeAnalysisProvider()
    gemini.analyzeCall.mockResolvedValue(localResult())
    const { analysis, provider } = renderAppWithGemini({
      geminiAnalysis: gemini,
    })
    await openDetail(provider)

    const toggle = screen.getByRole('switch', { name: /ai analysis/i })
    await user.click(toggle)
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /analyze/i })).toBeEnabled(),
    )
    await user.click(screen.getByRole('button', { name: /analyze/i }))

    await waitFor(() =>
      expect(screen.getByText(/source: gemini/i)).toBeInTheDocument(),
    )
    expect(gemini.analyzeCall).toHaveBeenCalledTimes(1)
    expect(analysis.analyzeCall).not.toHaveBeenCalled()
  })

  it('falls back to the local provider when Gemini fails', async () => {
    const user = userEvent.setup()
    const gemini = new FakeAnalysisProvider()
    gemini.analyzeCall.mockRejectedValue(new Error('gemini rate limited'))
    const { analysis, provider } = renderAppWithGemini({
      geminiAnalysis: gemini,
    })
    await openDetail(provider)

    const toggle = screen.getByRole('switch', { name: /ai analysis/i })
    await user.click(toggle)
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /analyze/i })).toBeEnabled(),
    )
    await user.click(screen.getByRole('button', { name: /analyze/i }))

    await waitFor(() =>
      expect(screen.getByText(/source: mock/i)).toBeInTheDocument(),
    )
    expect(screen.getByRole('alert')).toHaveTextContent(/gemini rate limited/)
    expect(gemini.analyzeCall).toHaveBeenCalledTimes(1)
    expect(analysis.analyzeCall).toHaveBeenCalledTimes(1)
  })
})
