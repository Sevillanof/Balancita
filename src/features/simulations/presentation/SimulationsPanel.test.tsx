import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import SimulationsPanel from './SimulationsPanel.tsx'
import type { SimulationsReportFile } from './simulations-types.ts'

const chartMocks = vi.hoisted(() => {
  const series = { setData: vi.fn(), update: vi.fn() }
  const chart = {
    addSeries: vi.fn(() => series),
    timeScale: vi.fn(() => ({ fitContent: vi.fn() })),
    remove: vi.fn(),
  }
  return { createChart: vi.fn(() => chart) }
})

vi.mock('lightweight-charts', () => ({
  ColorType: { Solid: 'solid' },
  CandlestickSeries: {},
  LineSeries: {},
  createChart: chartMocks.createChart,
}))

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
        profitability: {
          ruleVersion: 'strategy-rule.v1',
          costsVersion: 'costs.v1',
          costs: { commissionRate: 0.001, slippageRate: 0.0005 },
          startingCash: 10_000,
          entryThreshold: 0.55,
          exitUpThreshold: 0.45,
          exitDownThreshold: 0.55,
          equityPointsDownsampledTo: 60,
          candidates: [
            {
              candidateId: 'technical-default',
              selection: profitabilitySlice(2.5, 3),
              validation: profitabilitySlice(-1.2, 1),
            },
            {
              candidateId: 'strict-quorum',
              selection: profitabilitySlice(0.5, 0),
              validation: profitabilitySlice(0.0, 0),
            },
          ],
          baselines: {
            uniform: baselineEntry('uniform'),
            noChange: baselineEntry('noChange'),
            momentum: baselineEntry('momentum'),
          },
          buyAndHoldEquity: {
            selection: [
              { time: 1_000, equity: 10_000 },
              { time: 2_000, equity: 10_100 },
            ],
            validation: [
              { time: 3_000, equity: 10_100 },
              { time: 4_000, equity: 10_050 },
            ],
          },
        },
      },
    ],
  }
}

function profitabilitySlice(netReturnPct: number, tradeCount: number) {
  return {
    metrics: {
      netReturnPct,
      tradeCount,
      winRate: tradeCount === 0 ? null : 0.5,
      profitFactor: tradeCount === 0 ? null : 1.4,
      maxDrawdownPct: 1.5,
      exposurePct: 40,
      finalEquity: 10_000 * (1 + netReturnPct / 100),
    },
    equityCurve: [
      { time: 1_000, equity: 10_000 },
      { time: 2_000, equity: 10_000 * (1 + netReturnPct / 100) },
    ],
    ledgerHash: 'd'.repeat(64),
  }
}

function baselineEntry(candidateId: string) {
  return {
    candidateId,
    selection: profitabilitySlice(1.0, 1),
    validation: profitabilitySlice(0.5, 1),
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

  it('renders candidate cards with selection and validation profitability', () => {
    render(
      <SimulationsPanel
        status="ready"
        file={reportFile()}
        error={null}
        onRetry={() => {}}
      />,
    )
    const card = screen.getByRole('article', {
      name: /technical-default/i,
    })
    expect(card).toHaveTextContent(/rentabilidad neta/i)
    expect(card).toHaveTextContent(/operaciones/i)
    expect(card).toHaveTextContent(/aciertos/i)
    expect(card).toHaveTextContent(/retroceso máximo/i)
    expect(card).toHaveTextContent(/exposición/i)
    expect(card).toHaveTextContent(/cobertura/i)
    expect(card).toHaveTextContent(/brier/i)
    expect(card).toHaveTextContent(/profit factor/i)
    // Validation values are emphasized in their own section.
    expect(
      within(card).getByRole('region', { name: 'Validación' }),
    ).toBeInTheDocument()
    // Equity chart: candidate vs buy-and-hold on the validation window.
    expect(
      within(card).getByRole('img', {
        name: /curva de rentabilidad.*validación/i,
      }),
    ).toBeInTheDocument()
  })

  it('renders baseline cards including buy-and-hold with provenance and disclaimer', () => {
    render(
      <SimulationsPanel
        status="ready"
        file={reportFile()}
        error={null}
        onRetry={() => {}}
      />,
    )
    expect(
      screen.getByRole('article', { name: /comprar y mantener/i }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('article', { name: /uniforme/i }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('article', { name: /momentum/i }),
    ).toBeInTheDocument()
    // Provenance footer with rule + costs versions.
    expect(screen.getByText(/procedencia/i)).toBeInTheDocument()
    expect(screen.getByText(/strategy-rule\.v1/)).toBeInTheDocument()
    expect(screen.getByText(/costs\.v1/)).toBeInTheDocument()
    expect(screen.getByText(/sim:x:15m:technical-default/)).toBeInTheDocument()
    // Limitations and educational disclaimer.
    expect(
      screen.getByText(/solo comparación descriptiva/i),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/no es asesoramiento financiero/i),
    ).toBeInTheDocument()
  })

  it('renders forecast-only cards when the report has no profitability block', () => {
    const file = reportFile()
    const withoutProfitability: SimulationsReportFile = {
      ...file,
      reports: file.reports.map((report) => ({
        ...report,
        profitability: null,
      })),
    }
    render(
      <SimulationsPanel
        status="ready"
        file={withoutProfitability}
        error={null}
        onRetry={() => {}}
      />,
    )
    expect(
      screen.getByRole('article', { name: /technical-default/i }),
    ).toHaveTextContent(/brier/i)
    expect(screen.getByText(/sin bloque de rentabilidad/i)).toBeInTheDocument()
  })

  it('places refresh in the header and switches horizons without hiding candidates', async () => {
    const file = reportFile()
    const onRefresh = vi.fn()
    render(
      <SimulationsPanel
        status="ready"
        file={{
          ...file,
          reports: [
            file.reports[0]!,
            {
              ...file.reports[0]!,
              horizon: '1h',
              contentHash: 'e'.repeat(64),
            },
          ],
        }}
        error={null}
        onRetry={() => {}}
        onRefresh={onRefresh}
      />,
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Actualizar simulaciones' }),
    )
    expect(onRefresh).toHaveBeenCalledOnce()
    expect(screen.getByRole('tab', { name: '15m' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    await userEvent.click(screen.getByRole('tab', { name: '1h' }))
    expect(screen.getByRole('tab', { name: '1h' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    expect(
      screen.getByRole('article', { name: 'Comparación en horizonte 1h' }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('article', { name: 'Comparación en horizonte 15m' }),
    ).not.toBeInTheDocument()
  })
})
