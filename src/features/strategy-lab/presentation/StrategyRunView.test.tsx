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
import { MARKET_STAGES } from '../domain/market-stages.ts'
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
    markers: { id: string; detail?: string; label: string }[]
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
      {markers
        .filter((marker) => marker.id.startsWith('d:'))
        .map((marker) => (
          <button
            key={marker.id}
            type="button"
            data-testid="discard"
            title={marker.detail}
            onClick={() => onSelect(0, marker.id)}
          >
            {marker.label}
          </button>
        ))}
      <ul data-testid="marker-details">
        {markers.map((marker) => (
          <li key={marker.id}>{marker.detail}</li>
        ))}
      </ul>
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
    decisions: vi.fn(async (id: number) => ({
      run_id: id,
      product: 'PF_XBTUSD',
      captured: false as const,
      reason: 'Esta prueba se guardó sin el detalle de decisiones.',
    })),
    ...overrides,
  }
}
/** Stage run: «ene–mar 2025», «abr–jun 2025»… by its index in MARKET_STAGES. */
const stageRun = (id: number, stage: number) =>
  run(id, {
    params: {
      from: MARKET_STAGES[stage]!.from,
      to: MARKET_STAGES[stage]!.to,
    },
  })
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
    expect(bar).toHaveAttribute('aria-valuenow', '0')
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

  it('the progress bar follows the running test', async () => {
    const gate = gateWith({
      ...overview([
        run(24),
        run(25, { status: 'running', progress: 40, phase: 'simulando' }),
      ]),
      running: { id: 25, strategy_id: 'x2' },
    } as GateOverview)
    renderView(gate, visualWith())
    const bar = await screen.findByRole('progressbar')
    expect(bar).toHaveAttribute('aria-valuenow', '40')
    const fill = bar.querySelector<HTMLElement>('.runview__progress-fill')
    expect(fill?.style.width).toBe('40%')
    expect(bar).toHaveTextContent('simulando')
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
    expect(
      screen.getByText(/Prueba mostrada · Práctica #24/),
    ).toBeInTheDocument()
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
    expect(
      screen.getByText(/Prueba mostrada · Práctica #23/),
    ).toBeInTheDocument()
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

describe('StrategyRunView stage tabs', () => {
  const threeOfFive = () =>
    overview([stageRun(10, 0), stageRun(11, 1), stageRun(12, 3)])

  it('shows the 5 stages in order; the 3 tried are enabled and the 2 others are off, «sin probar»', async () => {
    renderView(gateWith(threeOfFive()), visualWith())
    await screen.findByTestId('chart')
    const tabs = within(
      screen.getByRole('tablist', { name: 'Tramos probados' }),
    ).getAllByRole('tab')
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      'ene–mar 2025',
      'abr–jun 2025',
      'jul–sep 2025 · sin probar',
      'oct–dic 2025',
      'ene–abr 2026 · sin probar',
    ])
    expect(tabs.map((tab) => (tab as HTMLButtonElement).disabled)).toEqual([
      false,
      false,
      true,
      false,
      true,
    ])
    expect(screen.getByTestId('stage-count')).toHaveTextContent(
      '3 de 5 tramos probados',
    )
  })

  it('opens the newest tried stage by default and loads the run of a tab when it is chosen', async () => {
    const user = userEvent.setup()
    const visual = visualWith()
    renderView(gateWith(threeOfFive()), visual)
    await screen.findByTestId('chart')
    expect(visual.summary).toHaveBeenCalledTimes(1)
    expect(visual.summary).toHaveBeenCalledWith(12)
    expect(screen.getByRole('tab', { name: 'oct–dic 2025' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    await user.click(screen.getByRole('tab', { name: 'abr–jun 2025' }))
    await waitFor(() => expect(visual.summary).toHaveBeenLastCalledWith(11))
    await screen.findByText(/Prueba mostrada · Práctica #11/)
    expect(screen.getByRole('tab', { name: 'abr–jun 2025' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    expect(vi.mocked(visual.trades)).toHaveBeenLastCalledWith(
      11,
      'PF_XBTUSD',
      expect.anything(),
    )
    expect(vi.mocked(visual.candles).mock.calls.at(-1)?.[0]).toBe(11)
  })

  it('does not choose an off tab', async () => {
    const user = userEvent.setup()
    const visual = visualWith()
    renderView(gateWith(threeOfFive()), visual)
    await screen.findByTestId('chart')
    await user.click(screen.getByRole('tab', { name: /jul–sep 2025/ }))
    expect(visual.summary).toHaveBeenCalledTimes(1)
  })

  it('a run from another content version or an exam does not make a tab', async () => {
    renderView(
      gateWith(
        overview([
          stageRun(10, 0),
          { ...stageRun(11, 1), same_version: false },
          { ...stageRun(12, 2), kind: 'exam' },
        ]),
      ),
      visualWith(),
    )
    await screen.findByTestId('chart')
    expect(screen.getByTestId('stage-count')).toHaveTextContent(
      '1 de 5 tramos probados',
    )
  })

  it('keeps the stage picked by hand when a newer one finishes, and follows the newest otherwise', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
      const before = [stageRun(10, 0), stageRun(11, 1)]
      const after = [...before, stageRun(12, 2)]
      let calls = 0
      const gate = gateWith(overview(before))
      vi.mocked(gate.overview).mockImplementation(async () => {
        calls += 1
        return {
          ...overview(calls < 4 ? before : after),
          running: { id: 13, strategy_id: 'x2' },
        } as GateOverview
      })
      const visual = visualWith()
      renderView(gate, visual)
      await screen.findByTestId('chart')
      await user.click(screen.getByRole('tab', { name: 'ene–mar 2025' }))
      await waitFor(() => expect(visual.summary).toHaveBeenLastCalledWith(10))
      await vi.advanceTimersByTimeAsync(31_000)
      await waitFor(() =>
        expect(
          screen.getByRole('tab', { name: 'jul–sep 2025' }),
        ).not.toBeDisabled(),
      )
      expect(visual.summary).toHaveBeenLastCalledWith(10)
      expect(screen.getByRole('tab', { name: 'ene–mar 2025' })).toHaveAttribute(
        'aria-selected',
        'true',
      )
      expect(screen.getByTestId('stage-count')).toHaveTextContent(
        '3 de 5 tramos probados',
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('follows the newest finished stage while nothing was picked', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const before = [stageRun(10, 0)]
      const after = [...before, stageRun(11, 1)]
      let calls = 0
      const gate = gateWith(overview(before))
      vi.mocked(gate.overview).mockImplementation(async () => {
        calls += 1
        return {
          ...overview(calls < 3 ? before : after),
          running: { id: 12, strategy_id: 'x2' },
        } as GateOverview
      })
      const visual = visualWith()
      renderView(gate, visual)
      await screen.findByTestId('chart')
      await vi.advanceTimersByTimeAsync(31_000)
      await waitFor(() => expect(visual.summary).toHaveBeenLastCalledWith(11))
    } finally {
      vi.useRealTimers()
    }
  })

  it('with no stage tried it shows the finished run as one tab with its range', async () => {
    renderView(
      gateWith(
        overview([
          run(24, { params: { from: '2025-02-01', to: '2025-02-20' } }),
        ]),
      ),
      visualWith(),
    )
    await screen.findByTestId('chart')
    expect(
      screen.getByRole('tab', { name: 'Prueba #24 · 01/02/2025–20/02/2025' }),
    ).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('stage-count')).toHaveTextContent(
      '0 de 5 tramos probados',
    )
  })

  it('says a picked stage saved no trades instead of showing another one', async () => {
    const user = userEvent.setup()
    const visual = visualWith({
      summary: vi.fn(async (id: number) => {
        if (id === 10)
          throw new RunVisualError('artifact_not_ready', 'sin operaciones')
        return summaryOf(id)
      }),
    })
    renderView(gateWith(threeOfFive()), visual)
    await screen.findByTestId('chart')
    await user.click(screen.getByRole('tab', { name: 'ene–mar 2025' }))
    expect(await screen.findByTestId('run-empty')).toHaveTextContent(
      'Esa prueba no guardó sus operaciones',
    )
  })
})

describe('StrategyRunView decisions', () => {
  const traced = (extra: Partial<RunVisualSummary> = {}) =>
    visualWith({
      summary: vi.fn(async (id: number) => ({
        ...summaryOf(id),
        decision_evidence: 'captured',
        ...extra,
      })),
      decisions: vi.fn(async (id: number) => ({
        run_id: id,
        product: 'PF_XBTUSD',
        captured: true as const,
        signals: [
          {
            bucket_ms: T0 + 1 * MIN,
            side: 'LONG' as const,
            outcome: 'accepted',
            reason_code: 'x',
          },
          {
            bucket_ms: T0 + 2 * MIN,
            side: 'SHORT' as const,
            outcome: 'position_open',
            reason_code: 'x',
          },
          {
            bucket_ms: T0 + 3 * MIN,
            side: 'LONG' as const,
            outcome: 'rejected_target_does_not_clear_cost',
            reason_code: 'x',
          },
          {
            bucket_ms: T0 + 500 * MIN,
            side: 'LONG' as const,
            outcome: 'position_open',
            reason_code: 'x',
          },
        ],
        counts: {},
        total: 4,
        truncated: false,
      })),
    })

  it('draws the discards of the visible window with their reason, and asks for that window only', async () => {
    const user = userEvent.setup()
    const visual = traced()
    renderView(gateWith(overview([stageRun(24, 0)])), visual)
    const chart = await screen.findByTestId('chart')
    await waitFor(() =>
      expect(screen.getAllByTestId('discard')).toHaveLength(2),
    )
    expect(visual.decisions).toHaveBeenCalledWith(24, 'PF_XBTUSD', {
      from: T0,
      to: T0 + 100 * MIN,
    })
    const details = within(screen.getByTestId('marker-details'))
    expect(
      details.getByText('Descarte SHORT: ya había una posición abierta'),
    ).toBeInTheDocument()
    expect(
      details.getByText('Descarte LONG: el objetivo no cubría los costes'),
    ).toBeInTheDocument()
    // the entry taken is not a discard; entries and exits of the trades are still there
    expect(chart).toHaveTextContent('4 marcas')
    expect(screen.queryByTestId('run-no-decisions')).toBeNull()
    await user.click(screen.getAllByTestId('discard')[0]!)
    expect(screen.getByTestId('chart').dataset.selected).toMatch(/^d:/)
  })

  it('says so, without inventing anything, when the run saved no decisions', async () => {
    const visual = visualWith()
    renderView(gateWith(overview([stageRun(24, 0)])), visual)
    expect(await screen.findByTestId('run-no-decisions')).toHaveTextContent(
      'Esta prueba se guardó sin el detalle de decisiones; las entradas y salidas sí se ven.',
    )
    expect(visual.decisions).not.toHaveBeenCalled()
    expect(screen.queryAllByTestId('discard')).toHaveLength(0)
    expect(screen.getByTestId('chart')).toHaveTextContent('2 marcas')
  })

  it('says so when the server answers captured: false', async () => {
    const visual = traced()
    vi.mocked(visual.decisions).mockResolvedValue({
      run_id: 24,
      product: 'PF_XBTUSD',
      captured: false,
      reason: 'x',
    })
    renderView(gateWith(overview([stageRun(24, 0)])), visual)
    expect(await screen.findByTestId('run-no-decisions')).toBeInTheDocument()
    expect(screen.queryAllByTestId('discard')).toHaveLength(0)
  })

  it('shows the legend with the discard sign', async () => {
    renderView(gateWith(overview([stageRun(24, 0)])), visualWith())
    await screen.findByTestId('chart')
    const legend = screen.getByRole('list', { name: 'Leyenda' })
    expect(legend).toHaveTextContent('Salida (motivo en el detalle)')
    expect(legend).toHaveTextContent('◦ Descarte')
  })

  it('reports a failed read of the decisions in plain words', async () => {
    const visual = traced()
    vi.mocked(visual.decisions).mockRejectedValue(new Error('se cayó'))
    renderView(gateWith(overview([stageRun(24, 0)])), visual)
    expect(await screen.findByTestId('run-decisions-error')).toHaveTextContent(
      'No se pudo leer el detalle de decisiones: se cayó',
    )
  })
})
