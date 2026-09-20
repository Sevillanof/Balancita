import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { moneyFromString } from '../../domain/money'
import { LocalStoragePortfolioRepository } from '../../portfolio/local-storage-portfolio-repository'
import {
  FakeMarketDataProvider,
  WATCHLIST_INSTRUMENTS,
  makeQuote,
} from '../../test/fake-market-data-provider'
import TradeScreen from './TradeScreen'

describe('TradeScreen', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('shows the first instrument and its live quote once available', async () => {
    const market = new FakeMarketDataProvider(WATCHLIST_INSTRUMENTS)
    render(<TradeScreen provider={market} />)

    const instrumentSelect = await screen.findByLabelText('Instrument')
    expect(instrumentSelect).toHaveValue('BTC-EUR')
    expect(screen.getByText('Live price: —')).toBeInTheDocument()

    act(() => {
      market.emit(makeQuote({ instrumentId: 'BTC-EUR', price: 60_000 }))
    })

    expect(screen.getByText('Live price: €60,000.00')).toBeInTheDocument()
    expect(screen.getByText('Cash (EUR): €10,000.00')).toBeInTheDocument()
  })

  it('keeps the preview disabled until quantity and a live price exist', async () => {
    const market = new FakeMarketDataProvider(WATCHLIST_INSTRUMENTS)
    render(<TradeScreen provider={market} />)
    const previewButton = await screen.findByRole('button', {
      name: 'Preview order',
    })

    expect(previewButton).toBeDisabled()

    await userEvent.type(screen.getByLabelText('Quantity'), '0.1')
    expect(previewButton).toBeDisabled()

    act(() => {
      market.emit(makeQuote({ instrumentId: 'BTC-EUR', price: 60_000 }))
    })
    expect(previewButton).toBeEnabled()
  })

  it('executes a buy and reflects cash and history', async () => {
    const market = new FakeMarketDataProvider(WATCHLIST_INSTRUMENTS)
    const user = userEvent.setup()
    render(<TradeScreen provider={market} />)

    await screen.findByLabelText('Instrument')
    act(() => {
      market.emit(makeQuote({ instrumentId: 'BTC-EUR', price: 60_000 }))
    })

    await user.type(screen.getByLabelText('Quantity'), '0.1')
    await user.click(screen.getByRole('button', { name: 'Preview order' }))

    const summary = screen.getByRole('region', { name: 'Order preview' })
    expect(within(summary).getAllByText('€6,000.00').length).toBeGreaterThan(0)

    await user.click(
      within(summary).getByRole('button', { name: 'Confirm order' }),
    )

    await screen.findByText('Order executed')
    const result = screen.getByRole('region', { name: 'Order result' })
    expect(within(result).getByText('R1')).toBeInTheDocument()
    expect(within(result).getAllByText('€6,000.00').length).toBeGreaterThan(0)

    await waitFor(() =>
      expect(screen.getByText('Cash (EUR): €4,000.00')).toBeInTheDocument(),
    )
    const history = screen.getByRole('region', { name: 'Order history' })
    expect(within(history).getByText('R1')).toBeInTheDocument()
    expect(within(history).getByText('executed')).toBeInTheDocument()
  })

  it('rejects a buy that exceeds available cash and shows the reason', async () => {
    const market = new FakeMarketDataProvider(WATCHLIST_INSTRUMENTS)
    const user = userEvent.setup()
    render(<TradeScreen provider={market} />)

    await screen.findByLabelText('Instrument')
    act(() => {
      market.emit(makeQuote({ instrumentId: 'BTC-EUR', price: 60_000 }))
    })

    await user.type(screen.getByLabelText('Quantity'), '0.2')
    await user.click(screen.getByRole('button', { name: 'Preview order' }))
    const summary = screen.getByRole('region', { name: 'Order preview' })
    await user.click(
      within(summary).getByRole('button', { name: 'Confirm order' }),
    )

    await screen.findByText('Order rejected')
    expect(screen.getByText('Reason: insufficient-cash')).toBeInTheDocument()
    expect(screen.getByText('Cash (EUR): €10,000.00')).toBeInTheDocument()
  })

  it('credits cash when selling from a seeded position', async () => {
    const market = new FakeMarketDataProvider(WATCHLIST_INSTRUMENTS)
    const user = userEvent.setup()
    const repository = new LocalStoragePortfolioRepository()
    await repository.add({
      instrumentId: 'BTC-EUR',
      quantity: moneyFromString('0.5'),
      averageCost: moneyFromString('50000'),
    })

    render(<TradeScreen provider={market} />)

    await screen.findByLabelText('Instrument')
    act(() => {
      market.emit(makeQuote({ instrumentId: 'BTC-EUR', price: 60_000 }))
    })

    await user.click(screen.getByRole('button', { name: 'Sell' }))
    await user.type(screen.getByLabelText('Quantity'), '0.1')
    await user.click(screen.getByRole('button', { name: 'Preview order' }))
    const summary = screen.getByRole('region', { name: 'Order preview' })
    await user.click(
      within(summary).getByRole('button', { name: 'Confirm order' }),
    )

    await screen.findByText('Order executed')
    await waitFor(() =>
      expect(screen.getByText('Cash (EUR): €16,000.00')).toBeInTheDocument(),
    )

    const holdings = await new LocalStoragePortfolioRepository().list()
    const [holding] = holdings
    expect(holding.quantity).toEqual(moneyFromString('0.4'))
    expect(holding.averageCost).toEqual(moneyFromString('50000'))
  })

  it('flags an invalid quantity before previewing', async () => {
    const market = new FakeMarketDataProvider(WATCHLIST_INSTRUMENTS)
    const user = userEvent.setup()
    render(<TradeScreen provider={market} />)

    await screen.findByLabelText('Instrument')
    act(() => {
      market.emit(makeQuote({ instrumentId: 'BTC-EUR', price: 60_000 }))
    })

    await user.type(screen.getByLabelText('Quantity'), '0')
    expect(
      screen.getByText(/Quantity must be a positive decimal number/),
    ).toBeInTheDocument()
  })
})
