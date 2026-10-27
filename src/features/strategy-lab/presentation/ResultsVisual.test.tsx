import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import ResultsVisual from './ResultsVisual.tsx'

const trade = (bp: number, day: number) => ({
  label: 'ETH largo',
  entryMs: Date.UTC(2025, 10, day),
  exitMs: Date.UTC(2025, 10, day, 12),
  bp,
  why: 'cerró porque el maestro se dio vuelta',
})

describe('ResultsVisual', () => {
  it('shows the net total big in USD, one bar per operation and a total per series', () => {
    render(
      <ResultsVisual
        notionalUsd={100}
        series={[
          {
            id: 'a',
            label: 'La fórmula',
            trades: [trade(150, 1), trade(-50, 2), trade(100, 3)],
          },
          {
            id: 'b',
            label: 'Siempre largo',
            trades: [trade(-20, 1), trade(-30, 2)],
          },
        ]}
      />,
    )
    expect(screen.getByTestId('results-total')).toHaveTextContent('+2,00 USD')
    expect(
      screen.getByText(/3 operaciones · 67 % ganadoras/),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('img', { name: 'Curva de saldo acumulado' }),
    ).toBeInTheDocument()
    const bars = screen.getByRole('img', {
      name: 'Resultado de cada operación',
    })
    expect(bars.querySelectorAll('rect')).toHaveLength(3)
    expect(
      screen.getByRole('list', { name: 'Ganancia total por variante' }),
    ).toHaveTextContent('−0,50 USD')
  })

  it('says there were no operations instead of drawing an empty chart', () => {
    render(
      <ResultsVisual
        notionalUsd={100}
        series={[{ id: 'a', label: 'La fórmula', trades: [] }]}
      />,
    )
    expect(screen.getByTestId('results-total')).toHaveTextContent(
      'Sin operaciones',
    )
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('falls back to basis points when the notional is unknown', () => {
    render(
      <ResultsVisual
        notionalUsd={0}
        series={[{ id: 'a', label: 'X', trades: [trade(40, 1)] }]}
      />,
    )
    expect(screen.getByTestId('results-total')).toHaveTextContent('+40,0 pb')
  })
})

describe('ResultsVisual market line', () => {
  it('draws the price as buy and hold and lists it in the legend', () => {
    render(
      <ResultsVisual
        notionalUsd={100}
        series={[{ id: 'a', label: 'La fórmula', trades: [trade(150, 2)] }]}
        market={[
          {
            id: 'eth',
            label: 'Mercado: ETH comprando y manteniendo',
            points: [
              [Date.UTC(2025, 10, 1), 2000],
              [Date.UTC(2025, 10, 3), 2200],
            ],
          },
        ]}
      />,
    )
    expect(
      screen.getByText('Mercado: ETH comprando y manteniendo', {
        selector: 'span',
      }),
    ).toBeInTheDocument()
    expect(
      screen
        .getByRole('img', { name: 'Curva de saldo acumulado' })
        .querySelectorAll('path'),
    ).toHaveLength(2)
  })
})

describe('ResultsVisual one operation', () => {
  it('opens the price around a bar with entry and exit marks, or hands the click to the screen', () => {
    const t = {
      ...trade(150, 2),
      product: 'PF_ETHUSD',
      side: 1 as const,
      maestro: 2,
      portero: true,
      exit: 'vuelta',
    }
    const points: Array<[number, number]> = [0, 6, 12, 18, 24, 30, 36, 42].map(
      (h) => [Date.UTC(2025, 10, 1) + h * 3600000, 2000 + h * 3],
    )
    const props = {
      notionalUsd: 100,
      series: [{ id: 'a', label: 'F', trades: [t] }],
      market: [{ id: 'PF_ETHUSD', label: 'M', points }],
    }
    const { unmount } = render(<ResultsVisual {...props} />)
    expect(screen.queryByTestId('trade-focus')).toBeNull()
    fireEvent.click(screen.getAllByRole('button')[0]!)
    const focus = screen.getByTestId('trade-focus')
    expect(focus).toHaveTextContent('LARGO ▲▲ ✓')
    expect(focus).toHaveTextContent('↩ maestro')
    unmount()
    const picked: unknown[] = []
    render(<ResultsVisual {...props} onPick={(x) => picked.push(x)} />)
    fireEvent.click(screen.getAllByRole('button')[0]!)
    expect(picked).toHaveLength(1)
    expect(screen.queryByTestId('trade-focus')).toBeNull()
  })
})
