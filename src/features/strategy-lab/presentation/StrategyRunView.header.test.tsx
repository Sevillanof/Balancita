import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import StrategyRunView from './StrategyRunView.tsx'
import type { GateApi } from '../infrastructure/gate-api.ts'
import type { RunVisualApi } from '../infrastructure/run-visual-api.ts'

vi.mock('../../trading-view/presentation/ApprovedTerminalChart.tsx', () => ({
  default: () => <div data-testid="chart" />,
}))

it('un solo botón «Probar» con las formas de probar adentro, y sin el analizador', async () => {
  const user = userEvent.setup()
  render(
    <StrategyRunView
      strategyId="x2"
      strategyName="X2 Breakout"
      version={1}
      gate={
        {
          overview: vi.fn(async () => ({
            runs: [],
            exam: { taken: false },
            running: null,
          })),
        } as unknown as GateApi
      }
      visual={{} as RunVisualApi}
      kind="rules"
    />,
  )
  const probe = await screen.findByRole('button', { name: 'Probar ▾' })
  expect(probe).toHaveAttribute('aria-expanded', 'false')
  await user.click(probe)
  expect(probe).toHaveAttribute('aria-expanded', 'true')
  expect(screen.getByRole('button', { name: 'Testear' })).toBeInTheDocument()
  expect(
    screen.getByRole('button', { name: 'Explorar con VectorBT' }),
  ).toBeInTheDocument()
  expect(
    screen.queryByRole('button', { name: 'Analizador de señales' }),
  ).toBeNull()
  expect(screen.getByTestId('stage-where')).toHaveTextContent(
    'En hipótesis. Todavía no tiene pruebas. Siguiente: Optimizar.',
  )
})
