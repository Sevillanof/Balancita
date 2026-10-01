import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import TerminalView from './TerminalView.tsx'

vi.mock('./TerminalChart.tsx', () => ({
  default: () => <div role="img" aria-label="Gráfico ilustrativo" />,
}))

describe('demo terminal', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('renders useful simulated data and keeps decisions separate from executions', () => {
    render(<TerminalView />)
    expect(
      screen.getByRole('heading', { name: 'Decisiones del motor' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: 'Posiciones y operaciones' }),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/Ejecución ilustrativa execution-01/),
    ).toBeInTheDocument()
    expect(
      screen.getAllByText('Decisión sin ejecución').length,
    ).toBeGreaterThan(0)
    expect(
      screen.getByText(/No representa spot, futuros ni resultados del motor/),
    ).toBeInTheDocument()
  })

  it('lets the user pause and resume only the local illustrative clock', async () => {
    const user = userEvent.setup()
    render(<TerminalView />)
    await user.click(
      screen.getByRole('button', { name: 'Reanudar simulación' }),
    )
    expect(
      screen.getByRole('button', { name: 'Pausar simulación' }),
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Pausar simulación' }))
    expect(
      screen.getByRole('button', { name: 'Reanudar simulación' }),
    ).toBeInTheDocument()
  })
})
