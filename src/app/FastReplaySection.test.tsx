import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import FastReplaySection from './FastReplaySection.tsx'

vi.mock('../features/price-chart/presentation/PriceChart.tsx', () => ({
  default: ({
    data,
    markers,
  }: {
    data: readonly { close: number }[]
    markers: readonly { text?: string }[]
  }) => (
    <>
      <div data-testid="replay-candle-count">{data.length}</div>
      <div data-testid="replay-candle-closes">
        {data.map(({ close }) => close).join(',')}
      </div>
      <div data-testid="replay-marker-labels">
        {markers.map(({ text }) => text).join(',')}
      </div>
    </>
  ),
}))

afterEach(() => vi.unstubAllGlobals())

function jsonResponse(payload: unknown): Response {
  return { ok: true, json: async () => payload } as Response
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function historyRun(
  id: string,
  datasetHash: string,
  close: number,
  side: 'buy' | 'sell' = 'buy',
) {
  const start = 1_700_000_000_000
  const end = start + 60_000
  return {
    id,
    datasetHash,
    strategyId: 'micro-trend-pullback',
    trades: [{ side, timestamp: start, price: close, quantity: 1, feeEur: 0 }],
    netPnlEur: close,
    candlesEvaluated: 1,
    rawSignalsCount: 0,
    gateRejectionsCount: 0,
    sampleCount: 0,
    brierScoreMulticlass: null,
    winRatePct: 0,
    profitFactor: 0,
    window: { start_time: start, end_time: end },
  }
}

function historyArtifact(runId: string, datasetHash: string, close: number) {
  const start = 1_700_000_000
  return {
    schema: 'fast-replay-artifact.v1',
    runId,
    datasetHash,
    source: 'kraken_rest_ohlc',
    engineOwner: 'typescript',
    timestampUnit: 'unix-seconds',
    candleIntervalSeconds: 60,
    candleTimestampSemantics: 'bucket-start',
    cutoffEpochMs: (start + 60) * 1000,
    window: { start_time: start * 1000, end_time: (start + 60) * 1000 },
    candles: [
      {
        timestamp: start,
        open: close,
        high: close,
        low: close,
        close,
        volume: 1,
      },
      {
        timestamp: start + 60,
        open: close,
        high: close,
        low: close,
        close,
        volume: 1,
      },
    ],
  }
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
  it('renders a new run and chart from the exact artifact returned with that run', async () => {
    const run = {
      id: 'fast-new-run',
      datasetHash: 'dataset-hash',
      strategyId: 'micro-trend-pullback',
      trades: [],
      netPnlEur: 0,
      candlesEvaluated: 2,
      rawSignalsCount: 0,
      gateRejectionsCount: 0,
      sampleCount: 0,
      brierScoreMulticlass: null,
      winRatePct: 0,
      profitFactor: 0,
      window: { start_time: 1_700_000_000_000, end_time: 1_700_000_060_000 },
      artifact: {
        schema: 'fast-replay-artifact.v1',
        runId: 'fast-new-run',
        datasetHash: 'dataset-hash',
        source: 'kraken_rest_ohlc',
        engineOwner: 'typescript',
        timestampUnit: 'unix-seconds',
        candleIntervalSeconds: 60,
        candleTimestampSemantics: 'bucket-start',
        cutoffEpochMs: 1_700_000_060_000,
        window: { start_time: 1_700_000_000_000, end_time: 1_700_000_060_000 },
        candles: [
          {
            timestamp: 1_700_000_000,
            open: 100,
            high: 101,
            low: 99,
            close: 100,
            volume: 1,
          },
          {
            timestamp: 1_700_000_060,
            open: 100,
            high: 102,
            low: 99,
            close: 101,
            volume: 2,
          },
        ],
      },
    }
    const fetch = vi.fn(async (input: string) =>
      input === '/api/strategies'
        ? strategiesResponse()
        : input === '/api/replay/fast-run'
          ? jsonResponse(run)
          : jsonResponse({ runs: [] }),
    )
    vi.stubGlobal('fetch', fetch)

    render(<FastReplaySection />)
    fireEvent.click(
      await screen.findByRole('button', { name: /ejecutar replay/i }),
    )

    expect(
      await screen.findByText(
        'Resultado de la corrida seleccionada · fast-new-run',
      ),
    ).toBeInTheDocument()
    expect(screen.getByTestId('replay-candle-count')).toHaveTextContent('1')
    expect(fetch).not.toHaveBeenCalledWith(
      expect.stringContaining('/api/market/ohlc'),
    )
    expect(fetch).toHaveBeenCalledWith(
      '/api/replay/fast-run',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('keeps the latest history selection when an earlier artifact response resolves last', async () => {
    const runA = historyRun('fast-run-a', 'hash-a', 111, 'sell')
    const runB = historyRun('fast-run-b', 'hash-b', 222)
    const artifactA = deferred<Response>()
    const artifactB = deferred<Response>()
    const fetch = vi.fn((input: string) => {
      if (input === '/api/strategies')
        return Promise.resolve(strategiesResponse())
      if (input.endsWith('/fast-run-a/artifact')) return artifactA.promise
      if (input.endsWith('/fast-run-b/artifact')) return artifactB.promise
      return Promise.resolve(jsonResponse({ runs: [runA, runB] }))
    })
    vi.stubGlobal('fetch', fetch)

    render(<FastReplaySection />)
    fireEvent.click(await screen.findByRole('button', { name: /fast-run-a/ }))
    fireEvent.click(screen.getByRole('button', { name: /fast-run-b/ }))

    await act(async () => {
      artifactB.resolve(
        jsonResponse({
          artifactStatus: 'verified',
          artifact: historyArtifact('fast-run-b', 'hash-b', 222),
        }),
      )
    })
    expect(
      await screen.findByText(
        'Resultado de la corrida seleccionada · fast-run-b',
      ),
    ).toBeInTheDocument()
    expect(screen.getByTestId('replay-candle-closes')).toHaveTextContent('222')
    expect(screen.getByTestId('replay-marker-labels')).toHaveTextContent(
      'Compra',
    )

    await act(async () => {
      artifactA.resolve(
        jsonResponse({
          artifactStatus: 'verified',
          artifact: historyArtifact('fast-run-a', 'hash-a', 111),
        }),
      )
    })

    expect(
      screen.getByText('Resultado de la corrida seleccionada · fast-run-b'),
    ).toBeInTheDocument()
    expect(screen.getByTestId('replay-candle-closes')).toHaveTextContent('222')
    expect(screen.getByTestId('replay-marker-labels')).toHaveTextContent(
      'Compra',
    )
    expect(
      screen.getByRole('button', { name: /ejecutar replay/i }),
    ).toBeEnabled()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('ignores errors and busy-state changes from a stale history selection', async () => {
    const runA = historyRun('fast-error-a', 'hash-a', 111, 'sell')
    const runB = historyRun('fast-error-b', 'hash-b', 222)
    const artifactA = deferred<Response>()
    const artifactB = deferred<Response>()
    const fetch = vi.fn((input: string) => {
      if (input === '/api/strategies')
        return Promise.resolve(strategiesResponse())
      if (input.endsWith('/fast-error-a/artifact')) return artifactA.promise
      if (input.endsWith('/fast-error-b/artifact')) return artifactB.promise
      return Promise.resolve(jsonResponse({ runs: [runA, runB] }))
    })
    vi.stubGlobal('fetch', fetch)

    render(<FastReplaySection />)
    fireEvent.click(await screen.findByRole('button', { name: /fast-error-a/ }))
    fireEvent.click(screen.getByRole('button', { name: /fast-error-b/ }))
    await act(async () => {
      artifactB.resolve(
        jsonResponse({
          artifactStatus: 'verified',
          artifact: historyArtifact('fast-error-b', 'hash-b', 222),
        }),
      )
    })
    expect(
      await screen.findByText(
        'Resultado de la corrida seleccionada · fast-error-b',
      ),
    ).toBeInTheDocument()

    await act(async () => {
      artifactA.reject(new Error('stale artifact request failed'))
    })

    expect(
      screen.getByText('Resultado de la corrida seleccionada · fast-error-b'),
    ).toBeInTheDocument()
    expect(screen.getByTestId('replay-candle-closes')).toHaveTextContent('222')
    expect(screen.getByTestId('replay-marker-labels')).toHaveTextContent(
      'Compra',
    )
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /ejecutar replay/i }),
    ).toBeEnabled()
  })

  it('does not let a stale run execution replace a newer history selection', async () => {
    const runResponse = deferred<Response>()
    const historyResponse = deferred<Response>()
    const runB = historyRun('fast-selected-history', 'hash-b', 222)
    const fetch = vi.fn((input: string) => {
      if (input === '/api/strategies')
        return Promise.resolve(strategiesResponse())
      if (input === '/api/replay/fast-run') return runResponse.promise
      if (input.endsWith('/fast-selected-history/artifact'))
        return historyResponse.promise
      if (input.startsWith('/api/replay/fast-run/history'))
        return Promise.resolve(jsonResponse({ runs: [runB] }))
      return Promise.resolve(jsonResponse({}))
    })
    vi.stubGlobal('fetch', fetch)

    render(<FastReplaySection />)
    const historyButton = await screen.findByRole('button', {
      name: /fast-selected-history/,
    })
    fireEvent.click(screen.getByRole('button', { name: /ejecutar replay/i }))
    fireEvent.click(historyButton)
    await act(async () => {
      historyResponse.resolve(
        jsonResponse({
          artifactStatus: 'verified',
          artifact: historyArtifact('fast-selected-history', 'hash-b', 222),
        }),
      )
    })
    expect(
      await screen.findByText(
        'Resultado de la corrida seleccionada · fast-selected-history',
      ),
    ).toBeInTheDocument()

    await act(async () => {
      runResponse.resolve(
        jsonResponse({
          ...historyRun('fast-stale-post', 'hash-post', 111, 'sell'),
          artifact: historyArtifact('fast-stale-post', 'hash-post', 111),
        }),
      )
    })

    expect(
      screen.getByText(
        'Resultado de la corrida seleccionada · fast-selected-history',
      ),
    ).toBeInTheDocument()
    expect(screen.getByTestId('replay-candle-closes')).toHaveTextContent('222')
    expect(screen.getByTestId('replay-marker-labels')).toHaveTextContent(
      'Compra',
    )
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /ejecutar replay/i }),
    ).toBeEnabled()
  })

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
        : input.endsWith('/fast-history-1/artifact')
          ? ({
              ok: false,
              json: async () => ({ artifactStatus: 'unavailable' }),
            } as Response)
          : input.endsWith('/fast-mismatch/artifact')
            ? jsonResponse({
                artifactStatus: 'verified',
                artifact: {
                  schema: 'fast-replay-artifact.v1',
                  runId: 'fast-mismatch',
                  datasetHash: 'wrong-dataset-hash',
                  source: 'kraken_rest_ohlc',
                  engineOwner: 'typescript',
                  timestampUnit: 'unix-seconds',
                  candleIntervalSeconds: 60,
                  candleTimestampSemantics: 'bucket-start',
                  window: {
                    start_time: 1_700_000_000_000,
                    end_time: 1_700_000_060_000,
                  },
                  candles: [
                    {
                      timestamp: 1_700_000_000,
                      open: 100,
                      high: 101,
                      low: 99,
                      close: 100,
                      volume: 1,
                    },
                    {
                      timestamp: 1_700_000_060,
                      open: 100,
                      high: 102,
                      low: 99,
                      close: 101,
                      volume: 2,
                    },
                  ],
                },
              })
            : input.endsWith('/artifact')
              ? jsonResponse({
                  artifactStatus: 'verified',
                  artifact: {
                    schema: 'fast-replay-artifact.v1',
                    runId: 'fast-current-fees',
                    datasetHash: 'dataset-hash',
                    source: 'kraken_rest_ohlc',
                    engineOwner: 'typescript',
                    timestampUnit: 'unix-seconds',
                    candleIntervalSeconds: 60,
                    candleTimestampSemantics: 'bucket-start',
                    cutoffEpochMs: 1_700_000_060_000,
                    window: {
                      start_time: 1_700_000_000_000,
                      end_time: 1_700_000_060_000,
                    },
                    candles: [
                      {
                        timestamp: 1_700_000_000,
                        open: 100,
                        high: 101,
                        low: 99,
                        close: 100,
                        volume: 1,
                      },
                      {
                        timestamp: 1_700_000_060,
                        open: 100,
                        high: 102,
                        low: 99,
                        close: 101,
                        volume: 2,
                      },
                    ],
                  },
                })
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
                          sourceUrl:
                            'https://www.kraken.com/features/fee-schedule',
                          verifiedAt: '2026-09-26',
                          commissionRate: 0.008,
                          slippageRate: 0.0005,
                          accountTier: 'unknown',
                        },
                      },
                      { ...savedRun, id: 'fast-mismatch' },
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
        '/api/replay/fast-run/history/fast-history-1/artifact',
      ),
    )
    expect(fetch).not.toHaveBeenCalledWith(
      expect.stringContaining('/api/market/ohlc'),
    )
    expect(await screen.findByTestId('replay-candle-count')).toHaveTextContent(
      '0',
    )
    expect(
      screen.getByText(/frozen chart data are unavailable or unverifiable/i),
    ).toBeInTheDocument()
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
    expect(screen.getByTestId('replay-candle-count')).toHaveTextContent('1')
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
    fireEvent.click(screen.getByRole('button', { name: /fast-mismatch/ }))
    expect(
      await screen.findByText(
        /frozen chart data are unavailable or unverifiable/i,
      ),
    ).toBeInTheDocument()
    expect(screen.getByTestId('replay-candle-count')).toHaveTextContent('0')
  })
})
