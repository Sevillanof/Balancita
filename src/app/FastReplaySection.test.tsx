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

describe('FastReplaySection', () => {
  it('offers fixture-backed synchronization, candidate selection, and playback controls', () => {
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
    const fetch = vi.fn(async () =>
      jsonResponse({
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
      input.startsWith('/api/replay/fast-run/history')
        ? jsonResponse({ runs: [savedRun] })
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
  })
})
