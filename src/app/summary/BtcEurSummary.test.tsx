import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { makeCandle, makeQuote } from '../../test/fake-market-data-provider'
import BtcEurSummary from './BtcEurSummary'

describe('BtcEurSummary', () => {
  it('shows honest placeholders when the mock has no value', () => {
    render(<BtcEurSummary quote={undefined} candles={[]} />)

    const region = screen.getByRole('region', { name: 'Resumen BTC-EUR' })
    expect(within(region).getAllByText('—').length).toBeGreaterThanOrEqual(5)
  })

  it('derives last price, variation, high, low and volume from mock data', () => {
    render(
      <BtcEurSummary
        quote={makeQuote({ price: 60_000, change: 120, changePercent: 0.2 })}
        candles={[
          makeCandle({ high: 61_000, low: 59_000, volume: 1_000 }),
          makeCandle({ high: 62_000, low: 58_000, volume: 500 }),
        ]}
      />,
    )

    const region = screen.getByRole('region', { name: 'Resumen BTC-EUR' })
    expect(within(region).getByText('€60,000.00')).toBeInTheDocument()
    expect(within(region).getByText('€62,000.00')).toBeInTheDocument()
    expect(within(region).getByText('€58,000.00')).toBeInTheDocument()
    expect(within(region).getByText('1,500')).toBeInTheDocument()
    expect(within(region).getByText('+120.00 (+0.20%)')).toBeInTheDocument()
  })

  it('does not claim a real 24h window over the mock history', () => {
    render(<BtcEurSummary quote={makeQuote()} candles={[makeCandle()]} />)

    expect(screen.getByText(/no representa 24 h reales/i)).toBeInTheDocument()
  })
})
