import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import TerminalView from './TerminalView.tsx'

vi.mock('./TerminalChart.tsx', () => ({
  default: (props: { onBucketSelect: (time: number) => void }) => (
    <div role="img" aria-label="Gráfico ilustrativo">
      <button type="button" onClick={() => props.onBucketSelect(1790785500)}>
        Seleccionar marcador entrada
      </button>
      <button type="button" onClick={() => props.onBucketSelect(1790784000)}>
        Seleccionar vela
      </button>
    </div>
  ),
}))

describe('demo terminal', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('renders useful simulated data and keeps decisions separate from executions', () => {
    render(<TerminalView />)
    const approvedLayout = screen.getByTestId('approved-terminal-layout')
    expect(screen.getByTestId('approved-market-row')).toBeInTheDocument()
    expect(screen.getByTestId('approved-chart-toolbar')).toBeInTheDocument()
    expect(screen.getByTestId('approved-portfolio-tables')).toBeInTheDocument()
    expect(approvedLayout).toHaveClass('demo-terminal__grid')
    expect(
      approvedLayout.querySelector(
        ':scope > [aria-label="Gráfico de mercado"]',
      ),
    ).not.toBeNull()
    expect(
      approvedLayout.querySelector(
        ':scope > [aria-label="Decisiones del motor"]',
      ),
    ).not.toBeNull()
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

  it('shares selection between chart markers and visible decision rows', async () => {
    const user = userEvent.setup()
    render(<TerminalView />)
    await user.click(
      screen.getByRole('button', { name: 'Seleccionar marcador entrada' }),
    )
    expect(
      screen.getByRole('button', {
        name: /Entrada larga.*Ejecución ilustrativa execution-01/,
      }),
    ).toHaveAttribute('aria-pressed', 'true')
    await user.click(screen.getByRole('checkbox', { name: 'Descartes' }))
    expect(
      screen.queryByRole('button', { name: /Descartada.*Ruptura descartada/ }),
    ).not.toBeInTheDocument()
  })

  it('offers an event chooser when a chart bucket contains multiple events', async () => {
    const user = userEvent.setup()
    render(<TerminalView />)
    await user.click(screen.getByRole('button', { name: '1h' }))
    await user.click(screen.getByRole('button', { name: 'Seleccionar vela' }))
    expect(
      screen.getByRole('dialog', { name: 'Decisiones en esta vela' }),
    ).toBeInTheDocument()
  })

  it('moves selection to a visible event when its kind is filtered out', async () => {
    const user = userEvent.setup()
    render(<TerminalView />)
    const discard = screen.getByRole('button', {
      name: /Descartada.*Ruptura descartada/,
    })
    await user.click(discard)
    expect(discard).toHaveAttribute('aria-pressed', 'true')
    await user.click(screen.getByRole('checkbox', { name: 'Descartes' }))
    expect(
      screen.queryByRole('button', { name: /Descartada.*Ruptura descartada/ }),
    ).not.toBeInTheDocument()
    expect(
      document.querySelectorAll('.demo-terminal__event[aria-pressed="true"]'),
    ).toHaveLength(1)
  })
})
