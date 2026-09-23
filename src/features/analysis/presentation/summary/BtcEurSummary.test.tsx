import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  makeCandle,
  makeQuote,
} from '../../../../shared/testing/fake-market-data-provider'
import BtcEurSummary from './BtcEurSummary.tsx'

describe('BtcEurSummary', () => {
  it('keeps the wireframe summary values without a redundant heading', () => {
    render(<BtcEurSummary quote={undefined} candles={[]} />)

    expect(
      screen.queryByRole('heading', {
        name: 'Información general del instrumento en este caso (BTC-EUR)',
      }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText(/no representa 24 h reales/i),
    ).not.toBeInTheDocument()
  })

  it('shows honest placeholders when the mock has no value', () => {
    render(<BtcEurSummary quote={undefined} candles={[]} />)

    const region = screen.getByRole('region', { name: 'Resumen BTC-EUR' })
    expect(within(region).getAllByText('—')).toHaveLength(3)
  })

  it('renders exactly the requested three summary values', () => {
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
    expect(
      [...region.querySelectorAll('dt')].map((label) => label.textContent),
    ).toEqual(['Última cotización', 'Variación', 'Máximo'])
    expect(within(region).queryByText('Mínimo')).not.toBeInTheDocument()
    expect(within(region).queryByText('Volumen')).not.toBeInTheDocument()
    expect(within(region).getByText('€60,000.00')).toBeInTheDocument()
    expect(within(region).getByText('€62,000.00')).toBeInTheDocument()
    expect(within(region).getByText('+120.00 (+0.20%)')).toBeInTheDocument()
  })
})
