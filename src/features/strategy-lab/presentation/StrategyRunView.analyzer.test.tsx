import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import StrategyRunView from './StrategyRunView.tsx'
import type { GateApi } from '../infrastructure/gate-api.ts'
import type { RunVisualApi } from '../infrastructure/run-visual-api.ts'
import { smallAnalyzerApi } from '../testing/analyzer-fixture.ts'

vi.mock('../../trading-view/presentation/ApprovedTerminalChart.tsx', () => ({
  default: () => <div data-testid="chart" />,
}))

it('el botón «Analizador de señales» abre el modal y al cerrar devuelve el foco', async () => {
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
      analyzer={smallAnalyzerApi()}
      kind="rules"
    />,
  )
  const button = await screen.findByRole('button', {
    name: 'Analizador de señales',
  })
  await user.click(button)
  expect(
    await screen.findByRole('dialog', { name: 'Analizador de señales' }),
  ).toBeInTheDocument()
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(button).toHaveFocus()
})
