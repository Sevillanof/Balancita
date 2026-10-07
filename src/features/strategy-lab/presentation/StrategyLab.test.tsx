import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import StrategyLab from './StrategyLab.tsx'
import { syntheticCandles } from '../infrastructure/lab-candles.ts'
import { LAB_STORAGE_KEY } from '../infrastructure/local-strategy-store.ts'

vi.mock('../../trading-view/presentation/ApprovedTerminalChart.tsx', () => ({
  default: ({ markers }: { markers: unknown[] }) => (
    <div data-testid="lab-chart">{markers.length} marcas</div>
  ),
}))

const loadCandles = () =>
  Promise.resolve({ source: 'live' as const, candles: syntheticCandles() })

async function renderLab() {
  render(
    <StrategyLab loadCandles={loadCandles} now={() => 1_791_331_200_000} />,
  )
  await screen.findByText(/Velas reales de Terminal/)
}

function ranking() {
  return screen.getByRole('region', { name: 'Ranking por rentabilidad' })
}

describe('StrategyLab', () => {
  beforeEach(() => window.localStorage.clear())

  it('ranks C25-C28 and buy and hold on the terminal candles, with profitability and hit rate first', async () => {
    await renderLab()
    const list = within(ranking())
    for (const name of [
      'C25 · retroceso',
      'C26 · reversión',
      'C27 · ruptura',
      'C28 · adaptador',
      'Comprar y mantener',
    ])
      expect(list.getByText(name)).toBeInTheDocument()
    expect(screen.getAllByText('Rentabilidad').length).toBeGreaterThan(0)
    expect(screen.getByText('Acierto')).toBeInTheDocument()
    expect(screen.getByTestId('lab-chart')).toBeInTheDocument()
  })

  it('turns several values of one parameter into variants in the ranking', async () => {
    const user = userEvent.setup()
    await renderLab()
    const input = screen.getByDisplayValue('45')
    await user.clear(input)
    await user.type(input, '35; 40')
    expect(
      within(ranking()).getByText('C25 · retroceso · rsi_min 35'),
    ).toBeInTheDocument()
    expect(
      within(ranking()).getByText('C25 · retroceso · rsi_min 40'),
    ).toBeInTheDocument()
    expect(screen.getByText('2 variantes en el ranking')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Guardar' })).toBeDisabled()

    await user.click(
      within(ranking()).getByText('C25 · retroceso · rsi_min 40'),
    )
    expect(screen.getByRole('button', { name: 'Guardar' })).toBeEnabled()
  })

  it('saves an edit as a new strategy and leaves the original as it is', async () => {
    const user = userEvent.setup()
    await renderLab()
    const input = screen.getByDisplayValue('45')
    await user.clear(input)
    await user.type(input, '40')
    await user.click(screen.getByLabelText('Crear estrategia nueva'))
    await user.click(screen.getByRole('button', { name: 'Guardar' }))

    expect(screen.getByRole('status')).toHaveTextContent(
      'Guardada como C29 · retroceso. C25 · retroceso quedó como estaba.',
    )
    const stored = JSON.parse(window.localStorage.getItem(LAB_STORAGE_KEY)!)
    expect(stored[0].spec).toMatchObject({
      id: 'c29-retroceso',
      version: 1,
      params: { rsi_min: '40' },
    })
    expect(within(ranking()).getByText('C25 · retroceso')).toBeInTheDocument()
  })

  it('modifies the same strategy as a new version', async () => {
    const user = userEvent.setup()
    await renderLab()
    const input = screen.getByDisplayValue('45')
    await user.clear(input)
    await user.type(input, '42')
    await user.click(screen.getByRole('button', { name: 'Guardar' }))
    expect(screen.getByRole('status')).toHaveTextContent(
      'Guardada C25 · retroceso v2.',
    )
    expect(
      within(ranking()).getByText('C25 · retroceso v2'),
    ).toBeInTheDocument()
  })

  it('imports a JSON spec as a draft and reports invalid ones', async () => {
    const user = userEvent.setup()
    await renderLab()
    await user.click(screen.getByRole('button', { name: 'Importar' }))
    const box = screen.getByLabelText(/Pegá una estrategia en JSON/)
    await user.click(box)
    await user.paste('{"schema":"otro"}')
    await user.click(
      screen.getByRole('button', { name: 'Importar como borrador' }),
    )
    expect(screen.getByRole('alert')).toHaveTextContent(
      'schema debe ser "balancita-strategy.v1"',
    )
  })
})
