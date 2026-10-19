import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import GatePanel from './GatePanel.tsx'
import type {
  GateApi,
  GateOverview,
  GateRun,
} from '../infrastructure/gate-api.ts'

/* DATOS DE EJEMPLO: corridas inventadas solo para las pruebas de la pantalla. */
const base: GateRun = {
  id: 1,
  strategy_id: 'x2',
  kind: 'practice',
  status: 'done',
  verdict: 'NO PASA',
  progress: 100,
  phase: 'terminada',
  detail: null,
  eta_s: null,
  started_at: Date.UTC(2026, 9, 1),
  finished_at: Date.UTC(2026, 9, 1),
  attempts: 4,
  error: null,
  has_report: true,
}
const idle: GateOverview = {
  runs: [base],
  exam: { taken: false },
  running: null,
}

function fakeApi(overview: GateOverview | (() => GateOverview)): GateApi {
  return {
    overview: vi.fn(async () =>
      typeof overview === 'function' ? overview() : overview,
    ),
    start: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
  }
}

afterEach(() => vi.useRealTimers())

describe('GatePanel', () => {
  it('launches a practice test with the chosen date and products', async () => {
    const api = fakeApi(idle)
    render(<GatePanel strategyId="x2" strategyName="X2" api={api} />)
    await screen.findByTestId('attempts')
    expect(screen.getByTestId('attempts')).toHaveTextContent('intentos: 4')
    await userEvent.click(
      screen.getByRole('button', { name: 'Probar estrategia' }),
    )
    expect(screen.getByLabelText('Desde (fecha)')).toHaveValue('2025-01-01')
    expect(screen.getByLabelText(/PF_XBTUSD/)).toBeChecked()
    await userEvent.click(screen.getByLabelText(/PF_ETHUSD/))
    await userEvent.click(
      screen.getByRole('button', { name: 'Empezar prueba' }),
    )
    expect(api.start).toHaveBeenCalledWith('x2', {
      from: '2025-01-01',
      products: ['PF_XBTUSD', 'PF_ETHUSD'],
    })
  })

  it('asks for confirmation before the final exam and launches it', async () => {
    const api = fakeApi(idle)
    render(<GatePanel strategyId="x2" strategyName="X2" api={api} />)
    await screen.findByTestId('attempts')
    await userEvent.click(screen.getByRole('button', { name: 'Examen final' }))
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveTextContent(
      'El examen usa los últimos meses que la estrategia nunca vio. Se puede rendir una sola vez por versión. Para volver a rendirlo hay que crear una versión nueva.',
    )
    expect(api.start).not.toHaveBeenCalled()
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Rendir el examen' }),
    )
    expect(api.start).toHaveBeenCalledWith('x2', { exam: true })
  })

  it('shows the gate refusal when the exam cannot start', async () => {
    const api = fakeApi(idle)
    api.start = vi.fn(async () => {
      throw new Error('El examen final de esta versión ya se rindió.')
    })
    render(<GatePanel strategyId="x2" strategyName="X2" api={api} />)
    await screen.findByTestId('attempts')
    await userEvent.click(screen.getByRole('button', { name: 'Examen final' }))
    await userEvent.click(
      screen.getByRole('button', { name: 'Rendir el examen' }),
    )
    expect(await screen.findByTestId('gate-message')).toHaveTextContent(
      'ya se rindió',
    )
  })

  it('disables the exam once taken and shows date, verdict and download', async () => {
    render(
      <GatePanel
        strategyId="x2"
        strategyName="X2"
        api={fakeApi({
          ...idle,
          exam: {
            taken: true,
            same_version: true,
            status: 'done',
            verdict: 'PASA',
            date: '2026-10-05',
            run_id: 7,
          },
        })}
      />,
    )
    const taken = await screen.findByTestId('gate-exam-taken')
    expect(taken).toHaveTextContent('2026-10-05')
    expect(within(taken).getByTestId('verdict')).toHaveTextContent('PASA')
    expect(
      within(taken).getByRole('link', { name: 'Descargar informe (.md)' }),
    ).toHaveAttribute('href', '/api-strategies/gate/runs/7/report.md')
    expect(screen.getByRole('button', { name: 'Examen final' })).toBeDisabled()
  })

  it('shows progress, can cancel, and polls only while a run is active', async () => {
    let overview: GateOverview = {
      runs: [
        {
          ...base,
          id: 2,
          status: 'running',
          verdict: null,
          progress: 42.4,
          phase: 'simulando',
          eta_s: 330,
        },
      ],
      exam: { taken: false },
      running: { id: 2, strategy_id: 'x2' },
    }
    const api = fakeApi(() => overview)
    render(
      <GatePanel strategyId="x2" strategyName="X2" api={api} pollMs={50} />,
    )
    const running = await screen.findByTestId('gate-running')
    expect(running).toHaveTextContent('simulando')
    expect(running).toHaveTextContent('faltan ~6 min')
    expect(screen.getByRole('progressbar')).toHaveAttribute(
      'aria-valuenow',
      '42',
    )
    expect(
      screen.getByRole('button', { name: 'Probar estrategia' }),
    ).toBeDisabled()
    await waitFor(() =>
      expect(vi.mocked(api.overview).mock.calls.length).toBeGreaterThan(2),
    )
    await userEvent.click(screen.getByRole('button', { name: 'Cancelar' }))
    expect(api.cancel).toHaveBeenCalledWith(2)

    overview = { ...idle, runs: [{ ...base, id: 2, verdict: 'PASA' }] }
    await waitFor(() =>
      expect(screen.queryByTestId('gate-running')).not.toBeInTheDocument(),
    )
    expect(screen.getByTestId('gate-result')).toHaveTextContent('PASA')
    const calls = vi.mocked(api.overview).mock.calls.length
    await act(() => new Promise((resolve) => setTimeout(resolve, 200)))
    expect(vi.mocked(api.overview).mock.calls.length).toBe(calls)
  })

  it('names the strategy that is running and blocks launching here', async () => {
    render(
      <GatePanel
        strategyId="x2"
        strategyName="X2"
        api={fakeApi({
          ...idle,
          running: { id: 9, strategy_id: 'c29-otra-v1' },
        })}
        pollMs={10_000}
      />,
    )
    expect(await screen.findByTestId('gate-busy-hint')).toHaveTextContent(
      'c29-otra-v1',
    )
    expect(screen.getByRole('button', { name: 'Examen final' })).toBeDisabled()
    expect(
      screen.getByRole('button', { name: 'Probar estrategia' }),
    ).toBeDisabled()
  })

  it('lists the history with a download link and an empty state', async () => {
    const { unmount } = render(
      <GatePanel strategyId="x2" strategyName="X2" api={fakeApi(idle)} />,
    )
    const history = await screen.findByTestId('gate-history')
    expect(history).toHaveTextContent('Historial de pruebas (1)')
    expect(within(history).getByText('práctica')).toBeInTheDocument()
    expect(
      within(history).getByRole('link', { name: 'Descargar informe (.md)' }),
    ).toHaveAttribute('href', '/api-strategies/gate/runs/1/report.md')
    unmount()
    render(
      <GatePanel
        strategyId="x2"
        strategyName="X2"
        api={fakeApi({ ...idle, runs: [] })}
      />,
    )
    expect(
      await screen.findByText('Todavía no se hizo ninguna prueba.'),
    ).toBeInTheDocument()
  })
})
