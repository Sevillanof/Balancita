import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type {
  AnalysisInput,
  AnalysisProvider,
  AnalysisResult,
} from '../../../domain/analysis.ts'
import type { PortfolioRepository } from '../../portfolio/domain/portfolio.ts'
import {
  BTC_EUR,
  makeCandle,
  makeQuote,
} from '../../../shared/testing/fake-market-data-provider'
import AnalysisPanel from './AnalysisPanel.tsx'

class FakeAnalysisProvider implements AnalysisProvider {
  analyzeCall = vi.fn<(input: AnalysisInput) => Promise<AnalysisResult>>()
  analyze = this.analyzeCall
}

function resultFor(overrides: Partial<AnalysisResult> = {}): AnalysisResult {
  return {
    instrumentId: 'BTC-EUR',
    classification: 'watch',
    recommendation: 'hold',
    reasons: ['Latest quote moved up 2.50%; noteworthy move.'],
    warnings: [
      'No position held; this assessment covers instrument surveillance only.',
    ],
    volatility: {
      lookbackCandles: 2,
      averageTrueRangePercent: 2,
      level: 'low',
    },
    disclaimer: 'Recomendación educativa: no ejecuta órdenes.',
    ...overrides,
  }
}

const CANDLES = [makeCandle(), makeCandle({ time: '2024-01-02T00:00:00.000Z' })]

function repositoryWithHoldings(): PortfolioRepository {
  return {
    list: vi.fn().mockResolvedValue([]),
    add: vi.fn(),
    remove: vi.fn(),
    clear: vi.fn(),
  }
}

async function renderPanel(options: {
  analysis: AnalysisProvider
  quote?: ReturnType<typeof makeQuote>
}) {
  const repository = repositoryWithHoldings()
  const view = render(
    <AnalysisPanel
      analysis={options.analysis}
      portfolioRepository={repository}
      instrument={BTC_EUR}
      quote={options.quote}
      candles={CANDLES}
    />,
  )
  return { ...view, repository }
}

describe('AnalysisPanel', () => {
  it('shows a disabled Analyze button until a quote exists', async () => {
    const analysis = new FakeAnalysisProvider()
    const { rerender } = await renderPanel({ analysis })
    const button = screen.getByRole('button', { name: /analizar/i })
    expect(button).toBeDisabled()

    rerender(
      <AnalysisPanel
        analysis={analysis}
        portfolioRepository={repositoryWithHoldings()}
        instrument={BTC_EUR}
        quote={makeQuote({ instrumentId: 'BTC-EUR' })}
        candles={CANDLES}
      />,
    )
    expect(screen.getByRole('button', { name: /analizar/i })).toBeEnabled()
  })

  it('runs analysis only on the click and renders verdict, reasons and warnings', async () => {
    const user = userEvent.setup()
    const analysis = new FakeAnalysisProvider()
    analysis.analyzeCall.mockResolvedValue(resultFor())
    renderPanel({ analysis, quote: makeQuote({ instrumentId: 'BTC-EUR' }) })

    await user.click(screen.getByRole('button', { name: /analizar/i }))
    await waitFor(() =>
      expect(screen.getByText('Vigilar', { exact: true })).toBeInTheDocument(),
    )

    expect(analysis.analyzeCall).toHaveBeenCalledTimes(1)
    expect(screen.getByLabelText('Razones del análisis')).toHaveTextContent(
      'Latest quote moved up 2.50%; noteworthy move.',
    )
    expect(
      screen.getByLabelText('Advertencias del análisis'),
    ).toHaveTextContent(
      'No position held; this assessment covers instrument surveillance only.',
    )
  })

  it('announces loading while the analysis is in flight', async () => {
    const user = userEvent.setup()
    const analysis = new FakeAnalysisProvider()
    let resolveCall: (result: AnalysisResult) => void = () => {}
    analysis.analyzeCall.mockImplementation(
      () =>
        new Promise<AnalysisResult>((resolve) => {
          resolveCall = resolve
        }),
    )
    renderPanel({ analysis, quote: makeQuote({ instrumentId: 'BTC-EUR' }) })

    await user.click(screen.getByRole('button', { name: /analizar/i }))

    const status = screen.getByRole('status')
    expect(status).toHaveTextContent(/analizando/i)
    expect(status).toHaveAttribute('aria-busy', 'true')

    await act(async () => resolveCall(resultFor()))
    await waitFor(() =>
      expect(screen.getByText('Vigilar', { exact: true })).toBeInTheDocument(),
    )
  })

  it('surfaces the failure as an alert and lets the user retry', async () => {
    const user = userEvent.setup()
    const analysis = new FakeAnalysisProvider()
    analysis.analyzeCall.mockRejectedValue(new Error('analysis backend down'))
    renderPanel({ analysis, quote: makeQuote({ instrumentId: 'BTC-EUR' }) })

    await user.click(screen.getByRole('button', { name: /analizar/i }))

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'No se pudo completar el análisis',
      ),
    )
    expect(screen.getByRole('button', { name: /analizar/i })).toBeEnabled()
  })

  it('never runs automatically on render or when the quote object changes', async () => {
    const analysis = new FakeAnalysisProvider()
    analysis.analyzeCall.mockResolvedValue(resultFor())
    const { rerender } = await renderPanel({
      analysis,
      quote: makeQuote({ instrumentId: 'BTC-EUR' }),
    })
    expect(analysis.analyzeCall).not.toHaveBeenCalled()

    rerender(
      <AnalysisPanel
        analysis={analysis}
        portfolioRepository={repositoryWithHoldings()}
        instrument={BTC_EUR}
        quote={makeQuote({ instrumentId: 'BTC-EUR', price: 60_100 })}
        candles={CANDLES}
      />,
    )
    expect(analysis.analyzeCall).not.toHaveBeenCalled()
  })

  it('does not call order execution when analyzing or showing a recommendation', async () => {
    const user = userEvent.setup()
    const analysis = new FakeAnalysisProvider()
    const preview = vi.fn()
    const submit = vi.fn()
    analysis.analyzeCall.mockResolvedValue(resultFor({ recommendation: 'buy' }))
    const analysisWithOrderSurface = Object.assign(analysis, {
      preview,
      submit,
    })
    renderPanel({
      analysis: analysisWithOrderSurface,
      quote: makeQuote({ instrumentId: 'BTC-EUR' }),
    })

    await user.click(screen.getByRole('button', { name: /analizar/i }))
    await waitFor(() =>
      expect(screen.getByText('Comprar', { exact: true })).toBeInTheDocument(),
    )

    expect(preview).not.toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalled()
  })
})

describe('AnalysisPanel AI mode', () => {
  it('changes its title and source label in AI mode', async () => {
    const user = userEvent.setup()
    const analysis = new FakeAnalysisProvider()
    analysis.analyzeCall.mockResolvedValue(resultFor())
    render(
      <AnalysisPanel
        mode="ai"
        analysis={analysis}
        portfolioRepository={repositoryWithHoldings()}
        instrument={BTC_EUR}
        quote={makeQuote({ instrumentId: 'BTC-EUR' })}
        candles={CANDLES}
      />,
    )

    expect(
      screen.getByRole('heading', { name: /análisis con ia/i }),
    ).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /analizar/i }))
    await waitFor(() =>
      expect(screen.getByText('Vigilar', { exact: true })).toBeInTheDocument(),
    )
    expect(screen.getByText(/fuente: gemini/i)).toBeInTheDocument()
  })

  it('labels a fallback result as local and surfaces a warning', async () => {
    const user = userEvent.setup()
    const analysis = new FakeAnalysisProvider()
    analysis.analyzeCall.mockRejectedValue(new Error('gemini rate limited'))
    const fallback = new FakeAnalysisProvider()
    fallback.analyzeCall.mockResolvedValue(resultFor())
    render(
      <AnalysisPanel
        mode="ai"
        analysis={analysis}
        fallback={fallback}
        portfolioRepository={repositoryWithHoldings()}
        instrument={BTC_EUR}
        quote={makeQuote({ instrumentId: 'BTC-EUR' })}
        candles={CANDLES}
      />,
    )

    await user.click(screen.getByRole('button', { name: /analizar/i }))

    await waitFor(() =>
      expect(screen.getByText(/fuente: mock/i)).toBeInTheDocument(),
    )
    expect(screen.getByRole('alert')).toHaveTextContent(
      /análisis preferido no está disponible/,
    )
    expect(fallback.analyzeCall).toHaveBeenCalledTimes(1)
  })

  it('stays titled Local analysis by default', () => {
    render(
      <AnalysisPanel
        analysis={new FakeAnalysisProvider()}
        portfolioRepository={repositoryWithHoldings()}
        instrument={BTC_EUR}
        quote={makeQuote({ instrumentId: 'BTC-EUR' })}
        candles={CANDLES}
      />,
    )
    expect(
      screen.getByRole('heading', { name: /análisis local/i }),
    ).toBeInTheDocument()
  })
})

describe('AnalysisPanel / orders separation (source)', () => {
  it('never imports or references the order execution domain', async () => {
    const rawModules = import.meta.glob('./AnalysisPanel.tsx', {
      query: '?raw',
      import: 'default',
    })
    const source = (await rawModules['./AnalysisPanel.tsx']()) as string
    expect(source).not.toMatch(
      /\borders\.ts\b|domain\/orders|OrderExecutionProvider/i,
    )
    expect(source).not.toMatch(/\bpreview\s*\(|\.submit\s*\(/i)
  })
})
