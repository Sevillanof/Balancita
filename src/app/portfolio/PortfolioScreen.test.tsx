import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { moneyFromString } from '../../domain/money'
import type { Holding } from '../../domain/portfolio'
import { LocalStoragePortfolioRepository } from '../../portfolio/local-storage-portfolio-repository'
import {
  FakeMarketDataProvider,
  WATCHLIST_INSTRUMENTS,
  makeQuote,
} from '../../test/fake-market-data-provider'
import { formatPrice, formatSignedAmount, formatSignedPercent } from '../format'
import PortfolioScreen from './PortfolioScreen'

const BTC: Holding = {
  instrumentId: 'BTC-EUR',
  quantity: moneyFromString('0.5'),
  averageCost: moneyFromString('50000'),
}

const TTWO: Holding = {
  instrumentId: 'TTWO',
  quantity: moneyFromString('10'),
  averageCost: moneyFromString('140'),
}

function renderScreen() {
  const provider = new FakeMarketDataProvider(WATCHLIST_INSTRUMENTS)
  const repository = new LocalStoragePortfolioRepository()
  return {
    provider,
    repository,
    ...render(<PortfolioScreen provider={provider} repository={repository} />),
  }
}

const HEADERS = [
  'Posición',
  'Cantidad',
  'Costo promedio',
  'Precio actual',
  'Costo total',
  'Valor actual',
  'Resultado',
  'Moneda',
  'Acciones',
]

beforeEach(() => {
  localStorage.clear()
})

describe('PortfolioScreen', () => {
  it('renders the section title and all table columns', async () => {
    renderScreen()

    await waitFor(() =>
      expect(
        screen.getByRole('heading', { name: 'Cartera' }),
      ).toBeInTheDocument(),
    )

    const table = screen.getByRole('table', { name: /posiciones manuales/i })
    expect(table.parentElement).toHaveClass('table-scroll')
    for (const header of HEADERS) {
      const column = within(table).getByRole('columnheader', {
        name: header,
      })
      expect(column).toHaveAttribute('scope', 'col')
    }
  })

  it('shows a loading placeholder while reading the portfolio', async () => {
    const provider = new FakeMarketDataProvider(WATCHLIST_INSTRUMENTS)
    const repository = new LocalStoragePortfolioRepository()
    vi.spyOn(repository, 'list').mockReturnValue(new Promise(() => {}))
    render(<PortfolioScreen provider={provider} repository={repository} />)

    expect(screen.getByText('Cargando cartera…')).toBeInTheDocument()
    expect(screen.getByRole('table')).toHaveAttribute('aria-busy', 'true')
  })

  it('shows an accessible empty state with an add button', async () => {
    renderScreen()

    await waitFor(() =>
      expect(
        screen.getByText('Todavía no hay posiciones.'),
      ).toBeInTheDocument(),
    )
    const add = screen.getByRole('button', { name: /agregar posición/i })
    expect(add).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(
      'Todavía no hay posiciones.',
    )
  })

  it('shows an error state and recovers on retry', async () => {
    const user = userEvent.setup()
    const provider = new FakeMarketDataProvider(WATCHLIST_INSTRUMENTS)
    const repository = new LocalStoragePortfolioRepository()
    const spy = vi
      .spyOn(repository, 'list')
      .mockRejectedValueOnce(new Error('disk down'))
    render(<PortfolioScreen provider={provider} repository={repository} />)

    await waitFor(() =>
      expect(
        screen.getByText('No se pudo cargar la cartera.'),
      ).toBeInTheDocument(),
    )
    expect(screen.getByRole('alert')).toBeInTheDocument()

    spy.mockResolvedValue([])
    await user.click(screen.getByRole('button', { name: /reintentar/i }))

    await waitFor(() =>
      expect(
        screen.getByText('Todavía no hay posiciones.'),
      ).toBeInTheDocument(),
    )
  })

  it('offers a reset when stored data is corrupt', async () => {
    const provider = new FakeMarketDataProvider(WATCHLIST_INSTRUMENTS)
    const repository = new LocalStoragePortfolioRepository()
    localStorage.setItem(
      'balancita:portfolio',
      JSON.stringify({
        version: 2,
        holdings: [
          { instrumentId: 'BTC-EUR', quantity: 'abc', averageCost: '50000' },
        ],
      }),
    )
    render(<PortfolioScreen provider={provider} repository={repository} />)

    await waitFor(() =>
      expect(
        screen.getByText(
          'No se pudieron leer los datos guardados de la cartera.',
        ),
      ).toBeInTheDocument(),
    )

    const reset = screen.getByRole('button', { name: /restablecer cartera/i })
    await waitFor(() => expect(reset).toBeInTheDocument())
  })

  it('adds a position through the form and renders its row', async () => {
    const user = userEvent.setup()
    renderScreen()

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /agregar posición/i }),
      ).toBeInTheDocument(),
    )
    await user.click(screen.getByRole('button', { name: /agregar posición/i }))

    const form = screen.getByRole('form', { name: /agregar posición/i })
    await user.selectOptions(
      within(form).getByLabelText(/instrumento/i),
      'TTWO',
    )
    await user.type(within(form).getByLabelText(/cantidad/i), '10')
    await user.type(within(form).getByLabelText(/costo promedio/i), '140')
    await user.click(
      within(form).getByRole('button', { name: /guardar posición/i }),
    )

    const row = screen.getByRole('row', { name: /Take-Two/i })
    expect(within(row).getByText('TTWO')).toBeInTheDocument()
    expect(within(row).getByText('10')).toBeInTheDocument()
    expect(within(row).getByText(formatPrice(140, 'USD'))).toBeInTheDocument()
    expect(within(row).getAllByText('—')).toHaveLength(3)
  })

  it('rejects quantity and cost that are not positive', async () => {
    const user = userEvent.setup()
    renderScreen()

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /agregar posición/i }),
      ).toBeInTheDocument(),
    )
    await user.click(screen.getByRole('button', { name: /agregar posición/i }))

    const form = screen.getByRole('form', { name: /agregar posición/i })
    await user.selectOptions(
      within(form).getByLabelText(/instrumento/i),
      'TTWO',
    )
    await user.type(within(form).getByLabelText(/cantidad/i), '0')
    await user.type(within(form).getByLabelText(/costo promedio/i), '-5')
    await user.click(
      within(form).getByRole('button', { name: /guardar posición/i }),
    )

    expect(
      within(form).getByText('La cantidad debe ser mayor que cero.'),
    ).toBeInTheDocument()
    expect(
      within(form).getByText('El costo promedio debe ser mayor que cero.'),
    ).toBeInTheDocument()

    await waitFor(() =>
      expect(
        screen.queryByRole('row', { name: /Take-Two/i }),
      ).not.toBeInTheDocument(),
    )
    const holdings = await new LocalStoragePortfolioRepository().list()
    expect(holdings).toEqual([])
  })

  it('edits a position through a pre-filled form', async () => {
    const user = userEvent.setup()
    const repository = new LocalStoragePortfolioRepository()
    await repository.add(BTC)
    await repository.add(TTWO)

    render(
      <PortfolioScreen
        provider={new FakeMarketDataProvider(WATCHLIST_INSTRUMENTS)}
        repository={repository}
      />,
    )

    await waitFor(() =>
      expect(
        screen.getByRole('row', { name: /Take-Two/i }),
      ).toBeInTheDocument(),
    )

    await user.click(
      screen.getByRole('button', { name: /editar posición de TTWO/i }),
    )

    const form = screen.getByRole('form', { name: /editar posición de TTWO/i })
    const quantity = within(form).getByLabelText(/cantidad/i)
    expect(quantity).toHaveValue(10)
    expect(within(form).getByLabelText(/costo promedio/i)).toHaveValue(140)

    await user.clear(quantity)
    await user.type(quantity, '12')
    await user.click(
      within(form).getByRole('button', { name: /guardar posición/i }),
    )

    const edited = await new LocalStoragePortfolioRepository().list()
    expect(edited).toEqual([
      BTC,
      {
        instrumentId: 'TTWO',
        quantity: moneyFromString('12'),
        averageCost: moneyFromString('140'),
      },
    ])
  })

  it('cancels an edit without persisting changes', async () => {
    const user = userEvent.setup()
    const repository = new LocalStoragePortfolioRepository()
    await repository.add(BTC)

    render(
      <PortfolioScreen
        provider={new FakeMarketDataProvider(WATCHLIST_INSTRUMENTS)}
        repository={repository}
      />,
    )
    await waitFor(() =>
      expect(screen.getByRole('row', { name: /Bitcoin/i })).toBeInTheDocument(),
    )

    await user.click(
      screen.getByRole('button', { name: /editar posición de BTC-EUR/i }),
    )
    const form = screen.getByRole('form', {
      name: /editar posición de BTC-EUR/i,
    })
    const quantity = within(form).getByLabelText(/cantidad/i)
    await user.clear(quantity)
    await user.type(quantity, '9')
    await user.click(within(form).getByRole('button', { name: /cancel/i }))

    await waitFor(() =>
      expect(screen.queryByRole('form')).not.toBeInTheDocument(),
    )
    const listed = await new LocalStoragePortfolioRepository().list()
    expect(listed).toEqual([BTC])
  })

  it('removes a position after an in-app confirmation', async () => {
    const user = userEvent.setup()
    const repository = new LocalStoragePortfolioRepository()
    await repository.add(BTC)
    await repository.add(TTWO)

    render(
      <PortfolioScreen
        provider={new FakeMarketDataProvider(WATCHLIST_INSTRUMENTS)}
        repository={repository}
      />,
    )
    await waitFor(() =>
      expect(screen.getByRole('row', { name: /Bitcoin/i })).toBeInTheDocument(),
    )

    await user.click(
      screen.getByRole('button', { name: /eliminar posición de BTC-EUR/i }),
    )

    expect(
      screen.getByText('¿Quitar la posición de BTC-EUR?'),
    ).toBeInTheDocument()

    await user.click(
      screen.getByRole('button', { name: /confirmar eliminación/i }),
    )

    await waitFor(() =>
      expect(
        screen.queryByRole('row', { name: /Bitcoin/i }),
      ).not.toBeInTheDocument(),
    )
    await waitFor(() =>
      expect(
        screen.getByRole('row', { name: /Take-Two/i }),
      ).toBeInTheDocument(),
    )
    const listed = await new LocalStoragePortfolioRepository().list()
    expect(listed).toEqual([TTWO])
  })

  it('keeps a position when deletion is cancelled', async () => {
    const user = userEvent.setup()
    const repository = new LocalStoragePortfolioRepository()
    await repository.add(BTC)

    render(
      <PortfolioScreen
        provider={new FakeMarketDataProvider(WATCHLIST_INSTRUMENTS)}
        repository={repository}
      />,
    )
    await waitFor(() =>
      expect(screen.getByRole('row', { name: /Bitcoin/i })).toBeInTheDocument(),
    )

    await user.click(
      screen.getByRole('button', { name: /eliminar posición de BTC-EUR/i }),
    )
    await user.click(screen.getByRole('button', { name: /cancel/i }))

    await waitFor(() =>
      expect(
        screen.queryByText('¿Quitar la posición de BTC-EUR?'),
      ).not.toBeInTheDocument(),
    )
    expect(screen.getByRole('row', { name: /Bitcoin/i })).toBeInTheDocument()
    const listed = await new LocalStoragePortfolioRepository().list()
    expect(listed).toEqual([BTC])
  })

  it('derives cost, value and P/L from a live quote for its row only', async () => {
    const provider = new FakeMarketDataProvider(WATCHLIST_INSTRUMENTS)
    const repository = new LocalStoragePortfolioRepository()
    await repository.add(BTC)
    await repository.add(TTWO)

    render(<PortfolioScreen provider={provider} repository={repository} />)
    await waitFor(() =>
      expect(screen.getByRole('row', { name: /Bitcoin/i })).toBeInTheDocument(),
    )
    expect(
      within(screen.getByRole('row', { name: /Take-Two/i })).getAllByText('—'),
    ).toHaveLength(3)

    act(() =>
      provider.emit(
        makeQuote({ instrumentId: 'BTC-EUR', price: 54_250, change: 250 }),
      ),
    )

    const btcRow = screen.getByRole('row', { name: /Bitcoin/i })
    expect(
      within(btcRow).getByText(formatPrice(54_250, 'EUR')),
    ).toBeInTheDocument()
    expect(
      within(btcRow).getByText(formatPrice(27_125, 'EUR')),
    ).toBeInTheDocument()
    expect(
      within(btcRow).getByText(
        `${formatSignedAmount(moneyFromString('2125'), 'EUR')} (${formatSignedPercent(moneyFromString('8.5'))})`,
      ),
    ).toBeInTheDocument()

    expect(
      within(screen.getByRole('row', { name: /Take-Two/i })).getAllByText('—'),
    ).toHaveLength(3)
  })

  it('persists positions across remounts', async () => {
    const user = userEvent.setup()
    const provider = new FakeMarketDataProvider(WATCHLIST_INSTRUMENTS)
    const repository = new LocalStoragePortfolioRepository()

    const first = render(
      <PortfolioScreen provider={provider} repository={repository} />,
    )
    await waitFor(() =>
      expect(
        first.getByRole('button', { name: /agregar posición/i }),
      ).toBeInTheDocument(),
    )
    await user.click(first.getByRole('button', { name: /agregar posición/i }))

    const form = first.getByRole('form', { name: /agregar posición/i })
    await user.selectOptions(
      within(form).getByLabelText(/instrumento/i),
      'TTWO',
    )
    await user.type(within(form).getByLabelText(/cantidad/i), '10')
    await user.type(within(form).getByLabelText(/costo promedio/i), '140')
    await user.click(
      within(form).getByRole('button', { name: /guardar posición/i }),
    )
    await waitFor(() =>
      expect(first.getByRole('row', { name: /Take-Two/i })).toBeInTheDocument(),
    )

    first.unmount()

    const second = render(
      <PortfolioScreen provider={provider} repository={repository} />,
    )
    await waitFor(() =>
      expect(
        second.getByRole('row', { name: /Take-Two/i }),
      ).toBeInTheDocument(),
    )
  })
})
