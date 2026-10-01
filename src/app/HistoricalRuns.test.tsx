import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import HistoricalRuns from './HistoricalRuns.tsx'

const chart = vi.hoisted(() => vi.fn())
vi.mock('../features/price-chart/presentation/PriceChart.tsx', () => ({
  default: (props: {
    data: readonly unknown[]
    markers: readonly unknown[]
  }) => {
    chart(props)
    return <div data-testid="history-chart" />
  },
}))

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  chart.mockClear()
})

const run = {
  id: 'run-one',
  datasetHash: 'hash-one',
  strategyId: 'micro-trend-pullback',
  strategyOwner: 'typescript-native',
  sizingModel: 'cash-all-in.v1',
  nativeTradeTimestampUnit: 'unix-milliseconds',
  nativeTradeTimestampMeaning: 'simulated-next-15m-candle-open',
  initialCashEur: 100,
  netPnlEur: 5,
  candlesEvaluated: 3,
  rawSignalsCount: 2,
  gateRejectionsCount: 1,
  sampleCount: 0,
  brierScoreMulticlass: null,
  winRatePct: null,
  profitFactor: null,
  window: { start_time: 1_700_000_000_000, end_time: 1_700_000_120_000 },
  trades: [
    {
      side: 'buy',
      timestamp: 1_700_000_060_000,
      price: 50_000,
      quantity: 0.002,
      feeEur: 0.08,
    },
  ],
}
const artifact = {
  schema: 'fast-replay-artifact.v1',
  runId: 'run-one',
  datasetHash: 'hash-one',
  source: 'kraken_rest_ohlc',
  engineOwner: 'typescript',
  timestampUnit: 'unix-seconds',
  candleIntervalSeconds: 60,
  candleTimestampSemantics: 'bucket-start',
  cutoffEpochMs: 1_700_000_120_000,
  window: { start_time: 1_700_000_000_000, end_time: 1_700_000_120_000 },
  candles: [
    {
      timestamp: 1_700_000_000,
      open: 49_000,
      high: 51_000,
      low: 48_000,
      close: 50_000,
      volume: 2,
    },
    {
      timestamp: 1_700_000_060,
      open: 50_000,
      high: 51_000,
      low: 49_000,
      close: 50_500,
      volume: 3,
    },
    {
      timestamp: 1_700_000_120,
      open: 50_500,
      high: 52_000,
      low: 50_000,
      close: 51_000,
      volume: 4,
    },
  ],
}

describe('connected historical replay runs', () => {
  it('uses the approved shared brand header with explicit connected navigation', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ runs: [] }) })),
    )
    render(<HistoricalRuns />)

    const header = screen.getByTestId('approved-trading-header')
    expect(
      screen.getByRole('link', { name: 'Balancita, volver a la aplicación' }),
    ).toHaveAttribute('href', '/')
    expect(header.querySelector('.demo-shell__brand-mark svg')).not.toBeNull()
    expect(
      screen.getByRole('link', { name: 'Pruebas históricas' }),
    ).toHaveAttribute('href', '/historicos')
    expect(screen.getByRole('link', { name: 'Terminal' })).toHaveAttribute(
      'href',
      '/terminal',
    )
    expect(
      screen.getByRole('link', { name: 'Pruebas históricas' }),
    ).toHaveAttribute('aria-current', 'page')
  })

  it('places the connected form and selected result in the approved shared split', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ runs: [] }) })),
    )
    render(<HistoricalRuns />)

    const layout = document.querySelector('.demo-history__layout')
    expect(layout).not.toBeNull()
    expect(layout?.firstElementChild).toContainElement(
      screen.getByRole('region', { name: 'Nueva prueba histórica' }),
    )
    expect(layout?.lastElementChild).toContainElement(
      screen.getByRole('region', { name: 'Resultado de corrida guardada' }),
    )
  })

  it('preserves a created run when the initial history response resolves late', async () => {
    let resolveHistory!: (response: {
      ok: boolean
      json: () => Promise<unknown>
    }) => void
    const historyResponse = new Promise<{
      ok: boolean
      json: () => Promise<unknown>
    }>((resolve) => {
      resolveHistory = resolve
    })
    const createdRun = {
      ...run,
      id: 'created-run',
      datasetHash: 'created-hash',
    }
    const createdArtifact = {
      ...artifact,
      runId: 'created-run',
      datasetHash: 'created-hash',
    }
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/replay/fast-run/history?limit=50')
        return historyResponse
      if (url === '/api/replay/fast-run')
        return Promise.resolve({ ok: true, json: async () => createdRun })
      if (url.includes('/artifact'))
        return Promise.resolve({
          ok: true,
          json: async () => ({ artifact: createdArtifact }),
        })
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()
    render(<HistoricalRuns />)
    await user.click(screen.getByText(/Historial \(/))

    await user.type(
      screen.getByLabelText('Inicio UTC (ISO 8601)'),
      '2023-11-14T22:13:20Z',
    )
    await user.type(
      screen.getByLabelText('Fin UTC (ISO 8601)'),
      '2023-11-14T22:14:20Z',
    )
    await user.click(
      screen.getByRole('button', { name: 'Ejecutar replay TypeScript' }),
    )
    expect(
      await screen.findByRole('heading', { name: 'Corrida created-run' }),
    ).toBeInTheDocument()

    resolveHistory({ ok: true, json: async () => ({ runs: [run] }) })

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'created-run' }),
      ).toHaveAttribute('aria-pressed', 'true'),
    )
    expect(screen.getByRole('button', { name: 'run-one' })).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'created-run' })).toHaveLength(
      1,
    )
    expect(chart).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({ close: 50_000 }),
        ]),
        markers: expect.arrayContaining([
          expect.objectContaining({ time: 1_700_000_060 }),
        ]),
      }),
    )
  })

  it('loads only the selected saved run artifact and renders frozen candles and its fills', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.includes('/artifact')
        ? { ok: true, json: async () => ({ artifact }) }
        : { ok: true, json: async () => ({ runs: [run] }) },
    )
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()
    render(<HistoricalRuns />)
    await user.click(screen.getByText(/Historial \(/))

    await user.click(await screen.findByRole('button', { name: /run-one/ }))
    await waitFor(() =>
      expect(chart).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.arrayContaining([
            expect.objectContaining({ close: 50_000 }),
          ]),
          markers: expect.arrayContaining([
            expect.objectContaining({ time: 1_700_000_060 }),
          ]),
        }),
      ),
    )
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining('/api/market/ohlc'),
    )
    expect(screen.getAllByText(/TypeScript nativo/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/No disponible/).length).toBeGreaterThan(0)
    expect(screen.getByText('Patrimonio final (EUR)')).toBeInTheDocument()
    expect(screen.queryByText('Curva de capital')).not.toBeInTheDocument()
  })

  it('keeps legacy ownership unknown and never substitutes current candles for a missing frozen artifact', async () => {
    const legacyRun = {
      ...run,
      strategyOwner: undefined,
      sizingModel: undefined,
      nativeTradeTimestampUnit: undefined,
      nativeTradeTimestampMeaning: undefined,
      datasetHash: undefined,
    }
    const fetchMock = vi.fn(async (url: string) =>
      url.includes('/artifact')
        ? { ok: true, json: async () => ({ artifact: null }) }
        : { ok: true, json: async () => ({ runs: [legacyRun] }) },
    )
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()
    render(<HistoricalRuns />)
    await user.click(screen.getByText(/Historial \(/))
    await user.click(await screen.findByRole('button', { name: /run-one/ }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /artefacto de velas está ausente/i,
    )
    await user.click(screen.getByText('Parámetros, procedencia y auditoría'))
    expect(screen.getByText('Propiedad: No disponible')).toBeInTheDocument()
    expect(chart).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: [], markers: [] }),
    )
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining('/api/market/ohlc'),
    )
  })

  it('refuses an artifact belonging to a different selected run and keeps it uncharted', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('/artifact')
          ? {
              ok: true,
              json: async () => ({
                artifact: { ...artifact, runId: 'other-run' },
              }),
            }
          : { ok: true, json: async () => ({ runs: [run] }) },
      ),
    )
    const user = userEvent.setup()
    render(<HistoricalRuns />)
    await user.click(screen.getByText(/Historial \(/))
    await user.click(await screen.findByRole('button', { name: /run-one/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /no se puede verificar/i,
    )
    expect(chart).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: [], markers: [] }),
    )
  })
})
