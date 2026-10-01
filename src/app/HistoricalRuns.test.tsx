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
      timestamp: 1_700_000_060,
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
  it('loads only the selected saved run artifact and renders frozen candles and its fills', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.includes('/artifact')
        ? { ok: true, json: async () => ({ artifact }) }
        : { ok: true, json: async () => ({ runs: [run] }) },
    )
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()
    render(<HistoricalRuns />)

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
    expect(screen.getByText(/TypeScript nativo/)).toBeInTheDocument()
    expect(screen.getAllByText(/No disponible/).length).toBeGreaterThan(0)
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
    await user.click(await screen.findByRole('button', { name: /run-one/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /no se puede verificar/i,
    )
    expect(chart).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: [], markers: [] }),
    )
  })
})
