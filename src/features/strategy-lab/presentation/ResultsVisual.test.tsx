import { render, screen } from '@testing-library/react'
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
