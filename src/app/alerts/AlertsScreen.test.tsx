import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Alert } from '../../domain/alerts'
import { LocalStorageAlertRepository } from '../../alerts/local-storage-alert-repository'
import {
  FakeMarketDataProvider,
  WATCHLIST_INSTRUMENTS,
  makeQuote,
} from '../../test/fake-market-data-provider'
import { formatPrice } from '../format'
import { useAlerts } from './useAlerts'
import AlertsScreen from './AlertsScreen'

const BTC_ABOVE: Alert = {
  id: 'a1',
  instrumentId: 'BTC-EUR',
  direction: 'above',
  thresholdPrice: 60_000,
  status: 'active',
  createdAt: '2026-09-20T12:00:00.000Z',
}

function renderScreen() {
  const provider = new FakeMarketDataProvider(WATCHLIST_INSTRUMENTS)
  const repository = new LocalStorageAlertRepository()
  function Harness() {
    const alerts = useAlerts(provider, repository)
    return <AlertsScreen alerts={alerts} />
  }
  return { provider, repository, ...render(<Harness />) }
}

beforeEach(() => {
  localStorage.clear()
})

describe('AlertsScreen', () => {
  it('renders the section title and an accessible empty state', async () => {
    renderScreen()

    await waitFor(() =>
      expect(
        screen.getByRole('heading', { name: 'Alerts' }),
      ).toBeInTheDocument(),
    )
    expect(screen.getByText('No alerts yet.')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /add alert/i }),
    ).toBeInTheDocument()
  })

  it('shows a loading placeholder while reading the alert configuration', async () => {
    const provider = new FakeMarketDataProvider(WATCHLIST_INSTRUMENTS)
    const repository = new LocalStorageAlertRepository()
    vi.spyOn(repository, 'list').mockReturnValue(new Promise(() => {}))
    function Harness() {
      const alerts = useAlerts(provider, repository)
      return <AlertsScreen alerts={alerts} />
    }
    render(<Harness />)

    expect(screen.getByText('Loading alerts…')).toBeInTheDocument()
  })

  it('offers a reset when stored alert data is corrupt', async () => {
    localStorage.setItem(
      'balancita:alerts',
      JSON.stringify({ version: 2, alerts: [BTC_ABOVE] }),
    )
    renderScreen()

    await waitFor(() =>
      expect(
        screen.getByText('Stored alert data could not be read.'),
      ).toBeInTheDocument(),
    )
    expect(
      screen.getByRole('button', { name: /reset alerts/i }),
    ).toBeInTheDocument()
  })

  it('creates an alert through the form and renders its row as active', async () => {
    const user = userEvent.setup()
    const { repository } = renderScreen()

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /add alert/i }),
      ).toBeInTheDocument(),
    )
    await user.click(screen.getByRole('button', { name: /add alert/i }))

    const form = screen.getByRole('form', { name: /add alert/i })
    await user.selectOptions(within(form).getByLabelText(/instrument/i), 'TTWO')
    await user.selectOptions(within(form).getByLabelText(/direction/i), 'below')
    await user.type(within(form).getByLabelText(/threshold price/i), '140')
    await user.click(within(form).getByRole('button', { name: /save alert/i }))

    await waitFor(() =>
      expect(
        screen.getByRole('row', { name: /Take-Two/i }),
      ).toBeInTheDocument(),
    )
    expect(screen.getByText('below')).toBeInTheDocument()
    expect(screen.getByText(formatPrice(140, 'USD'))).toBeInTheDocument()

    const stored = await repository.list()
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({
      instrumentId: 'TTWO',
      direction: 'below',
      thresholdPrice: 140,
      status: 'active',
    })
  })

  it('rejects a threshold that is not a positive number', async () => {
    const user = userEvent.setup()
    const { repository } = renderScreen()

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /add alert/i }),
      ).toBeInTheDocument(),
    )
    await user.click(screen.getByRole('button', { name: /add alert/i }))

    const form = screen.getByRole('form', { name: /add alert/i })
    await user.selectOptions(within(form).getByLabelText(/instrument/i), 'TTWO')
    await user.type(within(form).getByLabelText(/threshold price/i), '0')
    await user.click(within(form).getByRole('button', { name: /save alert/i }))

    expect(
      within(form).getByText('Threshold must be greater than zero.'),
    ).toBeInTheDocument()
    expect(await repository.list()).toEqual([])
  })

  it('shows the triggered status and acknowledges the alert', async () => {
    const user = userEvent.setup()
    const repository = new LocalStorageAlertRepository()
    await repository.add({ ...BTC_ABOVE, status: 'triggered' })
    function Harness() {
      const alerts = useAlerts(
        new FakeMarketDataProvider(WATCHLIST_INSTRUMENTS),
        repository,
      )
      return <AlertsScreen alerts={alerts} />
    }
    render(<Harness />)

    await waitFor(() =>
      expect(screen.getByRole('row', { name: /Bitcoin/i })).toBeInTheDocument(),
    )
    expect(screen.getByText('triggered')).toBeInTheDocument()

    await user.click(
      screen.getByRole('button', { name: /acknowledge BTC-EUR alert/i }),
    )

    await waitFor(() =>
      expect(screen.getByText('acknowledged')).toBeInTheDocument(),
    )
    const stored = await repository.list()
    expect(stored[0]?.status).toBe('acknowledged')
  })

  it('deletes an alert and removes its row', async () => {
    const user = userEvent.setup()
    const provider = new FakeMarketDataProvider(WATCHLIST_INSTRUMENTS)
    const repository = new LocalStorageAlertRepository()
    await repository.add(BTC_ABOVE)
    function Harness() {
      const alerts = useAlerts(provider, repository)
      return <AlertsScreen alerts={alerts} />
    }
    render(<Harness />)

    await waitFor(() =>
      expect(screen.getByRole('row', { name: /Bitcoin/i })).toBeInTheDocument(),
    )
    await user.click(
      screen.getByRole('button', { name: /delete BTC-EUR alert/i }),
    )

    await waitFor(() =>
      expect(
        screen.queryByRole('row', { name: /Bitcoin/i }),
      ).not.toBeInTheDocument(),
    )
    expect(await repository.list()).toEqual([])
  })

  it('crosses a live quote and shows the row as triggered', async () => {
    const provider = new FakeMarketDataProvider(WATCHLIST_INSTRUMENTS)
    const repository = new LocalStorageAlertRepository()
    await repository.add(BTC_ABOVE)
    function Harness() {
      const alerts = useAlerts(provider, repository)
      return <AlertsScreen alerts={alerts} />
    }
    render(<Harness />)

    await waitFor(() =>
      expect(screen.getByRole('row', { name: /Bitcoin/i })).toBeInTheDocument(),
    )
    expect(screen.getByText('active')).toBeInTheDocument()

    act(() =>
      provider.emit(makeQuote({ instrumentId: 'BTC-EUR', price: 59_000 })),
    )
    act(() =>
      provider.emit(makeQuote({ instrumentId: 'BTC-EUR', price: 61_000 })),
    )

    await waitFor(() =>
      expect(screen.getByText('triggered')).toBeInTheDocument(),
    )
  })

  it('persists alerts across remounts', async () => {
    const user = userEvent.setup()
    const provider = new FakeMarketDataProvider(WATCHLIST_INSTRUMENTS)
    const repository = new LocalStorageAlertRepository()
    function Harness() {
      const alerts = useAlerts(provider, repository)
      return <AlertsScreen alerts={alerts} />
    }

    const first = render(<Harness />)
    await waitFor(() =>
      expect(
        first.getByRole('button', { name: /add alert/i }),
      ).toBeInTheDocument(),
    )
    await user.click(first.getByRole('button', { name: /add alert/i }))
    const form = first.getByRole('form', { name: /add alert/i })
    await user.selectOptions(within(form).getByLabelText(/instrument/i), 'TTWO')
    await user.selectOptions(within(form).getByLabelText(/direction/i), 'above')
    await user.type(within(form).getByLabelText(/threshold price/i), '150')
    await user.click(within(form).getByRole('button', { name: /save alert/i }))
    await waitFor(() =>
      expect(first.getByRole('row', { name: /Take-Two/i })).toBeInTheDocument(),
    )
    first.unmount()

    const second = render(<Harness />)
    await waitFor(() =>
      expect(
        second.getByRole('row', { name: /Take-Two/i }),
      ).toBeInTheDocument(),
    )
    expect(second.getByText('active')).toBeInTheDocument()
  })
})
