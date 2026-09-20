import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import {
  FakeMarketDataProvider,
  WATCHLIST_INSTRUMENTS,
  makeQuote,
} from '../../test/fake-market-data-provider'
import type { Instrument } from '../../domain/market-data'
import { formatChange, formatLocalTime, formatPrice } from '../format'
import WatchlistScreen from './WatchlistScreen'

const HEADERS = [
  'Symbol',
  'Name',
  'Price',
  'Currency',
  'Change',
  'Status',
  'Last update',
]

describe('WatchlistScreen', () => {
  it('renders the table caption and all columns', () => {
    const provider = new FakeMarketDataProvider(WATCHLIST_INSTRUMENTS)
    render(<WatchlistScreen provider={provider} />)

    expect(
      screen.getByRole('table', { name: /realtime prices/i }),
    ).toBeInTheDocument()

    for (const header of HEADERS) {
      const column = screen.getByRole('columnheader', { name: header })
      expect(column).toHaveAttribute('scope', 'col')
    }
  })

  it('renders a row per instrument once ready', async () => {
    const provider = new FakeMarketDataProvider(WATCHLIST_INSTRUMENTS)
    render(<WatchlistScreen provider={provider} />)

    await waitFor(() =>
      expect(screen.getByRole('row', { name: /BTC-EUR/ })).toBeInTheDocument(),
    )
    expect(
      screen.getByRole('row', { name: /Take-Two Interactive/ }),
    ).toBeInTheDocument()
    expect(screen.getByRole('row', { name: /SPCX/ })).toBeInTheDocument()

    const btcRow = screen.getByRole('row', { name: /BTC-EUR/ })
    expect(within(btcRow).getByRole('rowheader')).toHaveTextContent('BTC-EUR')
    expect(within(btcRow).getByText('Bitcoin / Euro')).toBeInTheDocument()
    expect(within(btcRow).getAllByText('—')).toHaveLength(4)
  })

  it('shows a loading placeholder with aria-busy while fetching', async () => {
    const provider = new FakeMarketDataProvider(WATCHLIST_INSTRUMENTS)
    let resolveGetInstruments: (instruments: Instrument[]) => void = () => {}
    provider.getInstruments = () =>
      new Promise((resolve) => {
        resolveGetInstruments = resolve
      })

    render(<WatchlistScreen provider={provider} />)

    expect(screen.getByText('Loading watchlist…')).toBeInTheDocument()
    expect(screen.getByRole('table')).toHaveAttribute('aria-busy', 'true')

    await act(async () => resolveGetInstruments([...WATCHLIST_INSTRUMENTS]))

    await waitFor(() =>
      expect(screen.getByRole('row', { name: /BTC-EUR/ })).toBeInTheDocument(),
    )
    expect(screen.getByRole('table')).toHaveAttribute('aria-busy', 'false')
  })

  it('renders an accessible empty state', async () => {
    const provider = new FakeMarketDataProvider([])
    render(<WatchlistScreen provider={provider} />)

    await waitFor(() =>
      expect(screen.getByText('No instruments available.')).toBeInTheDocument(),
    )
    expect(screen.getByRole('status')).toHaveTextContent(
      'No instruments available.',
    )
  })

  it('renders an error state and retries with the keyboard', async () => {
    const user = userEvent.setup()
    const provider = new FakeMarketDataProvider(WATCHLIST_INSTRUMENTS, {
      getInstrumentsError: new Error('market down'),
    })
    render(<WatchlistScreen provider={provider} />)

    await waitFor(() =>
      expect(
        screen.getByText('Unable to load market data.'),
      ).toBeInTheDocument(),
    )
    expect(screen.getByRole('status')).toHaveTextContent(
      'Unable to load market data.',
    )

    const retry = screen.getByRole('button', { name: /retry/i })
    expect(retry).toBeInTheDocument()

    provider.getInstrumentsError = undefined
    await user.tab()
    expect(retry).toHaveFocus()
    await user.keyboard('{Enter}')

    await waitFor(() =>
      expect(screen.getByRole('row', { name: /BTC-EUR/ })).toBeInTheDocument(),
    )
  })

  it('shows mock status, price, change and time for an incoming quote', async () => {
    const provider = new FakeMarketDataProvider(WATCHLIST_INSTRUMENTS)
    render(<WatchlistScreen provider={provider} />)

    await waitFor(() =>
      expect(screen.getByRole('row', { name: /BTC-EUR/ })).toBeInTheDocument(),
    )

    const quote = makeQuote({
      instrumentId: 'TTWO',
      price: 151.25,
      change: 1.25,
      changePercent: 0.83,
      timestamp: '2026-09-20T10:30:00.000Z',
    })

    act(() => provider.emit(quote))

    const row = screen.getByRole('row', { name: /Take-Two Interactive/ })
    expect(
      within(row).getByText(formatPrice(151.25, 'USD')),
    ).toBeInTheDocument()
    expect(within(row).getByText(formatChange(quote).text)).toBeInTheDocument()
    expect(
      within(row).getByText(formatLocalTime(quote.timestamp)),
    ).toBeInTheDocument()
    expect(within(row).getByText('mock')).toBeInTheDocument()
    expect(within(row).getByText(formatChange(quote).text)).toHaveClass(
      'watchlist__change--up',
    )
  })

  it('styles negative change with a down direction', async () => {
    const provider = new FakeMarketDataProvider(WATCHLIST_INSTRUMENTS)
    render(<WatchlistScreen provider={provider} />)

    await waitFor(() =>
      expect(screen.getByRole('row', { name: /BTC-EUR/ })).toBeInTheDocument(),
    )

    const quote = makeQuote({
      instrumentId: 'SPCX',
      price: 9.7,
      change: -0.3,
      changePercent: -3.0,
    })

    act(() => provider.emit(quote))

    const row = screen.getByRole('row', { name: /SPCX/ })
    expect(within(row).getByText(formatChange(quote).text)).toHaveClass(
      'watchlist__change--down',
    )
  })

  it('keeps rows and cells stable when quotes arrive', async () => {
    const provider = new FakeMarketDataProvider(WATCHLIST_INSTRUMENTS)
    render(<WatchlistScreen provider={provider} />)

    await waitFor(() =>
      expect(screen.getByRole('row', { name: /BTC-EUR/ })).toBeInTheDocument(),
    )
    expect(screen.getAllByRole('row')).toHaveLength(4)
    const btcRow = screen.getByRole('row', {
      name: /BTC-EUR/,
    }) as HTMLTableRowElement
    expect(btcRow.cells).toHaveLength(7)
    expect(screen.getAllByRole('cell')).toHaveLength(18)

    act(() => {
      provider.emit(
        makeQuote({ instrumentId: 'BTC-EUR', price: 60_100, change: 40 }),
      )
      provider.emit(
        makeQuote({ instrumentId: 'TTWO', price: 151.25, change: 1.25 }),
      )
      provider.emit(
        makeQuote({ instrumentId: 'SPCX', price: 9.7, change: -0.3 }),
      )
    })

    expect(screen.getAllByRole('row')).toHaveLength(4)
    expect(btcRow.cells).toHaveLength(7)
    expect(screen.getAllByRole('cell')).toHaveLength(18)
  })
})

describe('WatchlistScreen selection', () => {
  it('renders symbol select buttons when onSelectInstrument is provided', async () => {
    const provider = new FakeMarketDataProvider(WATCHLIST_INSTRUMENTS)
    render(
      <WatchlistScreen
        provider={provider}
        onSelectInstrument={() => {}}
      />,
    )

    await waitFor(() =>
      expect(screen.getByRole('row', { name: /BTC-EUR/ })).toBeInTheDocument(),
    )

    const btcRow = screen.getByRole('row', { name: /BTC-EUR/ })
    expect(
      within(btcRow).getByRole('button', { name: /BTC-EUR/ }),
    ).toBeInTheDocument()
    expect(within(btcRow).getByRole('rowheader')).toBeInTheDocument()
  })

  it('keeps the symbol as plain text without an onSelect handler', () => {
    const provider = new FakeMarketDataProvider(WATCHLIST_INSTRUMENTS)
    render(<WatchlistScreen provider={provider} />)

    const buttons = screen.queryAllByRole('button')
    expect(buttons).toHaveLength(0)
  })

  it('selects an instrument on click', async () => {
    const user = userEvent.setup()
    const provider = new FakeMarketDataProvider(WATCHLIST_INSTRUMENTS)
    const onSelectInstrument = vi.fn()
    render(
      <WatchlistScreen
        provider={provider}
        onSelectInstrument={onSelectInstrument}
      />,
    )

    await waitFor(() =>
      expect(screen.getByRole('row', { name: /TTWO/ })).toBeInTheDocument(),
    )

    await user.click(screen.getByRole('button', { name: /TTWO/ }))

    const selected = WATCHLIST_INSTRUMENTS.find((i) => i.symbol === 'TTWO')
    expect(onSelectInstrument).toHaveBeenCalledTimes(1)
    expect(onSelectInstrument).toHaveBeenCalledWith(selected)
  })

  it('selects an instrument with the keyboard', async () => {
    const user = userEvent.setup()
    const provider = new FakeMarketDataProvider(WATCHLIST_INSTRUMENTS)
    const onSelectInstrument = vi.fn()
    render(
      <WatchlistScreen
        provider={provider}
        onSelectInstrument={onSelectInstrument}
      />,
    )

    await waitFor(() =>
      expect(screen.getByRole('row', { name: /BTC-EUR/ })).toBeInTheDocument(),
    )

    await user.tab()
    expect(
      screen.getByRole('button', { name: /BTC-EUR/ }),
    ).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(onSelectInstrument).toHaveBeenCalledTimes(1)

    await user.keyboard('{Enter}')
    expect(onSelectInstrument).toHaveBeenCalledTimes(2)
  })

  it('marks the selected instrument on the row and its button', async () => {
    const provider = new FakeMarketDataProvider(WATCHLIST_INSTRUMENTS)
    const selected = WATCHLIST_INSTRUMENTS.find((i) => i.symbol === 'BTC-EUR')
    render(
      <WatchlistScreen
        provider={provider}
        selectedInstrumentId={selected?.id}
        onSelectInstrument={() => {}}
      />,
    )

    await waitFor(() =>
      expect(screen.getByRole('row', { name: /BTC-EUR/ })).toBeInTheDocument(),
    )

    const btcRow = screen.getByRole('row', { name: /BTC-EUR/ })
    const ttwoRow = screen.getByRole('row', { name: /TTWO/ })
    expect(btcRow).toHaveAttribute('aria-current', 'true')
    expect(ttwoRow).not.toHaveAttribute('aria-current')
    expect(
      within(btcRow).getByRole('button', { name: /BTC-EUR/ }),
    ).toHaveAttribute('aria-pressed', 'true')
    expect(
      within(ttwoRow).getByRole('button', { name: /TTWO/ }),
    ).not.toHaveAttribute('aria-pressed')
  })
})
