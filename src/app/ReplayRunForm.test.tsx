import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ReplayRunForm from './ReplayRunForm.tsx'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const run = {
  id: 'created-run',
  strategyId: 'micro-bollinger-reversion',
  trades: [],
  window: { start_time: 1_700_000_000_000, end_time: 1_700_000_060_000 },
  netPnlEur: 0,
  candlesEvaluated: 0,
  sampleCount: 0,
  rawSignalsCount: 0,
  gateRejectionsCount: 0,
  brierScoreMulticlass: null,
  winRatePct: null,
  profitFactor: null,
}

describe('ReplayRunForm', () => {
  it('maps supported controls to the existing native API request', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => run }))
    vi.stubGlobal('fetch', fetchMock)
    const onRunCreated = vi.fn()
    const user = userEvent.setup()
    render(
      <ReplayRunForm
        getSelectionRevision={() => 0}
        onRunCreated={onRunCreated}
      />,
    )

    await user.selectOptions(
      screen.getByLabelText('Estrategia'),
      'micro-bollinger-reversion',
    )
    await user.type(
      screen.getByLabelText('Inicio UTC (ISO 8601)'),
      '2023-11-14T22:13:20Z',
    )
    await user.type(
      screen.getByLabelText('Fin UTC (ISO 8601)'),
      '2023-11-14T22:14:20Z',
    )
    await user.clear(screen.getByLabelText('Capital inicial (EUR)'))
    await user.type(screen.getByLabelText('Capital inicial (EUR)'), '42')
    await user.click(
      screen.getByRole('button', { name: 'Ejecutar replay TypeScript' }),
    )

    expect(
      await screen.findByRole('button', {
        name: 'Ejecutar replay TypeScript',
      }),
    ).toBeEnabled()
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/replay/fast-run',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          strategy_id: 'micro-bollinger-reversion',
          start_time: Date.parse('2023-11-14T22:13:20Z'),
          end_time: Date.parse('2023-11-14T22:14:20Z'),
          ticket_eur: 42,
        }),
      }),
    )
    expect(onRunCreated).toHaveBeenCalledWith(run, 0)
  })

  it('keeps Python runtime failures explicit without a TypeScript fallback', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      json: async () => ({ error: { message: 'Python runtime unavailable.' } }),
    }))
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()
    render(
      <ReplayRunForm getSelectionRevision={() => 0} onRunCreated={vi.fn()} />,
    )

    await user.selectOptions(screen.getByLabelText('Motor'), 'python-ledger')
    await user.type(
      screen.getByLabelText('Inicio UTC (ISO 8601)'),
      '2023-11-14T22:13:20Z',
    )
    await user.type(
      screen.getByLabelText('Fin UTC (ISO 8601)'),
      '2023-11-14T22:14:20Z',
    )
    await user.click(
      screen.getByRole('button', { name: 'Ejecutar replay Python ledger' }),
    )

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Python runtime unavailable.',
    )
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/replay/python-ledger-run',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('maps the same supported UTC window and initial cash to the Python ledger endpoint', async () => {
    const pythonRun = {
      ...run,
      strategyId: 'micro-trend-pullback',
      ledgerOwner: 'python-ledger',
      sizingModel: 'python-long-flat-ledger.v1',
      pythonLedger: {
        ledger: { fills: [] },
        executionAudit: { fills: [] },
      },
    }
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => pythonRun,
    }))
    vi.stubGlobal('fetch', fetchMock)
    const onRunCreated = vi.fn()
    const user = userEvent.setup()
    render(
      <ReplayRunForm
        getSelectionRevision={() => 0}
        onRunCreated={onRunCreated}
      />,
    )

    await user.selectOptions(screen.getByLabelText('Motor'), 'python-ledger')
    await user.type(
      screen.getByLabelText('Inicio UTC (ISO 8601)'),
      '2023-11-14T22:13:20Z',
    )
    await user.type(
      screen.getByLabelText('Fin UTC (ISO 8601)'),
      '2023-11-14T22:14:20Z',
    )
    await user.click(
      screen.getByRole('button', { name: 'Ejecutar replay Python ledger' }),
    )

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/replay/python-ledger-run',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          strategy_id: 'micro-trend-pullback',
          start_time: Date.parse('2023-11-14T22:13:20Z'),
          end_time: Date.parse('2023-11-14T22:14:20Z'),
          ticket_eur: 30,
        }),
      }),
    )
    expect(onRunCreated).toHaveBeenCalledWith(pythonRun, 0)
  })

  it('rejects non-UTC input before making a request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()
    render(
      <ReplayRunForm getSelectionRevision={() => 0} onRunCreated={vi.fn()} />,
    )

    await user.type(
      screen.getByLabelText('Inicio UTC (ISO 8601)'),
      '2023-11-14T22:13:20',
    )
    await user.type(
      screen.getByLabelText('Fin UTC (ISO 8601)'),
      '2023-11-14T22:14:20Z',
    )
    await user.click(
      screen.getByRole('button', { name: 'Ejecutar replay TypeScript' }),
    )

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'UTC ISO 8601 válida',
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not retry a submission automatically when the transport outcome is unknown', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    })
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()
    render(
      <ReplayRunForm getSelectionRevision={() => 0} onRunCreated={vi.fn()} />,
    )

    await user.type(
      screen.getByLabelText('Inicio UTC (ISO 8601)'),
      '2023-11-14T22:13:20Z',
    )
    await user.type(
      screen.getByLabelText('Fin UTC (ISO 8601)'),
      '2023-11-14T22:14:20Z',
    )
    await user.click(
      screen.getByRole('button', { name: 'Ejecutar replay TypeScript' }),
    )

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Revisá el historial antes de volver a enviarlo',
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
