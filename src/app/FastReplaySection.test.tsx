import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import FastReplaySection from './FastReplaySection.tsx'

vi.mock('../features/price-chart/presentation/PriceChart.tsx', () => ({
  default: ({ data }: { data: readonly unknown[] }) => (
    <div data-testid="replay-candle-count">{data.length}</div>
  ),
}))

afterEach(() => vi.unstubAllGlobals())

function jsonResponse(payload: unknown): Response {
  return { ok: true, json: async () => payload } as Response
}

const strategiesResponse = () =>
  jsonResponse({
    strategies: [
      {
        id: 'micro-trend-pullback',
        status: 'active',
        name: 'micro-trend-pullback',
      },
      {
        id: 'micro-bollinger-reversion',
        status: 'active',
        name: 'micro-bollinger-reversion',
      },
      {
        id: 'micro-donchian-breakout',
        status: 'active',
        name: 'micro-donchian-breakout',
      },
      {
        id: 'micro-regime-adapter',
        status: 'active',
        name: 'micro-regime-adapter',
      },
    ],
  })

describe('FastReplaySection', () => {
  it('loads active strategy options from the API and disables running when unavailable', async () => {
    const fetch = vi.fn(async (input: string) =>
      input === '/api/strategies'
        ? jsonResponse({
            strategies: [
              {
                id: 'micro-trend-pullback',
                status: 'active',
                name: 'Trend Pullback',
              },
            ],
          })
        : jsonResponse({ runs: [] }),
    )
    vi.stubGlobal('fetch', fetch)
    const firstRender = render(<FastReplaySection />)
    expect(
      await screen.findByRole('option', { name: 'Tendencia: retroceso' }),
    ).toHaveValue('micro-trend-pullback')
    expect(screen.getAllByRole('option')).toHaveLength(1)

    firstRender.unmount()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, json: async () => ({}) }) as Response),
    )
    render(<FastReplaySection />)
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /ejecutar replay/i }),
      ).toBeDisabled(),
    )
  })

  it('offers fixture-backed synchronization, candidate selection, and playback controls', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => strategiesResponse()),
    )
    render(<FastReplaySection />)
    expect(
      screen.getByRole('button', { name: /sincronizar kraken ohlc.*12h/i }),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/máximo documentado: 720 velas.*12 horas/i),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /ejecutar replay/i }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Reproducir' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Reiniciar' }),
    ).toBeInTheDocument()
  })

  it('shows the actual candle coverage returned by Kraken synchronization', async () => {
    const fetch = vi.fn(async (input: string) =>
      input === '/api/strategies'
        ? strategiesResponse()
        : jsonResponse({
            inserted: 2,
            gaps_detected: 0,
            requested_hours: 12,
            maximum_candles: 720,
            coverage: {
              candle_count: 2,
              first_candle_time: 1_700_000_000_000,
              last_candle_time: 1_700_000_060_000,
            },
          }),
    )
    vi.stubGlobal('fetch', fetch)

    render(<FastReplaySection />)
    fireEvent.click(
      screen.getByRole('button', { name: /sincronizar kraken ohlc/i }),
    )

    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        '/api/market/sync-ohlc',
        expect.objectContaining({ body: JSON.stringify({ hours: 12 }) }),
      ),
    )
    expect(
      await screen.findByText(/Cobertura descargada: 2 velas/),
    ).toBeInTheDocument()
  })

  it('loads and renders the persisted OHLC window when a saved run is selected', async () => {
    const savedRun = {
      id: 'fast-history-1',
      strategyId: 'micro-donchian-breakout',
      trades: [],
      candlesEvaluated: 2,
      sampleCount: 0,
      tradesCount: 0,
      rawSignalsCount: 0,
      gateRejectionsCount: 0,
      winRatePct: 0,
      profitFactor: 0,
      netPnlEur: 0,
      brierScoreMulticlass: null,
      baselineUniformBrier: 0.6667,
      baselineNoChangeBrier: null,
      gaps: [],
      executionTimeMs: 1,
      window: { start_time: 1_700_000_000_000, end_time: 1_700_000_060_000 },
      datasetHash: 'dataset-hash',
      contentHash: 'content-hash',
      createdAt: 1_700_000_100_000,
    }
    const fetch = vi.fn(async (input: string) =>
      input === '/api/strategies'
        ? strategiesResponse()
        : input.startsWith('/api/replay/fast-run/history')
          ? jsonResponse({
              runs: [
                savedRun,
                {
                  ...savedRun,
                  id: 'fast-current-fees',
                  sizingModel: 'cash-all-in.v1',
                  initialCashEur: 30,
                  availableCashEur: 0,
                  finalEquityEur: 30,
                  feeScenario: {
                    version: 'kraken-pro-spot-btc-eur-tier1-taker.v1',
                    venue: 'Kraken Pro Spot',
                    pair: 'BTC-EUR',
                    tier: 'Tier 1 (0+ USD qualifying 30-day volume)',
                    role: 'taker',
                    sourceUrl: 'https://www.kraken.com/features/fee-schedule',
                    verifiedAt: '2026-09-26',
                    commissionRate: 0.008,
                    slippageRate: 0.0005,
                    accountTier: 'unknown',
                  },
                },
              ],
            })
          : input.startsWith('/api/market/ohlc')
            ? jsonResponse({
                candles: [
                  {
                    timestamp: 1_700_000_000_000,
                    open: 100,
                    high: 101,
                    low: 99,
                    close: 100,
                    volume: 1,
                  },
                  {
                    timestamp: 1_700_000_060_000,
                    open: 100,
                    high: 102,
                    low: 99,
                    close: 101,
                    volume: 2,
                  },
                ],
              })
            : jsonResponse({}),
    )
    vi.stubGlobal('fetch', fetch)

    render(<FastReplaySection />)
    const savedButton = await screen.findByRole('button', {
      name: /fast-history-1/,
    })
    fireEvent.click(savedButton)

    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        '/api/market/ohlc?start_time=1700000000000&end_time=1700000060000',
      ),
    )
    expect(await screen.findByTestId('replay-candle-count')).toHaveTextContent(
      '1',
    )
    expect(
      screen.getByRole('table', { name: 'Métricas de Fast Replay' }),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/procedencia de comisiones desconocida.*histórica/i),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/sizing model: unknown for this historical run/i),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /fast-current-fees/ }))
    expect(
      await screen.findByText(/comisión 0\.80 % por lado/i),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/cash-all-in\.v1 · capital inicial 30\.00 €/i),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/Tier 1 \(0\+ USD qualifying 30-day volume\)/i),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/nivel real de cuenta desconocido/i),
    ).toBeInTheDocument()
    expect(screen.getByText(/no tarifa real de cuenta/i)).toBeInTheDocument()
    expect(
      screen.getByRole('row', {
        name: /p&l neto \(comisión y deslizamiento\)/i,
      }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('link', { name: 'Fuente oficial' }),
    ).toHaveAttribute('href', 'https://www.kraken.com/features/fee-schedule')
    expect(
      screen.getByText(/el filtro de entrada no garantiza rentabilidad/i),
    ).toBeInTheDocument()
  })
})
