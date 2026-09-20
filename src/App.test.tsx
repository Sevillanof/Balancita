import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FakeMarketDataProvider,
  WATCHLIST_INSTRUMENTS,
  makeCandle,
} from './test/fake-market-data-provider'
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
