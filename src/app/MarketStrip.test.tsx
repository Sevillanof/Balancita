import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import MarketStrip from './MarketStrip.tsx'
import TerminalNotices from './TerminalNotices.tsx'

const props = {
  mode: 'paper_live',
  displayedPrice: 100,
  change24h: 2.25,
  eventTimes: 'Recepción verificada',
  quoteLabel: 'Último precio',
  quoteReceivedAt: 10_000,
  displayClock: 12_500,
  alerts: [],
}

describe('MarketStrip', () => {
  it.each([
    [0, '+0% 24 h', 'ok', 'text-long'],
    [2.25, '+2,25% 24 h', 'ok', 'text-long'],
    [-2.25, '-2,25% 24 h', 'bad', 'text-short'],
  ])(
    'keeps the sign and semantic tone for %s',
    (change24h, label, tone, color) => {
      render(<MarketStrip {...props} change24h={change24h} />)
      expect(screen.getByText(label)).toHaveAttribute('data-tone', tone)
      expect(screen.getByText(label)).toHaveClass(color)
    },
  )

  it('retains the default Ethereum product, quote evidence and received age without raw PF_ codes', () => {
    render(<MarketStrip {...props} />)
    const market = screen.getByRole('region', { name: 'Mercado ETH/USD' })
    expect(within(market).getByRole('heading')).toHaveTextContent(
      'Ethereum / Dólarperpetuo',
    )
    expect(within(market).getByRole('heading')).not.toHaveTextContent(
      'PF_XBTUSD',
    )
    expect(screen.getByTitle(props.eventTimes)).toHaveTextContent(
      'Último precio · hace 2 s',
    )
    expect(screen.queryByRole('list', { name: 'Avisos' })).toBeNull()
  })

  it('does not invent a change or age for unavailable historical evidence', () => {
    render(
      <MarketStrip
        {...props}
        product="PF_ETHUSD"
        mode="historical"
        change24h={null}
        eventTimes={null}
        alerts={[{ key: 'feed', tone: 'bad', text: 'Sin conexión' }]}
      />,
    )
    expect(screen.getByRole('heading')).toHaveTextContent('Ethereum / Dólar')
    expect(screen.queryByText(/24 h/)).toBeNull()
    expect(screen.queryByText(/hace/)).toBeNull()
    expect(screen.getByRole('list', { name: 'Avisos' })).toHaveTextContent(
      'Sin conexión',
    )
  })
})

it('shares notice tones without making unknown or absent evidence green', () => {
  render(
    <TerminalNotices
      items={[
        { key: 'ok', tone: 'ok', text: 'Verificado' },
        { key: 'warn', tone: 'warn', text: 'Atención' },
        { key: 'bad', tone: 'bad', text: 'Error' },
        { key: 'nodata', tone: 'nodata', text: 'Sin datos' },
        { key: 'plain', text: 'Histórico' },
      ]}
    />,
  )
  expect(screen.getByText('Verificado')).toHaveClass('border-long')
  expect(screen.getByText('Atención')).toHaveClass('border-warn')
  expect(screen.getByText('Error')).toHaveClass('border-short')
  expect(screen.getByText('Sin datos')).toHaveClass('border-line')
  expect(screen.getByText('Histórico')).toHaveClass('border-line')
})
