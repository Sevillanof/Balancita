import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Candle } from '../../domain/market-data'
import {
  BTC_EUR,
  FakeMarketDataProvider,
  TTWO,
  WATCHLIST_INSTRUMENTS,
  makeCandle,
  makeQuote,
} from '../../test/fake-market-data-provider'
import { formatChange, formatLocalTime, formatPrice } from '../format'
import { toCandlestickDataset } from '../chart/candlestick-data'
import InstrumentDetail from './InstrumentDetail'

const mocks = vi.hoisted(() => {
  const series = {
    setData: vi.fn(),
    remove: vi.fn(),
    applyOptions: vi.fn(),
  }
  const chart = {
    addSeries: vi.fn(() => series),
    remove: vi.fn(),
    applyOptions: vi.fn(),
  }
  const createChart = vi.fn(() => chart)
  return {
    CandlestickSeries: { kind: 'candlestick' },
    createChart,
    chart,
    series,
    reset() {
      createChart.mockClear()
      chart.addSeries.mockClear()
      series.setData.mockClear()
      chart.remove.mockClear()
    },
  }
})

vi.mock('lightweight-charts', () => ({
  createChart: mocks.createChart,
  CandlestickSeries: mocks.CandlestickSeries,
  ColorType: { Solid: 'solid' },
}))

const BTC_HISTORY: Candle[] = [
  makeCandle({ time: '2024-01-01T00:00:00.000Z' }),
  makeCandle({ time: '2024-01-02T00:00:00.000Z', open: 104, close: 106 }),
]

const TTWO_HISTORY: Candle[] = [
  makeCandle({
    time: '2024-03-01T00:00:00.000Z',
    open: 150,
    high: 155,
    low: 148,
    close: 153,
  }),
]

describe('InstrumentDetail', () => {
  beforeEach(() => {
    mocks.reset()
  })

  it('renders the instrument summary before any quote arrives', async () => {
    const provider = new FakeMarketDataProvider(WATCHLIST_INSTRUMENTS, {
      historyByInstrument: { 'BTC-EUR': BTC_HISTORY },
    })
    render(<InstrumentDetail provider={provider} instrument={BTC_EUR} />)

    expect(
      screen.getByRole('region', { name: /BTC-EUR details/i }),
    ).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'BTC-EUR' })).toBeInTheDocument()
    expect(screen.getByText('Bitcoin / Euro')).toBeInTheDocument()
    expect(screen.getAllByText('—')).toHaveLength(4)
  })

  it('shows price, change, status and update time from the latest quote', async () => {
    const provider = new FakeMarketDataProvider(WATCHLIST_INSTRUMENTS, {
      historyByInstrument: { 'BTC-EUR': BTC_HISTORY },
    })
    render(<InstrumentDetail provider={provider} instrument={BTC_EUR} />)

    await waitFor(() => expect(mocks.createChart).toHaveBeenCalled())

    const quote = makeQuote({
      instrumentId: 'BTC-EUR',
      price: 60_150,
      change: 150,
      changePercent: 0.25,
      timestamp: '2026-09-20T11:45:00.000Z',
    })
    act(() => provider.emit(quote))

    expect(
      screen.getByText(formatPrice(quote.price, BTC_EUR.currency)),
    ).toBeInTheDocument()
    expect(screen.getByText(formatChange(quote).text)).toBeInTheDocument()
    expect(screen.getByText('mock')).toBeInTheDocument()
    expect(
      screen.getByText(formatLocalTime(quote.timestamp)),
    ).toBeInTheDocument()
  })

  it('announces loading with aria-busy while history is being fetched', async () => {
    const provider = new FakeMarketDataProvider(WATCHLIST_INSTRUMENTS)
    let resolveHistory: (candles: Candle[]) => void = () => {}
    const getHistory = vi.fn(
      () =>
        new Promise<Candle[]>((resolve) => {
          resolveHistory = resolve
        }),
    )
    provider.getHistory = getHistory as FakeMarketDataProvider['getHistory']

    render(<InstrumentDetail provider={provider} instrument={BTC_EUR} />)

    const status = screen.getByRole('status')
    expect(status).toHaveTextContent('Loading price history…')
    expect(status).toHaveAttribute('aria-busy', 'true')
    expect(mocks.createChart).not.toHaveBeenCalled()

    await act(async () => resolveHistory(BTC_HISTORY))

    await waitFor(() => expect(mocks.createChart).toHaveBeenCalled())
  })

  it('renders an accessible empty history state without creating a chart', async () => {
    const provider = new FakeMarketDataProvider(WATCHLIST_INSTRUMENTS)
    render(<InstrumentDetail provider={provider} instrument={BTC_EUR} />)

    await waitFor(() =>
      expect(
        screen.getByText('No historical candles available.'),
      ).toBeInTheDocument(),
    )
    expect(screen.getByRole('status')).toHaveTextContent(
      'No historical candles available.',
    )
    expect(mocks.createChart).not.toHaveBeenCalled()
  })

  it('renders an error state and recovers on retry', async () => {
    const user = userEvent.setup()
    const provider = new FakeMarketDataProvider(WATCHLIST_INSTRUMENTS, {
      historyByInstrument: { 'BTC-EUR': BTC_HISTORY },
      getHistoryError: new Error('history down'),
    })
    render(<InstrumentDetail provider={provider} instrument={BTC_EUR} />)

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Unable to load price history.',
      ),
    )
    expect(mocks.createChart).not.toHaveBeenCalled()

    provider.getHistoryError = undefined
    await user.click(screen.getByRole('button', { name: /retry/i }))

    await waitFor(() => expect(mocks.createChart).toHaveBeenCalled())
  })

  it('creates the chart with the transformed candles when history is ready', async () => {
    const provider = new FakeMarketDataProvider(WATCHLIST_INSTRUMENTS, {
      historyByInstrument: { 'BTC-EUR': BTC_HISTORY },
    })
    render(<InstrumentDetail provider={provider} instrument={BTC_EUR} />)

    await waitFor(() => expect(mocks.createChart).toHaveBeenCalledTimes(1))
    expect(mocks.series.setData).toHaveBeenCalledWith(
      toCandlestickDataset(BTC_HISTORY),
    )
  })

  it('removes the previous chart and renders the new instrument data on switch', async () => {
    const provider = new FakeMarketDataProvider(WATCHLIST_INSTRUMENTS, {
      historyByInstrument: { 'BTC-EUR': BTC_HISTORY, TTWO: TTWO_HISTORY },
    })
    const { rerender } = render(
      <InstrumentDetail
        key={BTC_EUR.id}
        provider={provider}
        instrument={BTC_EUR}
      />,
    )

    await waitFor(() => expect(mocks.createChart).toHaveBeenCalledTimes(1))

    rerender(
      <InstrumentDetail key={TTWO.id} provider={provider} instrument={TTWO} />,
    )

    await waitFor(() => expect(mocks.chart.remove).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(mocks.createChart).toHaveBeenCalledTimes(2))
    await waitFor(() =>
      expect(mocks.series.setData).toHaveBeenLastCalledWith(
        toCandlestickDataset(TTWO_HISTORY),
      ),
    )
    expect(screen.getByRole('heading', { name: 'TTWO' })).toBeInTheDocument()
    expect(screen.getByText('Take-Two Interactive')).toBeInTheDocument()
  })

  it('ignores a stale history response when the instrument changed', async () => {
    const provider = new FakeMarketDataProvider(WATCHLIST_INSTRUMENTS)
    const resolveByCall: Array<(candles: Candle[]) => void> = []
    const getHistory = vi.fn(
      () =>
        new Promise<Candle[]>((resolve) => {
          resolveByCall.push(resolve)
        }),
    )
    provider.getHistory = getHistory as FakeMarketDataProvider['getHistory']

    const { rerender } = render(
      <InstrumentDetail
        key={BTC_EUR.id}
        provider={provider}
        instrument={BTC_EUR}
      />,
    )

    rerender(
      <InstrumentDetail key={TTWO.id} provider={provider} instrument={TTWO} />,
    )

    await act(async () => {
      resolveByCall[1]?.(TTWO_HISTORY)
    })

    await waitFor(() => expect(mocks.createChart).toHaveBeenCalledTimes(1))
    expect(mocks.series.setData).toHaveBeenLastCalledWith(
      toCandlestickDataset(TTWO_HISTORY),
    )

    await act(async () => {
      resolveByCall[0]?.([
        makeCandle({ time: '2020-01-01T00:00:00.000Z', close: 1 }),
      ])
    })

    expect(screen.getByRole('heading', { name: 'TTWO' })).toBeInTheDocument()
    expect(mocks.series.setData).toHaveBeenLastCalledWith(
      toCandlestickDataset(TTWO_HISTORY),
    )
  })
})
