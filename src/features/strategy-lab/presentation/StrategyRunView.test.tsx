import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import StrategyRunView from './StrategyRunView.tsx'
import type {
  GateApi,
  GateOverview,
  GateRun,
} from '../infrastructure/gate-api.ts'
import {
  RunVisualError,
  type RunTrade,
  type RunVisualApi,
  type RunVisualSummary,
} from '../infrastructure/run-visual-api.ts'

vi.mock('../../trading-view/presentation/ApprovedTerminalChart.tsx', () => ({
  default: ({
    candles,
    markers,
    selectedId,
    onSelect,
  }: {
    candles: unknown[]
    markers: { id: string }[]
    selectedId: string
    onSelect: (time: number, id?: string) => void
  }) => (
    <div data-testid="chart" data-selected={selectedId}>
      {candles.length} velas · {markers.length} marcas
      {markers[0] && (
        <button type="button" onClick={() => onSelect(0, markers[0]!.id)}>
          marca-1
        </button>
      )}
    </div>
  ),
}))

/* DATOS DE EJEMPLO: corridas y operaciones inventadas solo para estas pruebas. */
const MIN = 60_000
const T0 = Date.UTC(2026, 2, 1)
const run = (id: number, extra: Partial<GateRun> = {}): GateRun => ({
  id,
  strategy_id: 'x2',
  kind: 'practice',
  status: 'done',
  verdict: 'NO PASA',
  progress: 100,
  phase: 'terminada',
  detail: null,
  eta_s: null,
  started_at: T0,
  finished_at: T0,
  attempts: 1,
  error: null,
  has_report: true,
  same_version: true,
  ...extra,
})
const overview = (
  runs: GateRun[],
  exam: GateOverview['exam'] = { taken: false },
): GateOverview => ({
  runs,
  exam,
  running: null,
})
const gateWith = (data: GateOverview): GateApi => ({
  overview: vi.fn(async () => data),
  start: vi.fn(),
  cancel: vi.fn(),
  report: vi.fn(),
})

const trade = (n: number, side: 'LONG' | 'SHORT', net: number): RunTrade => ({
  trade_id: `24-${n}`,
  product_id: 'PF_XBTUSD',
  side,
  entry_time_ms: T0 + n * 60 * MIN,
  entry_bucket_ms: T0 + n * 60 * MIN,
  entry_price: '100.5',
  exit_time_ms: T0 + n * 60 * MIN + 30 * MIN,
  exit_bucket_ms: T0 + n * 60 * MIN + 29 * MIN,
  exit_price: '101',
  exit_reason: 'time_stop',
  reason_code: null,
  net_bp: net,
  pnl_usd: net / 100,
  funding_usd: null,
  funding_status: 'unknown',
  notional_usd: '100',
  signal_time_ms: null,
})
const summaryOf = (runId: number): RunVisualSummary => ({
  run_id: runId,
  strategy_id: 'x2',
  kind: 'practice',
  spec_hash: 'abcdef1234567890',
  products: ['PF_XBTUSD'],
  trades_by_product: { PF_XBTUSD: 2 },
  range_start_ms: T0,
  range_end_ms: T0 + 1000 * MIN,
  source: 'kraken_futures_official_candles',
  resolution: '1m',
  decision_evidence: 'not_captured',
  contaminated: false,
  cost_model_version: 'v1',
  label: 'Histórico Kraken · ejecuciones paper simuladas',
  summary: {
    verdict: 'NO PASA',
    verdict_note: null,
    inconclusive_reasons: [],
    trades: 143,
    min_trades: 100,
    mean_bp: -4.2,
    ci: [null, null],
    positive_folds: 2,
    folds: 5,
    min_positive_fold_share: 0.6,
    percentile: 87,
    min_percentile: 95,
    funding_share: 0,
    funding_status: { unknown: 2 },
    open_at_end: 0,
    contaminated: false,
  },
})
const candles = (runId: number) => ({
  run_id: runId,
  product: 'PF_XBTUSD',
  resolution: '1m',
  from_ms: T0,
  to_ms: T0 + 100 * MIN,
  range_start_ms: T0,
  range_end_ms: T0 + 1000 * MIN,
  missing_minutes: 3,
  candles: Array.from({ length: 5 }, (_, i) => ({
    time_ms: T0 + i * MIN,
    open: '100',
    high: '101',
    low: '99',
    close: '100.5',
    volume: '2',
  })),
})
function visualWith(overrides: Partial<RunVisualApi> = {}): RunVisualApi {
  return {
    summary: vi.fn(async (id: number) => summaryOf(id)),
    candles: vi.fn(async (id: number) => candles(id)),
    trades: vi.fn(async (id: number) => ({
      run_id: id,
      product: 'PF_XBTUSD',
      total: 2,
      trades: [trade(1, 'LONG', 12), trade(2, 'SHORT', -4.2)],
      next_cursor: null,
    })),
    ...overrides,
  }
}
const renderView = (
  gate: GateApi,
  visual: RunVisualApi,
  extra: { onModify?: () => void; onCreate?: () => void } = {},
) =>
  render(
    <StrategyRunView
      strategyId="x2"
      strategyName="X2 Breakout"
      version={3}
      gate={gate}
      visual={visual}
      {...extra}
    />,
  )

describe('StrategyRunView actions', () => {
  it('Modificar and Crear call their handlers; they are disabled without one', async () => {
    const user = userEvent.setup()
    const onModify = vi.fn()
    const onCreate = vi.fn()
    renderView(gateWith(overview([])), visualWith(), { onModify, onCreate })
    await user.click(screen.getByRole('button', { name: 'Modificar' }))
    await user.click(screen.getByRole('button', { name: 'Crear' }))
    expect(onModify).toHaveBeenCalledTimes(1)
    expect(onCreate).toHaveBeenCalledTimes(1)
  })

  it('Modificar is disabled when the strategy cannot be edited', async () => {
    renderView(gateWith(overview([])), visualWith())
    expect(screen.getByRole('button', { name: 'Modificar' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Crear' })).toBeDisabled()
  })

  it('Testear asks how many tests in a row and runs them in distinct stretches', async () => {
    const user = userEvent.setup()
    const tried = run(5, {
      params: { from: '2025-01-01T00:00:00Z', to: '2025-04-01T00:00:00Z' },
    })
    const gate = gateWith(overview([tried]))
    let release: () => void = () => undefined
    const held = new Promise<{ run_id: number }>((resolve) => {
      release = () => resolve({ run_id: 6 })
    })
    vi.mocked(gate.start)
      .mockReturnValueOnce(held)
      .mockResolvedValueOnce({ run_id: 7 })
    // Each started test is finished by the time the screen looks again.
    vi.mocked(gate.overview).mockImplementation(async () =>
      overview([
        tried,
        ...vi.mocked(gate.start).mock.results.map((_, index) =>
          run(6 + index, {
            params:
              index === 0
                ? { from: '2025-04-01', to: '2025-07-01' }
                : { from: '2025-07-01', to: '2025-10-01' },
          }),
        ),
      ]),
    )
    renderView(gate, visualWith())
    await user.click(await screen.findByRole('button', { name: 'Testear' }))
    const panel = screen.getByRole('group', { name: 'Pruebas seguidas' })
    const input = within(panel).getByLabelText('¿Cuántas pruebas seguidas?')
    fireEvent.change(input, { target: { value: '2' } })
    await waitFor(() =>
      expect(panel).toHaveTextContent('abr–jun 2025 → jul–sep 2025'),
    )
    await user.click(within(panel).getByRole('button', { name: 'Empezar' }))
    const bar = await screen.findByRole('progressbar')
    expect(bar.querySelectorAll('li')).toHaveLength(2)
    expect(bar).toHaveAttribute('aria-valuemax', '2')
    release()
    await waitFor(() => expect(gate.start).toHaveBeenCalledTimes(2))
    expect(gate.start).toHaveBeenNthCalledWith(1, 'x2', {
      from: '2025-04-01',
      to: '2025-07-01',
    })
    expect(gate.start).toHaveBeenNthCalledWith(2, 'x2', {
      from: '2025-07-01',
      to: '2025-10-01',
    })
  })

  it('a refresh while a test runs does not reload the chart', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const visual = visualWith()
      const gate = gateWith({
        ...overview([run(24)]),
        running: { id: 25, strategy_id: 'x2' },
      } as GateOverview)
      renderView(gate, visual)
      await screen.findByTestId('chart')
      expect(visual.summary).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(31_000)
      expect(vi.mocked(gate.overview).mock.calls.length).toBeGreaterThan(1)
      expect(visual.summary).toHaveBeenCalledTimes(1)
      expect(screen.getByTestId('chart')).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('Testear is disabled while a test runs', async () => {
    const gate = gateWith({
      ...overview([]),
      running: { id: 9, strategy_id: 'x2' },
    } as GateOverview)
    renderView(gate, visualWith())
    expect(
      await screen.findByRole('button', { name: 'Prueba en curso…' }),
    ).toBeDisabled()
  })
})

describe('StrategyRunView', () => {
  it('shows the four figures of the latest finished run, its stage and the real candles', async () => {
    const visual = visualWith()
    renderView(gateWith(overview([run(24), run(23)])), visual)
    const kpis = await screen.findByTestId('run-kpis')
    await waitFor(() =>
      expect(within(kpis).getByText('143')).toBeInTheDocument(),
    )
    expect(within(kpis).getByText('✓ Mínimo: 100')).toBeInTheDocument()
    expect(within(kpis).getByText('−4,2 pb')).toBeInTheDocument()
    expect(within(kpis).getByText('2 / 5')).toBeInTheDocument()
    expect(within(kpis).getByText('Mínimo: 3 de 5')).toBeInTheDocument()
    expect(within(kpis).getByText('87 %')).toBeInTheDocument()
    expect(screen.getByText(/Última prueba · Práctica #24/)).toBeInTheDocument()
    expect(screen.getByText('En optimización')).toBeInTheDocument()
    expect(screen.getByText('Optimizar').closest('li')).toHaveAttribute(
      'aria-current',
      'step',
    )
    expect(await screen.findByTestId('chart')).toHaveTextContent(
      '5 velas · 2 marcas',
    )
    expect(visual.summary).toHaveBeenCalledWith(24)
    // Only the screen of the reference: no trade table and no extra panels.
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.queryByText(/Ver detalles/)).toBeNull()
    expect(screen.getByTestId('run-gaps')).toHaveTextContent('Faltan 3 velas')
    expect(
      screen.getByText(/Histórico Kraken · ejecuciones paper simuladas/),
    ).toBeInTheDocument()
  })

  it('skips runs that saved no trades and says so when none did', async () => {
    const old = new RunVisualError(
      'artifact_not_ready',
      'Esa corrida no guardó sus operaciones.',
    )
    const visual = visualWith({
      summary: vi.fn(async (id: number) => {
        if (id === 24) throw old
        return summaryOf(id)
      }),
    })
    const { unmount } = renderView(
      gateWith(overview([run(24), run(23)])),
      visual,
    )
    await screen.findByTestId('chart')
    expect(visual.summary).toHaveBeenCalledTimes(2)
    expect(screen.getByText(/Última prueba · Práctica #23/)).toBeInTheDocument()
    unmount()
    renderView(
      gateWith(overview([run(24)])),
      visualWith({
        summary: vi.fn(async () => {
          throw old
        }),
      }),
    )
    expect(await screen.findByTestId('run-empty')).toHaveTextContent(
      'no guardaron sus operaciones',
    )
    expect(screen.queryByTestId('chart')).not.toBeInTheDocument()
    expect(screen.getAllByText('—', { selector: 'strong' })).toHaveLength(4)
  })

  it('says so plainly when the gate does not know the strategy', async () => {
    const gate = gateWith(overview([]))
    vi.mocked(gate.overview).mockRejectedValue(
      new Error('No existe la estrategia indicada.'),
    )
    renderView(gate, visualWith())
    expect(await screen.findByTestId('run-empty')).toHaveTextContent(
      'Esta estrategia no tiene pruebas guardadas.',
    )
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByText(/Cargando/)).toBeNull()
  })

  it('says there are no tests when the strategy has none', async () => {
    renderView(gateWith(overview([])), visualWith())
    expect(await screen.findByTestId('run-empty')).toHaveTextContent(
      'Todavía no hay pruebas',
    )
    expect(screen.getByText('En hipótesis')).toBeInTheDocument()
  })

  it('shows candles and an honest note when the run opened no position', async () => {
    const visual = visualWith({
      trades: vi.fn(async (id: number) => ({
        run_id: id,
        product: 'PF_XBTUSD',
        total: 0,
        trades: [],
        next_cursor: null,
      })),
    })
    renderView(gateWith(overview([run(24)])), visual)
    expect(await screen.findByTestId('run-no-trades')).toHaveTextContent(
      'no abrió posiciones',
    )
    expect(screen.getByTestId('chart')).toHaveTextContent('5 velas · 0 marcas')
  })

  it('shows "Sin datos" instead of drawing when the candles are missing', async () => {
    const visual = visualWith({
      candles: vi.fn(async () => {
        throw new RunVisualError(
          'data_missing',
          'No hay velas guardadas de PF_XBTUSD para esa prueba.',
        )
      }),
    })
    renderView(gateWith(overview([run(24)])), visual)
    expect(await screen.findByTestId('run-no-candles')).toHaveTextContent(
      'Sin datos de velas',
    )
    expect(screen.queryByTestId('chart')).not.toBeInTheDocument()
  })

  it('a marker click loads the candles around that trade', async () => {
    const user = userEvent.setup()
    const visual = visualWith()
    renderView(gateWith(overview([run(24)])), visual)
    await screen.findByTestId('chart')
    await user.click(screen.getByRole('button', { name: 'marca-1' }))
    await waitFor(() =>
      expect(vi.mocked(visual.candles).mock.calls.at(-1)?.[2]).toEqual({
        from: T0 + 60 * MIN - 120 * MIN,
        to: T0 + 60 * MIN + 30 * MIN + 120 * MIN,
      }),
    )
  })

  it('derives the stage from the gate records: a failed exam stays at "Examen", only a passed one reaches Paper', async () => {
    const taken = (verdict: string): GateOverview['exam'] => ({
      taken: true,
      same_version: true,
      status: 'done',
      verdict,
      date: '2026-10-01',
      run_id: 30,
    })
    const { unmount } = renderView(
      gateWith(overview([run(30, { kind: 'exam' })], taken('NO PASA'))),
      visualWith(),
    )
    expect(await screen.findByText('En examen')).toBeInTheDocument()
    unmount()
    renderView(
      gateWith(
        overview([run(30, { kind: 'exam', verdict: 'PASA' })], taken('PASA')),
      ),
      visualWith(),
    )
    expect(await screen.findByText('Pasó el examen')).toBeInTheDocument()
  })
})
