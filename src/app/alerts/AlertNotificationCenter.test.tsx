import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { BTC_EUR, TTWO } from '../../test/fake-market-data-provider'
import type { Alert } from '../../domain/alerts'
import { formatPrice } from '../format'
import AlertNotificationCenter from './AlertNotificationCenter'
import type { TriggeredAlert } from './useAlerts'

const BTC_TRIGGERED: Alert = {
  id: 'a1',
  instrumentId: 'BTC-EUR',
  direction: 'above',
  thresholdPrice: 60_000,
  status: 'triggered',
  createdAt: '2026-09-20T12:00:00.000Z',
}

const TTWO_TRIGGERED: Alert = {
  id: 'a2',
  instrumentId: 'TTWO',
  direction: 'below',
  thresholdPrice: 140,
  status: 'triggered',
  createdAt: '2026-09-20T12:00:01.000Z',
}

function triggered(alert: Alert, instrument = BTC_EUR): TriggeredAlert {
  return { alert, instrument }
}

describe('AlertNotificationCenter', () => {
  it('renders nothing when no alert is triggered', () => {
    render(<AlertNotificationCenter triggered={[]} onAcknowledge={vi.fn()} />)
    expect(
      screen.queryByRole('region', { name: /alert notifications/i }),
    ).not.toBeInTheDocument()
  })

  it('shows a clear message and an Acknowledge action for each trigger', () => {
    const onAcknowledge = vi.fn()
    render(
      <AlertNotificationCenter
        triggered={[triggered(BTC_TRIGGERED), triggered(TTWO_TRIGGERED, TTWO)]}
        onAcknowledge={onAcknowledge}
      />,
    )

    const region = screen.getByRole('region', { name: /alert notifications/i })
    const btc = within(region).getByRole('alert', {
      name: /BTC-EUR above/i,
    })
    expect(
      within(btc).getByText(
        `BTC-EUR above ${formatPrice(60_000, BTC_EUR.currency)}`,
      ),
    ).toBeInTheDocument()
    const ttwo = within(region).getByRole('alert', {
      name: /TTWO below/i,
    })
    expect(ttwo).toBeInTheDocument()
    expect(
      within(region).getAllByRole('button', { name: /acknowledge/i }),
    ).toHaveLength(2)
  })

  it('acknowledges a specific alert', async () => {
    const user = userEvent.setup()
    const onAcknowledge = vi.fn()
    render(
      <AlertNotificationCenter
        triggered={[triggered(BTC_TRIGGERED), triggered(TTWO_TRIGGERED, TTWO)]}
        onAcknowledge={onAcknowledge}
      />,
    )

    const region = screen.getByRole('region', { name: /alert notifications/i })
    const btc = within(region).getByRole('alert', { name: /BTC-EUR above/i })
    await user.click(
      within(btc).getByRole('button', { name: /acknowledge BTC-EUR/i }),
    )

    expect(onAcknowledge).toHaveBeenCalledWith('a1')
  })
})
