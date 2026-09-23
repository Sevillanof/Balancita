import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import SimulationsPanel from './SimulationsPanel'
import type { SimulationsReportFile } from './simulations-types'

function reportFile(): SimulationsReportFile {
  return {
    version: 'simulations-report-file.v1',
    generatedAt: 1_000,
    instrumentId: 'BTC-EUR',
    importVersion: 'kraken-observations.v1',
    datasetHash: 'a'.repeat(64),
    manifestHash: 'b'.repeat(64),
    selectionPct: 0.7,
    reports: [
      {
        version: 'simulations-comparison.v1',
        instrumentId: 'BTC-EUR',
        horizon: '15m',
        datasetHash: 'a'.repeat(64),
        manifestHash: 'b'.repeat(64),
        neutralBand: 0.0015,
        selectionPct: 0.7,
        selectionCutTimestamp: 3_000,
        selectionCount: 70,
        validationCount: 30,
        rows: [
          {
            candidateId: 'technical-default',
            ruleVersion: 'technical-direction.v1',
            paramSetVersion: 'technical-defaults.v1',
            runId: 'sim:x:15m:technical-default',
            forecastCount: 35,
            issuedCount: 30,
            coverage: 0.857,
            brier: 0.5,
            accuracy: 0.6,
            logLoss: 0.9,
            calibration: [],
            validationBrier: 0.55,
            validationCoverage: 0.8,
          },
          {
            candidateId: 'strict-quorum',
            ruleVersion: 'simulation-strict-quorum.v1',
            paramSetVersion: 'technical-defaults.v1',
            runId: 'sim:x:15m:strict-quorum',
            forecastCount: 35,
            issuedCount: 20,
            coverage: 0.571,
            brier: 0.7,
            accuracy: 0.5,
            logLoss: 1.1,
            calibration: [],
            validationBrier: null,
            validationCoverage: null,
          },
        ],
        baselines: {
          uniform: { brier: 0.6667, accuracy: 0.33 },
          noChange: { brier: 0.8, accuracy: 0.4 },
          momentum: { brier: 0.6, accuracy: 0.55 },
        },
        winner: {
          candidateId: 'technical-default',
          selectionBrier: 0.5,
          validationBrier: 0.55,
          validationCount: 15,
        },
        limitations: ['Solo comparación descriptiva.'],
        contentHash: 'c'.repeat(64),
      },
    ],
  }
}

describe('SimulationsPanel', () => {
  it('announces loading while the report is fetched', () => {
    render(
      <SimulationsPanel
        status="loading"
        file={null}
        error={null}
        onRetry={() => {}}
      />,
    )
    expect(screen.getByRole('status')).toHaveTextContent(
      /cargando simulaciones/i,
    )
  })

  it('shows the empty state with the generation command', () => {
    render(
      <SimulationsPanel
        status="empty"
        file={null}
        error={null}
        onRetry={() => {}}
      />,
    )
    expect(screen.getByRole('status')).toHaveTextContent(
      /aún no hay informe de simulaciones/i,
    )
    expect(
      screen.getByText(/pnpm --dir server simulations:run/),
    ).toBeInTheDocument()
  })

  it('shows the error state with a retry action', async () => {
    const user = userEvent.setup()
    const onRetry = vi.fn()
    render(
      <SimulationsPanel
        status="error"
        file={null}
        error={new Error('boom')}
        onRetry={onRetry}
      />,
    )
    expect(screen.getByRole('alert')).toHaveTextContent(
      /no se pudieron cargar las simulaciones/i,
    )
    await user.click(screen.getByRole('button', { name: /reintentar/i }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('renders every candidate row sorted by Brier with baselines and provenance', () => {
    render(
      <SimulationsPanel
        status="ready"
        file={reportFile()}
        error={null}
        onRetry={() => {}}
      />,
    )
    const table = screen.getByRole('table', {
      name: /comparación de estrategias/i,
    })
    const rows = within(table).getAllByRole('row')
    // Header + 2 candidates + 3 baselines.
    expect(rows).toHaveLength(6)
    const firstCells = within(rows[1]!).getAllByRole('rowheader')
    expect(firstCells[0]).toHaveTextContent('technical-default')
    expect(screen.getByText(/uniforme/i)).toBeInTheDocument()
    expect(screen.getByText(/sin cambio/i)).toBeInTheDocument()
    expect(screen.getByText(/momentum/i)).toBeInTheDocument()
    // Provenance footer.
    expect(screen.getByText(/procedencia/i)).toBeInTheDocument()
    expect(screen.getByText(/sim:x:15m:technical-default/)).toBeInTheDocument()
    // Limitations and educational disclaimer.
    expect(
      screen.getByText(/solo comparación descriptiva/i),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/no es asesoramiento financiero/i),
    ).toBeInTheDocument()
  })
})
