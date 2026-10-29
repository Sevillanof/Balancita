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
    screen.getByText(/mantener Ethereum daría \+10,00 USD/u),
  ).toBeInTheDocument()
})

it('sin analista de movimiento no dibuja leyenda ni marcas de movimiento', () => {
  render(
    <MarketTradesChart
      product="PF_ETHUSD"
      candles={candles}
      view="full"
      trades={trades}
      selected={null}
      onSelect={() => undefined}
      onShowAll={() => undefined}
    />,
  )
  expect(screen.queryByTestId('movement-legend')).toBeNull()
  expect(document.querySelector('[data-movement]')).toBeNull()
})

it('con el analista marca cada operación «con movimiento» o «en calma» y el ancho es el tamaño', () => {
  const rated = [
    { ...trades[0]!, with_movement: false, size_mult: 0.75 },
    { ...trades[1]!, with_movement: true, size_mult: 1.25 },
  ]
  render(
    <MarketTradesChart
      product="PF_ETHUSD"
      candles={candles}
      view="full"
      trades={rated}
      selected={null}
      onSelect={() => undefined}
      onShowAll={() => undefined}
    />,
  )
  expect(screen.getByTestId('movement-legend')).toBeInTheDocument()
  const calm = screen.getByRole('button', {
    name: /Operación 1 .*en calma ×0,75/u,
  })
  const moving = screen.getByRole('button', {
    name: /Operación 2 .*con movimiento ×1,25/u,
  })
  expect(calm).toHaveAttribute('data-movement', 'en-calma')
  expect(calm).toHaveStyle({ width: '9px' })
  expect(moving).toHaveAttribute('data-movement', 'con-movimiento')
  expect(moving).toHaveStyle({ width: '15px' })
})

it('al elegir una operación del analista dice cómo entró', () => {
  const picked = { ...trades[1]!, with_movement: true, size_mult: 1.5 }
  render(
    <MarketTradesChart
      product="PF_ETHUSD"
      candles={candles}
      view="zoom"
      trades={[trades[0]!, picked]}
      selected={picked}
      onSelect={() => undefined}
      onShowAll={() => undefined}
    />,
  )
  expect(screen.getByTestId('movement-note')).toHaveTextContent(
    'entró con movimiento ×1,5',
  )
})

it('«Se podía ganar» pesa por el tamaño del analista, igual que lo ganado', () => {
  const base = { ...trades[0]!, net_bp: -40 }
  const { rerender } = render(
    <MarketTradesChart
      product="PF_ETHUSD"
      candles={candles}
      view="zoom"
      trades={[base]}
      selected={base}
      onSelect={() => undefined}
      onShowAll={() => undefined}
    />,
  )
  const plain = screen.getByText('Se podía ganar').parentElement!.textContent!
  const sized = { ...base, with_movement: true, size_mult: 1.5 }
  rerender(
    <MarketTradesChart
      product="PF_ETHUSD"
      candles={candles}
      view="zoom"
      trades={[sized]}
      selected={sized}
      onSelect={() => undefined}
      onShowAll={() => undefined}
    />,
  )
  const weighted =
    screen.getByText('Se podía ganar').parentElement!.textContent!
  const pb = (text: string) => Number(/\+(\d+) pb/u.exec(text)![1])
  expect(pb(weighted)).toBe(Math.round(pb(plain) * 1.5))
})

it('«Se podía ganar» nunca es menos que lo que se ganó (velas gruesas)', () => {
  const won = { ...trades[1]!, net_bp: 900 }
  render(
    <MarketTradesChart
      product="PF_ETHUSD"
      candles={candles}
      view="zoom"
      trades={[won]}
      selected={won}
      onSelect={() => undefined}
      onShowAll={() => undefined}
    />,
  )
  expect(screen.getByText('Se podía ganar').parentElement).toHaveTextContent(
    '+900 pb',
  )
})

it('si lo ganado iguala lo que se podía ganar, la mejor salida cae en la salida real', () => {
  const won = { ...trades[1]!, net_bp: 900 }
  render(
    <MarketTradesChart
      product="PF_ETHUSD"
      candles={candles}
      view="zoom"
      trades={[won]}
      selected={won}
      onSelect={() => undefined}
      onShowAll={() => undefined}
    />,
  )
  const path = screen.getByTestId('potential-path')
  const exit = document.querySelector('circle.fill-long')!
  expect(path.getAttribute('x2')).toBe(exit.getAttribute('cx'))
})
