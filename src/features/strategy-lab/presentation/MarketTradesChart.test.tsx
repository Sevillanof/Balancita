import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import MarketTradesChart from './MarketTradesChart.tsx'
import RunVerdict from './RunVerdict.tsx'
import type { RunCandle, RunTrade } from '../infrastructure/run-visual-api.ts'

const candle = (
  i: number,
  close: number,
  high = close,
  low = close,
): RunCandle => ({
  time_ms: i * 60_000,
  open: String(close),
  high: String(high),
  low: String(low),
  close: String(close),
  volume: '1',
})

const trade = (
  id: string,
  entry: number,
  exit: number,
  net: number,
  side: 'LONG' | 'SHORT' = 'LONG',
): RunTrade => ({
  trade_id: id,
  product_id: 'PF_ETHUSD',
  side,
  entry_time_ms: entry * 60_000,
  entry_bucket_ms: null,
  entry_price: '100',
  exit_time_ms: exit * 60_000,
  exit_bucket_ms: null,
  exit_price: '100',
  exit_reason: null,
  reason_code: null,
  net_bp: net,
  pnl_usd: null,
  funding_usd: null,
  funding_status: 'ok',
  notional_usd: '100',
  signal_time_ms: null,
})

const candles = [
  candle(0, 100),
  candle(1, 100),
  candle(2, 99, 100, 98),
  candle(3, 99, 103, 99),
  candle(4, 101, 103, 100),
  candle(5, 101),
]
const trades = [trade('a', 1, 2, -40), trade('b', 3, 4, 25)]

it('muestra el mercado y una marca por operación, y avisa cuál se toca', async () => {
  const onSelect = vi.fn()
  render(
    <MarketTradesChart
      product="PF_ETHUSD"
      candles={candles}
      view="full"
      trades={trades}
      selected={null}
      onSelect={onSelect}
      onShowAll={() => undefined}
    />,
  )
  expect(screen.queryByTestId('trade-compare')).toBeNull()
  await userEvent.click(screen.getByRole('button', { name: /Operación 1 /u }))
  expect(onSelect).toHaveBeenCalledWith(trades[0])
})

it('al elegir una operación dibuja lo que se podía ganar y la decisión correcta', () => {
  render(
    <MarketTradesChart
      product="PF_ETHUSD"
      candles={candles}
      view="zoom"
      trades={trades}
      selected={trades[0]!}
      onSelect={() => undefined}
      onShowAll={() => undefined}
    />,
  )
  expect(screen.getByTestId('potential-path')).toBeInTheDocument()
  expect(screen.getByText('Perdimos')).toBeInTheDocument()
  expect(screen.getByText('Se podía ganar')).toBeInTheDocument()
  expect(screen.getByText('Había que ir corto')).toBeInTheDocument()
  const group = screen.getByLabelText('Decisión correcta')
  expect(group.querySelector('[data-right="true"]')).toHaveTextContent('Corto')
  expect(group.querySelector('[data-mine="true"]')).toHaveTextContent('Largo')
})

it('el botón de volver lleva a todo el período', async () => {
  const onShowAll = vi.fn()
  render(
    <MarketTradesChart
      product="PF_ETHUSD"
      candles={candles}
      view="zoom"
      trades={trades}
      selected={trades[1]!}
      onSelect={() => undefined}
      onShowAll={onShowAll}
    />,
  )
  await userEvent.click(
    screen.getByRole('button', { name: /Ver todo el período/u }),
  )
  expect(onShowAll).toHaveBeenCalled()
})

it('el veredicto dice si gana tras costos y lo compara con mantener', () => {
  render(<RunVerdict trades={trades} closes={[100, 110]} product="PF_ETHUSD" />)
  expect(screen.getByTestId('run-verdict-total')).toHaveTextContent('−0,15 USD')
  expect(screen.getByText('Pierde tras costos')).toBeInTheDocument()
  expect(
    screen.getByText(/mantener ETH daría \+10,00 USD/u),
  ).toBeInTheDocument()
})
