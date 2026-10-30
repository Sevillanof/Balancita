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

/** «Probar» → option → the exigencia modal: confirms it with what is set there. */
async function confirmExigencia(user: ReturnType<typeof userEvent.setup>) {
  const dialog = await screen.findByRole('dialog', {
    name: 'Exigencia de la prueba',
  })
  await user.click(within(dialog).getByRole('button', { name: /^Probar/ }))
}

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
  it('reports the net per operation the panel shows, for the list beside it', async () => {
    const onNet = vi.fn()
    render(
      <StrategyRunView
        strategyId="c30"
        strategyName="C30"
        version={1}
        gate={gateWith(overview([stageRun(7, 0)]))}
        visual={visualWith()}
        onNet={onNet}
      />,
    )
    await waitFor(() => expect(onNet).toHaveBeenCalledWith('c30', -4.2))
  })

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

  it('Qwen and Kronos can repeat every stage and take the exam again; rules strategies cannot', async () => {
    const user = userEvent.setup()
    const everyStage = MARKET_STAGES.map((stage, index) =>
      run(10 + index, { params: { from: stage.from, to: stage.to } }),
    )
    const gate = gateWith(overview(everyStage))
    vi.mocked(gate.start).mockResolvedValue({ run_id: 99 })
    const { unmount } = render(
      <StrategyRunView
        strategyId="qwen-live"
        strategyName="Qwen en vivo"
        version={1}
        kind="qwen_live"
        gate={gate}
        visual={visualWith()}
      />,
    )
    const testear = await screen.findByRole('button', { name: 'Testear' })
    await waitFor(() => expect(testear).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Examen' }))
    await waitFor(() =>
      expect(gate.start).toHaveBeenCalledWith('qwen-live', { exam: true }),
    )
    unmount()
    renderView(gateWith(overview(everyStage)), visualWith())
    expect(
      await screen.findByRole('button', { name: 'Testear' }),
    ).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Examen' })).toBeNull()
  })

  it('Kronos stages come from its own operation and the exam runs over its newest tramo', async () => {
    const user = userEvent.setup()
    const practice = [
      { label: '8 oct–10 oct', from: '2026-10-08', to: '2026-10-11' },
      { label: '11 oct–13 oct', from: '2026-10-11', to: '2026-10-14' },
    ]
    const exam = { label: '14 oct–25 oct', from: '2026-10-14', to: null }
    const gate = gateWith({ ...overview([]), stages: { practice, exam } })
    vi.mocked(gate.start).mockResolvedValue({ run_id: 99 })
    render(
      <StrategyRunView
        strategyId="kronos"
        strategyName="Kronos"
        version={1}
        kind="model"
        gate={gate}
        visual={visualWith()}
      />,
    )
    await user.click(await screen.findByRole('button', { name: 'Testear' }))
    const panel = screen.getByRole('group', { name: 'Pruebas seguidas' })
    await waitFor(() => expect(panel).toHaveTextContent('8 oct–10 oct'))
    await user.click(within(panel).getByRole('button', { name: 'Empezar' }))
    await waitFor(() =>
      expect(gate.start).toHaveBeenCalledWith('kronos', {
        from: '2026-10-08',
        to: '2026-10-11',
      }),
    )
    await user.click(await screen.findByRole('button', { name: 'Examen' }))
    await waitFor(() =>
      expect(gate.start).toHaveBeenCalledWith('kronos', {
        exam: true,
        from: '2026-10-14',
      }),
    )
  })

  it('Qwen en vivo has a quick test button; it asks, polls and shows an orientative result', async () => {
    const user = userEvent.setup()
    const stats = (
      n: number,
      net: number,
      winners: number,
      flips: number,
      timeouts: number,
    ) => ({
      n,
      neto_bp: net,
      ganadoras: winners,
      ic: [net - 20, net + 20] as [number, number],
      total_bp: net * n,
      por_semana: 2.5,
      por_vuelta: flips,
      por_tiempo: timeouts,
      horas: 11.6,
    })
    const states = [
      { state: 'none', snapshots: 300, note: 'n' },
      {
        state: 'running',
        snapshots: 300,
        note: 'n',
        phase: 'preguntando',
        answered: 30,
        total: 300,
        asking_ms: 1_000_000,
        updated_ms: Date.now(),
      },
      {
        state: 'done',
        snapshots: 300,
        note: 'n',
        summary: {
          photos: 300,
          horizon_min: 240,
          spearman: 0.1,
          spearman_ci: [0.01, 0.2],
          extremes_net_bp: 4.2,
          extremes_ci: [1, 7],
          vs_random_pct: 97,
          signals: { extremes: true, random: true, spearman: true },
          note: 'Es orientativa: no es el Examen.',
          operacion: {
            fotos: 300,
            max_horas: 48,
            salida: 'cuando el maestro se da vuelta o a las 48 h, sin stop',
            qwen: {
              ...stats(12, 31.5, 0.67, 10, 2),
              con_maestro: 0.75,
              con_portero: 0.5,
              vs_azar_pct: 96,
            },
            qwen_todas: stats(40, 4.1, 0.5, 30, 10),
            formula: stats(20, 45.2, 0.65, 16, 4),
            maestro_fuerte: stats(60, 12, 0.55, 50, 10),
            siempre_largo: stats(12, -3, 0.42, 11, 1),
            siempre_corto: stats(12, 2, 0.5, 11, 1),
            espejo_bloqueo: 19,
            espera: 200,
            signals: {
              gana: true,
              ic_positivo: false,
              azar: true,
              mejor_que_formula: false,
            },
          },
        },
      },
    ] as const
    let at = 0
    const quick = {
      status: vi.fn(async () => states[Math.min(at, states.length - 1)]!),
      start: vi.fn(async () => {
        at = 1
      }),
    } as unknown as import('../infrastructure/quick-api.ts').QuickApi
    render(
      <StrategyRunView
        strategyId="qwen-live"
        strategyName="Qwen en vivo"
        version={1}
        kind="qwen_live"
        gate={gateWith(overview([]))}
        visual={visualWith()}
        quick={quick}
      />,
    )
    await user.click(await screen.findByRole('button', { name: /Con Qwen/ }))
    await confirmExigencia(user)
    expect(quick.start).toHaveBeenCalledWith('qwen-live', 'actual', {
      maestro: 5,
      portero: 5,
      analista: 'apagado',
      medicion: 'honesta',
    })
    expect(
      await screen.findByRole('progressbar', {
        name: 'Progreso de la prueba rápida',
      }),
    ).toHaveAttribute('aria-valuenow', '10')
    await screen.findByText(/30 de 300 fotos/)
    at = 2
    await screen.findByText(/Prueba rápida \(orientativa\)/, undefined, {
      timeout: 8000,
    })
    expect(screen.getByText(/Es orientativa/)).toBeInTheDocument()
    // version 8: the operation as the live operator runs it, against the formulas alone
    const operation = screen.getByTestId('quick-operation')
    expect(operation).toHaveTextContent('Como opera la versión 8')
    expect(operation).toHaveTextContent(
      /Qwen entró en 12 de 300 fotos: \+31,5 pb por operación/,
    )
    expect(operation).toHaveTextContent('67 % ganadoras')
    expect(operation).toHaveTextContent(
      '10 porque el maestro se dio vuelta, 2 por tiempo',
    )
    const table = screen.getByRole('table', { name: 'Por operación' })
    expect(
      within(table).getByRole('row', {
        name: /La fórmula sola: maestro fuerte con portero a favor 20 2,5 \+45,2 pb 65 % 16 \/ 4/,
      }),
    ).toBeInTheDocument()
  }, 15000)

  it('the exigencia of the maestro and the portero starts at paper (5 and 5) and goes with the quick test', async () => {
    const user = userEvent.setup()
    const quick = {
      status: vi.fn(async () => ({ state: 'none', snapshots: 300, note: 'n' })),
      start: vi.fn(async () => undefined),
    } as unknown as import('../infrastructure/quick-api.ts').QuickApi
    render(
      <StrategyRunView
        strategyId="qwen-live"
        strategyName="Qwen en vivo"
        version={1}
        kind="qwen_live"
        gate={gateWith(overview([]))}
        visual={visualWith()}
        quick={quick}
      />,
    )
    await user.click(await screen.findByRole('button', { name: /Con Qwen/ }))
    const sliders = await screen.findAllByRole('slider')
    expect(sliders.map((s) => (s as HTMLInputElement).value)).toEqual([
      '5',
      '5',
    ])
    fireEvent.change(sliders[0]!, { target: { value: '8' } })
    fireEvent.change(sliders[1]!, { target: { value: '2' } })
    await confirmExigencia(user)
    expect(quick.start).toHaveBeenCalledWith('qwen-live', 'actual', {
      maestro: 8,
      portero: 2,
      analista: 'apagado',
      medicion: 'honesta',
    })
  })

  it('the movement analyst starts off (as in paper) and its mode goes with the quick test', async () => {
    const user = userEvent.setup()
    const quick = {
      status: vi.fn(async () => ({ state: 'none', snapshots: 300, note: 'n' })),
      start: vi.fn(async () => undefined),
    } as unknown as import('../infrastructure/quick-api.ts').QuickApi
    render(
      <StrategyRunView
        strategyId="qwen-live"
        strategyName="Qwen en vivo"
        version={1}
        kind="qwen_live"
        gate={gateWith(overview([]))}
        visual={visualWith()}
        quick={quick}
      />,
    )
    await user.click(await screen.findByRole('button', { name: /Con Qwen/ }))
    const group = await screen.findByRole('radiogroup', {
      name: 'Analista de movimiento',
    })
    const radios = within(group).getAllByRole('radio') as HTMLInputElement[]
    expect(radios.map((r) => [r.value, r.checked])).toEqual([
      ['apagado', true],
      ['suave', false],
      ['fuerte', false],
    ])
    await user.click(within(group).getByLabelText('1,25 / 0,75'))
    await confirmExigencia(user)
    expect(quick.start).toHaveBeenCalledWith('qwen-live', 'actual', {
      maestro: 5,
      portero: 5,
      analista: 'suave',
      medicion: 'honesta',
    })
  })

  it('Qwen en vivo never falls back to the old practice view while a test runs', async () => {
    const quick = {
      status: vi.fn(async () => ({
        state: 'running',
        snapshots: 300,
        note: 'n',
        phase: 'preguntando',
        answered: 5,
        total: 300,
        updated_ms: Date.now(),
      })),
      start: vi.fn(),
    } as unknown as import('../infrastructure/quick-api.ts').QuickApi
    render(
      <StrategyRunView
        strategyId="qwen-live"
        strategyName="Qwen en vivo"
        version={1}
        kind="qwen_live"
        gate={gateWith(overview([stageRun(7, 0)]))}
        visual={visualWith()}
        quick={quick}
      />,
    )
    expect(await screen.findByTestId('run-empty-panel')).toHaveTextContent(
      'Probando',
    )
    expect(screen.queryByTestId('run-evaluation-scope')).toBeNull()
    expect(screen.queryByRole('group', { name: 'Tramos probados' })).toBeNull()
    expect(screen.queryByText(/Velas de la prueba/)).toBeNull()
  })

  it('while the photos are prepared there is no empty progress bar', async () => {
    const quick = {
      status: vi.fn(async () => ({
        state: 'running',
        snapshots: 300,
        note: 'n',
        phase: 'fotos',
        updated_ms: Date.now(),
      })),
      start: vi.fn(),
    } as unknown as import('../infrastructure/quick-api.ts').QuickApi
    render(
      <StrategyRunView
        strategyId="qwen-live"
        strategyName="Qwen en vivo"
        version={1}
        kind="qwen_live"
        gate={gateWith(overview([]))}
        visual={visualWith()}
        quick={quick}
      />,
    )
    expect(
      await screen.findByText(/preparando las fotos del pasado/),
    ).toBeInTheDocument()
    expect(screen.queryByRole('progressbar')).toBeNull()
  })

  it('the quick test lets you pick a variant and compares the finished ones', async () => {
    const user = userEvent.setup()
    const summary = (net: number) => ({
      photos: 150,
      horizon_min: 240,
      spearman: 0.02,
      spearman_ci: [null, null],
      extremes_net_bp: net,
      extremes_ci: [null, null],
      vs_random_pct: 65,
      signals: { extremes: false, random: false, spearman: false },
      note: 'Es orientativa.',
    })
    const state = {
      state: 'none',
      snapshots: 150,
      note: 'n',
      variants: [
        {
          id: 'actual',
          label: 'Actual (control)',
          kind: 'control',
          state: 'done',
          summary: summary(-5.3),
        },
        {
          id: 'p1-direccion',
          label: 'Pregunta directa',
          kind: 'prompt',
          state: 'done',
          summary: summary(3.1),
        },
        {
          id: 'm1-qwen3-8b',
          label: 'Modelo: Qwen3 8B',
          kind: 'model',
          approx_gb: 5,
          state: 'none',
        },
      ],
    }
    const quick = {
      status: vi.fn(async () => state),
      start: vi.fn(async () => undefined),
    } as unknown as import('../infrastructure/quick-api.ts').QuickApi
    render(
      <StrategyRunView
        strategyId="qwen-live"
        strategyName="Qwen en vivo"
        version={1}
        kind="qwen_live"
        gate={gateWith(overview([]))}
        visual={visualWith()}
        quick={quick}
      />,
    )
    expect(
      await screen.findByRole('table', { name: 'Comparación de variantes' }),
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Con Qwen · .*Qwen3/ }))
    await confirmExigencia(user)
    expect(quick.start).toHaveBeenCalledWith('qwen-live', 'm1-qwen3-8b', {
      maestro: 5,
      portero: 5,
      analista: 'apagado',
      medicion: 'honesta',
    })
  })

  it('the sheet variants show the reading table and the comparison with the rule without Qwen', async () => {
    const user = userEvent.setup()
    const reading = (
      id: string,
      label: string,
      verdict: string,
      flip: number | null,
    ) => ({
      id,
      label,
      number: 'z de 24 h',
      vote_share: flip === null ? null : 0.97,
      vote_n: flip === null ? 0 : 145,
      flip_share: flip,
      flip_n: flip === null ? 0 : 120,
      habit: flip === null ? null : 0.6,
      corr: flip === null ? null : 0.62,
      corr_n: 140,
      verdict,
    })
    const state = {
      state: 'done',
      variant: 'ficha',
      snapshots: 300,
      note: 'n',
      variants: [
        {
          id: 'actual',
          label: 'Actual (control)',
          kind: 'control',
          state: 'none',
        },
        {
          id: 'ficha',
          label: 'Ficha de 8 factores con gradiente',
          kind: 'factors',
          state: 'done',
        },
        {
          id: 'ficha-pista',
          label: 'Ficha de 8 factores con pista de reversión',
          kind: 'factors',
          state: 'none',
        },
      ],
      summary: {
        photos: 300,
        horizon_min: 240,
        spearman: 0.05,
        spearman_ci: [-0.02, 0.12],
        extremes_net_bp: 1.5,
        extremes_ci: [-3, 6],
        vs_random_pct: 80,
        signals: { extremes: false, random: false, spearman: false },
        note: 'Es orientativa.',
        ficha: {
          photos: 298,
          reads: 1,
          readings: [
            reading('F1', 'Tendencia larga', 'lee', 0.91),
            reading('F2', 'Impulso corto', 'sesgado', 0.34),
            reading('F3', 'Lugar en el rango', 'no vota', 0.5),
            reading('F4', 'Área de valor del día previo', 'sin dato', null),
          ],
          comparison: [
            {
              horizon_min: 240,
              photos: 298,
              qwen_spearman: 0.04,
              rule_spearman: -0.02,
              always_long_net_bp: -10.5,
              always_short_net_bp: -9.5,
            },
            {
              horizon_min: 1440,
              photos: 298,
              qwen_spearman: null,
              rule_spearman: 0.1,
              always_long_net_bp: -30.2,
              always_short_net_bp: 10.2,
            },
          ],
        },
      },
    }
    const quick = {
      status: vi.fn(async () => state),
      start: vi.fn(async () => undefined),
    } as unknown as import('../infrastructure/quick-api.ts').QuickApi
    render(
      <StrategyRunView
        strategyId="qwen-live"
        strategyName="Qwen en vivo"
        version={1}
        kind="qwen_live"
        gate={gateWith(overview([]))}
        visual={visualWith()}
        quick={quick}
      />,
    )
    expect(
      await screen.findByRole('button', {
        name: /Ficha de 8 factores con gradiente/,
      }),
    ).toBeInTheDocument()
    await user.click(
      screen.getByRole('button', {
        name: /Ficha de 8 factores con pista de reversión/,
      }),
    )
    await confirmExigencia(user)
    expect(quick.start).toHaveBeenCalledWith('qwen-live', 'ficha-pista', {
      maestro: 5,
      portero: 5,
      analista: 'apagado',
      medicion: 'honesta',
    })
    const reads = await screen.findByRole('table', {
      name: 'Lectura por renglón',
    })
    expect(within(reads).getByText('F1 Tendencia larga')).toBeInTheDocument()
    expect(within(reads).getByText('lee')).toBeInTheDocument()
    expect(within(reads).getByText(/91 % \(120 fotos\)/)).toBeInTheDocument()
    expect(within(reads).getByText('sesgado')).toBeInTheDocument()
    expect(within(reads).getByText('no vota')).toBeInTheDocument()
    expect(within(reads).getAllByText(/97 % \(145 fotos\)/).length).toBe(3)
    expect(within(reads).getAllByText('+0,60').length).toBe(3)
    expect(
      within(reads).getByText('sin fotos fuera del área'),
    ).toBeInTheDocument()
    expect(within(reads).getAllByText('sin dato').length).toBeGreaterThan(0)
    const rule = screen.getByRole('table', { name: 'Contra la regla sin Qwen' })
    expect(within(rule).getByText('4 h')).toBeInTheDocument()
    expect(within(rule).getByText('24 h')).toBeInTheDocument()
    expect(within(rule).getByText('−10,5 pb')).toBeInTheDocument()
    expect(within(rule).getByText('+10,2 pb')).toBeInTheDocument()
  })

  it('rules strategies have no quick test button', async () => {
    renderView(gateWith(overview([])), visualWith())
    await screen.findByRole('button', { name: 'Testear' })
    expect(
      screen.queryByRole('button', { name: /Con Qwen|fórmula/ }),
    ).toBeNull()
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
    const fill = within(bar).getAllByTestId('run-progress-fill')[0]
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
      '5 velas · 4 marcas',
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

describe('StrategyRunView panel of the formula test (Qwen en vivo)', () => {
  const H = 3_600_000
  const stats = {
    n: 3,
    neto_bp: 10,
    ganadoras: 0.6,
    por_vuelta: 2,
    por_tiempo: 1,
  }
  const trade = (i: number, j: number, lado: 1 | -1, neto_bp: number) => ({
    producto: 'PF_ETHUSD',
    lado,
    entrada_ms: T0 + i * H,
    salida_ms: T0 + j * H,
    neto_bp,
    motivo: 'vuelta',
  })
  const formulaSummary = {
    photos: 100,
    horizon_min: 240,
    spearman: null,
    spearman_ci: [null, null],
    extremes_net_bp: null,
    extremes_ci: [null, null],
    vs_random_pct: null,
    signals: { extremes: null, random: null, spearman: null },
    note: 'n',
    formula: {
      fotos: 100,
      desde_ms: T0,
      hasta_ms: T0 + 100 * H,
      max_horas: 36,
      nocional_usd: 100,
      productos: ['PF_ETHUSD'],
      mercado: {
        PF_ETHUSD: Array.from({ length: 100 }, (_, i) => [
          T0 + i * H,
          2000 + i * 2 + (i % 7) * 5,
        ]),
      },
      formula: stats,
      maestro_fuerte: stats,
      siempre_largo: stats,
      siempre_corto: stats,
      curvas: {
        formula: [
          trade(5, 12, 1, 80),
          trade(20, 30, -1, -40),
          trade(40, 50, 1, 25),
        ],
        maestro_fuerte: [],
        siempre_largo: [],
        siempre_corto: [],
      },
    },
  }

  it('without saved candles for the run, draws the verdict and the ONE chart from the formula result, and zooms on a tap', async () => {
    const user = userEvent.setup()
    const quick = {
      status: vi.fn(async () => ({
        state: 'done',
        snapshots: 100,
        note: 'n',
        summary: formulaSummary,
        variants: [
          {
            id: 'formula',
            label: 'La fórmula sola',
            kind: 'formula',
            state: 'done',
            summary: formulaSummary,
          },
        ],
      })),
      start: vi.fn(),
    } as unknown as import('../infrastructure/quick-api.ts').QuickApi
    const visual = visualWith({
      summary: vi.fn(async () => {
        throw new RunVisualError('artifact_not_ready', 'sin operaciones')
      }),
    })
    render(
      <StrategyRunView
        strategyId="qwen-live"
        strategyName="Qwen en vivo"
        version={1}
        kind="qwen_live"
        gate={gateWith(overview([run(24)]))}
        visual={visual}
        quick={quick}
      />,
    )
    const verdict = await screen.findByTestId('run-verdict')
    expect(verdict).toHaveTextContent('+0,65 USD')
    expect(verdict).toHaveTextContent('Gana tras costos')
    expect(verdict).toHaveTextContent('3 operaciones')
    const figures = screen.getByTestId('run-kpis')
    expect(within(figures).getByText('3')).toBeInTheDocument()
    expect(within(figures).getByText('+21,7 pb')).toBeInTheDocument()
    expect(within(figures).queryByText('—')).toBeNull()
    expect(screen.queryByText(/Sin prueba terminada/)).toBeNull()
    expect(screen.queryByText(/Prueba anterior/)).toBeNull()
    expect(screen.queryByText(/tramos probados/)).toBeNull()
    // the bars of the detail agree with the figures above: same operations, same mean
    expect(
      within(screen.getByTestId('formula-ways')).getByText('+21,7 pb'),
    ).toBeInTheDocument()
    const chart = await screen.findByTestId('market-chart')
    const operations = within(screen.getByTestId('run-operations'))
    // the strip of operations lives in the closed details, not under the chart
    expect(
      within(chart).queryByRole('button', { name: /^Operación/ }),
    ).toBeNull()
    expect(
      operations.getAllByRole('button', { name: /^Operación/ }),
    ).toHaveLength(3)
    // the old curves chart and its bars are not on screen
    expect(screen.queryByText(/Siempre largo \(mismas entradas\)/)).toBeNull()
    await user.click(operations.getByRole('button', { name: /^Operación 2/ }))
    const compare = await screen.findByTestId('trade-compare')
    expect(compare).toHaveTextContent('Perdimos')
    expect(compare).toHaveTextContent('Se podía ganar')
  })

  it('prefers the formula result over an older or previous-version gate run and offers the ETH-enriched formula in the modal', async () => {
    const user = userEvent.setup()
    const quick = {
      status: vi.fn(async () => ({
        state: 'done',
        snapshots: 100,
        note: 'n',
        started_ms: T0 + 10_000,
        summary: formulaSummary,
        variants: [
          {
            id: 'formula',
            label: 'La fórmula sola',
            kind: 'formula',
            state: 'done',
            started_ms: T0 + 10_000,
            summary: formulaSummary,
          },
        ],
      })),
      start: vi.fn(async () => undefined),
    } as unknown as import('../infrastructure/quick-api.ts').QuickApi
    render(
      <StrategyRunView
        strategyId="qwen-live"
        strategyName="Qwen en vivo"
        version={1}
        kind="qwen_live"
        gate={gateWith(
          overview([run(24, { same_version: false, started_at: T0 })]),
        )}
        visual={visualWith()}
        quick={quick}
      />,
    )
    const verdict = await screen.findByTestId('run-verdict')
    expect(verdict).toHaveTextContent('3 operaciones')
    expect(screen.getByTestId('stage-where')).toHaveTextContent(
      'Hay una prueba rápida de la fórmula',
    )
    await user.click(
      screen.getByRole('button', {
        name: 'Sin Qwen: la fórmula o el rebote de ETH (rápida)',
      }),
    )
    const dialog = await screen.findByRole('dialog', {
      name: 'Exigencia de la prueba',
    })
    await user.click(
      within(dialog).getByRole('radio', {
        name: 'Maestro + portero + datos de ETH',
      }),
    )
    await user.click(within(dialog).getByRole('button', { name: 'Probar' }))
    expect(quick.start).toHaveBeenCalledWith(
      'qwen-live',
      'formula',
      expect.objectContaining({ entrada: 'formula_eth' }),
    )
  })
})

describe('StrategyRunView rebote de ETH en los paneles de siempre', () => {
  const H = 3_600_000
  const stats = {
    n: 2,
    neto_bp: 500,
    ganadoras: 0.5,
    por_vuelta: 0,
    por_tiempo: 2,
  }
  const velas = (from: number, to: number): Array<[number, number]> => {
    const out: Array<[number, number]> = []
    for (let t = from; t <= to; t += 300_000)
      out.push([t, 2000 + ((t - from) / H) * 3])
    return out
  }
  const trade = (at: number, net: number) => ({
    producto: 'PF_ETHUSD',
    lado: 1 as const,
    entrada_ms: T0 + at * H + 60_000,
    salida_ms: T0 + (at + 24) * H + 60_000,
    neto_bp: net,
    motivo: 'tiempo',
    caida: {
      desde_ms: T0 + (at - 1) * H,
      hasta_ms: T0 + at * H,
      desde_px: 2100,
      hasta_px: 1980,
      pct: -5.7,
      btc_pct: -2.1,
    },
    velas: velas(T0 + (at - 4) * H, T0 + (at + 27) * H),
  })
  const summary = {
    photos: 100,
    horizon_min: 1440,
    spearman: null,
    spearman_ci: [null, null],
    extremes_net_bp: null,
    extremes_ci: [null, null],
    vs_random_pct: null,
    signals: { extremes: null, random: null, spearman: null },
    note: 'n',
    formula: {
      entrada: 'rebote' as const,
      regla: 'caída de 5 % en 1 h → largo 24 h',
      fotos: 100,
      desde_ms: T0,
      hasta_ms: T0 + 100 * H,
      max_horas: 24,
      nocional_usd: 100,
      productos: ['PF_ETHUSD'],
      mercado: {
        PF_ETHUSD: Array.from({ length: 100 }, (_, i) => [
          T0 + i * H,
          2000 + (i % 9) * 4,
        ]),
      },
      formula: stats,
      maestro_fuerte: stats,
      siempre_largo: stats,
      siempre_corto: stats,
      curvas: {
        formula: [trade(10, 1000), trade(50, -500)],
        maestro_fuerte: [],
        siempre_largo: [],
        siempre_corto: [],
      },
    },
  }
  const view = (user = false) => {
    const quick = {
      status: vi.fn(async () => ({
        state: 'done',
        variant: 'rebote',
        snapshots: 100,
        note: 'n',
        summary,
        variants: [
          {
            id: 'formula',
            label: 'La fórmula sola',
            kind: 'formula',
            state: 'none',
          },
          {
            id: 'rebote',
            label: 'Rebote',
            kind: 'rebote',
            state: 'done',
            summary,
            started_ms: 5,
          },
        ],
      })),
      start: vi.fn(),
    } as unknown as import('../infrastructure/quick-api.ts').QuickApi
    render(
      <StrategyRunView
        strategyId="qwen-live"
        strategyName="Qwen en vivo"
        version={1}
        kind="qwen_live"
        gate={gateWith(overview([run(24)]))}
        visual={visualWith({
          summary: vi.fn(async () => {
            throw new RunVisualError('artifact_not_ready', 'sin operaciones')
          }),
        })}
        quick={quick}
      />,
    )
    return { quick, user: user ? userEvent.setup() : null }
  }

  const openExigencia = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(
      await screen.findByRole('button', {
        name: 'Sin Qwen: la fórmula o el rebote de ETH (rápida)',
      }),
    )
    return screen.findByRole('dialog', { name: 'Exigencia de la prueba' })
  }

  it('usa el veredicto, las 4 cifras y el gráfico de siempre, con cada caída marcada', async () => {
    view()
    const verdict = await screen.findByTestId('run-verdict')
    expect(verdict).toHaveTextContent('+5,00 USD')
    expect(verdict).toHaveTextContent('2 operaciones')
    expect(screen.getAllByTestId('drop-mark')).toHaveLength(2)
    expect(screen.getByTestId('drop-legend')).toBeInTheDocument()
    // the exigencia is not on the page: it opens in a modal from «Probar»
    expect(screen.queryByTestId('exigencia')).toBeNull()
    expect(screen.queryByTestId('rebote-view')).toBeNull()
  })

  it('el desplegable cerrado trae cada operación y cada caída con su rebote', async () => {
    const { user } = view(true)
    await screen.findByTestId('run-verdict')
    const details = screen.getByTestId('run-details') as HTMLDetailsElement
    expect(details.open).toBe(false)
    const falls = within(screen.getByTestId('fall-cards'))
    expect(
      falls.getAllByRole('button', { name: /^Caída −5,7 %/ }),
    ).toHaveLength(2)
    await user!.click(falls.getAllByRole('button', { name: /^Caída/ })[1]!)
    expect(screen.getByTestId('market-chart')).toHaveTextContent('Operación 2')
  })

  it('el modal de exigencia muestra la entrada de la prueba y «Toda la cuenta» suma con 1.000 USD', async () => {
    const { user } = view(true)
    await screen.findByTestId('run-verdict')
    const dialog = await openExigencia(user!)
    expect(
      within(dialog).getByRole('radio', { name: 'Rebote de ETH' }),
    ).toBeChecked()
    await user!.click(
      within(dialog).getByRole('radio', { name: 'Toda la cuenta' }),
    )
    await user!.click(within(dialog).getByRole('button', { name: 'Cancelar' }))
    // +10 % sobre 1.000 → 1.100; −5 % sobre 1.100 → −55
    expect(screen.getByTestId('run-verdict')).toHaveTextContent('+45,00 USD')
  })

  it('al tocar una operación hace zoom con los precios de 5 minutos y marca la caída y el BTC', async () => {
    const { user } = view(true)
    const chart = await screen.findByTestId('market-chart')
    await user!.click(
      within(screen.getByTestId('run-operations')).getAllByRole('button', {
        name: /^Operación 1/,
      })[0]!,
    )
    expect(chart).toHaveTextContent('caída −5,7 % en 1 h')
    expect(chart).toHaveTextContent('BTC −2,1 %')
    expect(chart).toHaveTextContent('entrada LARGO')
  })

  it('confirmar el modal lanza la prueba con la entrada elegida y sin mandar el tamaño de la cuenta', async () => {
    const { quick, user } = view(true)
    await screen.findByTestId('run-verdict')
    const dialog = await openExigencia(user!)
    await user!.click(
      within(dialog).getByRole('radio', { name: 'Toda la cuenta' }),
    )
    await user!.click(
      within(dialog).getByRole('button', { name: 'Probar el rebote de ETH' }),
    )
    expect(quick.start).toHaveBeenCalledWith(
      'qwen-live',
      'formula',
      expect.objectContaining({ entrada: 'rebote', cuenta: 'entera' }),
    )
  })
})

describe('StrategyRunView stage tabs', () => {
  const threeOfFive = () =>
    overview([stageRun(10, 0), stageRun(11, 1), stageRun(12, 3)])

  it('shows the 5 stages in order; the 3 tried are enabled and the 2 others are off, «sin probar»', async () => {
    renderView(gateWith(threeOfFive()), visualWith())
    await screen.findByTestId('chart')
    const tabs = within(
      screen.getByRole('group', { name: 'Tramos probados' }),
    ).getAllByRole('button')
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
    expect(
      screen.getByRole('button', { name: 'oct–dic 2025' }),
    ).toHaveAttribute('aria-pressed', 'true')
    await user.click(screen.getByRole('button', { name: 'abr–jun 2025' }))
    await waitFor(() => expect(visual.summary).toHaveBeenLastCalledWith(11))
    await screen.findByText(/Prueba mostrada · Práctica #11/)
    expect(
      screen.getByRole('button', { name: 'abr–jun 2025' }),
    ).toHaveAttribute('aria-pressed', 'true')
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
    await user.click(screen.getByRole('button', { name: /jul–sep 2025/ }))
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
      await user.click(screen.getByRole('button', { name: 'ene–mar 2025' }))
      await waitFor(() => expect(visual.summary).toHaveBeenLastCalledWith(10))
      await vi.advanceTimersByTimeAsync(31_000)
      await waitFor(() =>
        expect(
          screen.getByRole('button', { name: 'jul–sep 2025' }),
        ).not.toBeDisabled(),
      )
      expect(visual.summary).toHaveBeenLastCalledWith(10)
      expect(
        screen.getByRole('button', { name: 'ene–mar 2025' }),
      ).toHaveAttribute('aria-pressed', 'true')
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
      screen.getByRole('button', {
        name: 'Prueba #24 · 01/02/2025–20/02/2025',
      }),
    ).toHaveAttribute('aria-pressed', 'true')
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
    await user.click(screen.getByRole('button', { name: 'ene–mar 2025' }))
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
      decisions: vi.fn(
        async (id: number, _p: string, window?: { only?: string }) => ({
          run_id: id,
          product: 'PF_XBTUSD',
          captured: true as const,
          ignored_position_open: 2,
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
          ].filter(
            (signal) =>
              window?.only !== 'discards' ||
              signal.outcome.startsWith('rejected'),
          ),
          counts: {},
          total: 4,
          truncated: false,
        }),
      ),
    })

  it('draws only the real discards on the whole stretch, tells how many were ignored, and draws them all on a zoom', async () => {
    const user = userEvent.setup()
    const visual = traced()
    renderView(gateWith(overview([stageRun(24, 0)])), visual)
    const chart = await screen.findByTestId('chart')
    await waitFor(() =>
      expect(screen.getAllByTestId('discard')).toHaveLength(1),
    )
    expect(visual.decisions).toHaveBeenCalledWith(24, 'PF_XBTUSD', {
      from: T0,
      to: T0 + 100 * MIN,
      only: 'discards',
    })
    const details = within(screen.getByTestId('marker-details'))
    expect(
      details.getByText('Descarte LONG: el objetivo no cubría los costes'),
    ).toBeInTheDocument()
    expect(details.queryByText(/ya había una posición abierta/)).toBeNull()
    expect(screen.getByTestId('run-ignored')).toHaveTextContent(
      '2 señales ignoradas porque ya había una posición abierta',
    )
    // 2 trades (4 marks) + the 1 real discard
    expect(chart).toHaveTextContent('5 marcas')
    expect(screen.queryByTestId('run-no-decisions')).toBeNull()
    await user.click(screen.getAllByTestId('discard')[0]!)
    expect(screen.getByTestId('chart').dataset.selected).toMatch(/^d:/)

    // A zoom to one trade brings every discard of that window, as before.
    await user.click(screen.getByRole('button', { name: 'marca-1' }))
    await waitFor(() =>
      expect(visual.decisions).toHaveBeenLastCalledWith(24, 'PF_XBTUSD', {
        from: T0,
        to: T0 + 100 * MIN,
      }),
    )
    await waitFor(() =>
      expect(
        within(screen.getByTestId('marker-details')).getByText(
          'Descarte SHORT: ya había una posición abierta',
        ),
      ).toBeInTheDocument(),
    )
    expect(screen.queryByTestId('run-ignored')).toBeNull()
  })

  it('says so, without inventing anything, when the run saved no decisions', async () => {
    const visual = visualWith()
    renderView(gateWith(overview([stageRun(24, 0)])), visual)
    expect(await screen.findByTestId('run-no-decisions')).toHaveTextContent(
      'Esta prueba se guardó sin el detalle de decisiones; las entradas y salidas sí se ven.',
    )
    expect(visual.decisions).not.toHaveBeenCalled()
    expect(screen.queryAllByTestId('discard')).toHaveLength(0)
    expect(screen.getByTestId('chart')).toHaveTextContent('4 marcas')
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

describe('StrategyRunView whole stretch', () => {
  const DAY = 24 * 60 * MIN
  /** 3,5 months (1-ene to 18-abr-2026) with 1.400 invented trades, 500 per page. */
  const START = Date.UTC(2026, 0, 1)
  const END = Date.UTC(2026, 3, 18)
  const many = Array.from({ length: 1400 }, (_, i) => {
    const entry = START + Math.floor((i / 1400) * (END - START - DAY))
    return {
      ...trade(i, i % 2 === 0 ? 'LONG' : 'SHORT', i % 3 === 0 ? 5 : -5),
      trade_id: `24-${i}`,
      entry_time_ms: entry,
      entry_bucket_ms: entry,
      exit_time_ms: entry + 30 * MIN,
      exit_bucket_ms: entry + 29 * MIN,
    }
  })
  const pager = (list: RunTrade[]) =>
    vi.fn(
      async (
        id: number,
        _product: string,
        options?: { cursor?: string; limit?: number },
      ) => {
        const offset = Number(options?.cursor ?? 0)
        const size = options?.limit ?? 200
        return {
          run_id: id,
          product: 'PF_XBTUSD',
          total: list.length,
          trades: list.slice(offset, offset + size),
          next_cursor:
            offset + size < list.length ? String(offset + size) : null,
        }
      },
    )
  const wide = (list: RunTrade[] = many) =>
    visualWith({
      summary: vi.fn(async (id: number) => ({
        ...summaryOf(id),
        range_start_ms: START,
        range_end_ms: END,
      })),
      trades: pager(list),
      candles: vi.fn(async (id: number, _p: string, window) => ({
        ...candles(id),
        resolution: window?.resolution ?? '1m',
        from_ms: window?.from ?? START,
        to_ms: window?.to ?? END,
        missing_minutes: 0,
        candles: Array.from({ length: 60 }, (_, i) => ({
          time_ms: (window?.from ?? START) + i * 3_600_000,
          open: '100',
          high: '101',
          low: '99',
          close: '100.5',
          volume: '2',
        })),
      })),
    })
  const slowSecondPage = (visual: RunVisualApi) => {
    let release: () => void = () => undefined
    const opened = new Promise<void>((resolve) => (release = resolve))
    const real = vi.mocked(visual.trades).getMockImplementation()!
    vi.mocked(visual.trades).mockImplementation(async (...args) => {
      if (args[2]?.cursor === '500') await opened
      return real(...args)
    })
    return release
  }

  it('opens on the whole stretch of the test with candles of a resolution that fits it', async () => {
    const visual = wide()
    renderView(gateWith(overview([stageRun(24, 0)])), visual)
    await screen.findByTestId('chart')
    expect(visual.candles).toHaveBeenCalledWith(24, 'PF_XBTUSD', {
      from: START,
      to: END,
      resolution: '1h',
    })
    expect(screen.getByTestId('run-scope')).toHaveTextContent(
      'Velas de 1 hora · tramo completo (1-ene-2026 a 17-abr-2026)',
    )
    expect(
      screen.queryByRole('button', { name: 'Ver todo el tramo' }),
    ).toBeNull()
  })

  it('loads every trade page by page and groups the marks under the chart limit', async () => {
    const visual = wide()
    renderView(gateWith(overview([stageRun(24, 0)])), visual)
    await screen.findByTestId('chart')
    await waitFor(() =>
      expect(screen.queryByTestId('run-trades-loading')).toBeNull(),
    )
    const calls = vi.mocked(visual.trades).mock.calls
    expect(calls.map((call) => call[2]?.cursor)).toEqual([
      undefined,
      '500',
      '1000',
    ])
    const text = screen.getByTestId('chart').textContent ?? ''
    const marks = Number(/(\d+) marcas/.exec(text)?.[1])
    expect(marks).toBeGreaterThan(0)
    expect(marks).toBeLessThanOrEqual(110)
    const details = within(screen.getByTestId('marker-details'))
    expect(
      details.getAllByText(/^\+\d+ entradas LONG$/).length,
    ).toBeGreaterThan(0)
    expect(details.getAllByText(/^\+\d+ salidas: /).length).toBeGreaterThan(0)
  })

  it('shows the loading state while the later pages arrive', async () => {
    const visual = wide()
    const release = slowSecondPage(visual)
    renderView(gateWith(overview([stageRun(24, 0)])), visual)
    expect(await screen.findByTestId('run-trades-loading')).toHaveTextContent(
      '500 de 1400',
    )
    expect(screen.getByTestId('chart')).toBeInTheDocument()
    release()
    await waitFor(() =>
      expect(screen.queryByTestId('run-trades-loading')).toBeNull(),
    )
  })

  it('says so when a later page fails and keeps what was loaded', async () => {
    const visual = wide()
    const real = vi.mocked(visual.trades).getMockImplementation()!
    vi.mocked(visual.trades).mockImplementation(async (...args) => {
      if (args[2]?.cursor === '500') throw new Error('se cortó')
      return real(...args)
    })
    renderView(gateWith(overview([stageRun(24, 0)])), visual)
    expect(await screen.findByTestId('run-trades-error')).toHaveTextContent(
      'se ven 500 de 1400',
    )
    expect(screen.queryByTestId('run-trades-loading')).toBeNull()
  })

  it('a grouped mark opens the first operation of its group', async () => {
    const user = userEvent.setup()
    const visual = wide()
    renderView(gateWith(overview([stageRun(24, 0)])), visual)
    await screen.findByTestId('chart')
    await waitFor(() =>
      expect(screen.queryByTestId('run-trades-loading')).toBeNull(),
    )
    expect(screen.getByTestId('run-groups-hint')).toHaveTextContent('+N')
    await user.click(screen.getByRole('button', { name: 'marca-1' }))
    await waitFor(() =>
      expect(screen.getByTestId('run-scope')).toHaveTextContent(
        'Velas de 1 minuto · zoom a la operación',
      ),
    )
    expect(screen.getByTestId('chart').dataset.selected).toMatch(
      /^24-\d+:entry$/,
    )
    expect(screen.queryByTestId('run-groups-hint')).toBeNull()
  })

  it('zooms to one trade in 1-minute candles and «Ver todo el tramo» goes back without reading again', async () => {
    const user = userEvent.setup()
    const visual = wide(many.slice(0, 3))
    renderView(gateWith(overview([stageRun(24, 0)])), visual)
    await screen.findByTestId('chart')
    await user.click(screen.getByRole('button', { name: 'marca-1' }))
    await waitFor(() =>
      expect(screen.getByTestId('run-scope')).toHaveTextContent(
        'Velas de 1 minuto · zoom a la operación del 1-ene-2026',
      ),
    )
    expect(vi.mocked(visual.candles).mock.calls.at(-1)?.[2]).toEqual({
      from: many[0]!.entry_time_ms - 120 * MIN,
      to: many[0]!.exit_time_ms + 120 * MIN,
    })
    expect(screen.getByTestId('chart').dataset.selected).toBe('24-0:entry')
    await user.click(screen.getByRole('button', { name: 'Ver todo el tramo' }))
    expect(screen.getByTestId('run-scope')).toHaveTextContent('tramo completo')
    expect(screen.getByTestId('chart').dataset.selected).toBe('')
    expect(visual.candles).toHaveBeenCalledTimes(2)
    expect(
      screen.queryByRole('button', { name: 'Ver todo el tramo' }),
    ).toBeNull()
  })
})

describe('StrategyRunView test scope', () => {
  const baseline = {
    classification: 'baseline_only',
    account_scope: 'independent_fixed_notional',
    notional_per_trade_usd: '100',
    qwen_open_decisions_replayed: false,
    full_policy_validated: false,
    reasons: ['deterministic_book_only'],
  }
  const scopeOf = async (extra: Partial<GateRun>) => {
    renderView(gateWith(overview([run(24, extra)])), visualWith())
    return await screen.findByTestId('run-evaluation-scope')
  }

  it('a new run states its scope, definitive result, temporal evidence and audit', async () => {
    const block = await scopeOf({
      verdict: 'PASA',
      evaluation_policy: baseline,
      accounting: {
        state: 'complete',
        definitive_net_usd: 12.5,
        funding_complete_share: 1,
        minimum_complete_share: 0.95,
        funding_eligible: true,
      },
      temporal: { state: 'observed', excluded_trades: 0 },
      audit: { state: 'available' },
    })
    expect(block).toHaveTextContent(
      'Prueba base: libro fijo de 100 USD por operación; no repite las decisiones de Qwen',
    )
    expect(block).toHaveTextContent('no valida la política completa')
    expect(block).toHaveTextContent('Resultado definitivo: 12,5 USD')
    expect(block).toHaveTextContent(
      '100 % de las operaciones (mínimo 95 %): cumple',
    )
    expect(block).toHaveTextContent('Estabilidad por períodos medida')
    expect(block).toHaveTextContent('se pueden revisar')
    expect(block).not.toHaveTextContent('Prueba anterior')
  })

  it('an old run shows the neutral fallback and never claims validation', async () => {
    const block = await scopeOf({ verdict: 'PASA' })
    expect(block).toHaveTextContent('Prueba anterior: sin datos de alcance')
    expect(block).not.toHaveTextContent('definitivo')
    expect(block).not.toHaveTextContent('Auditoría')
    expect(block).not.toHaveTextContent('Estabilidad')
  })

  it('an unclassified server payload also falls back without crashing', async () => {
    const block = await scopeOf({
      evaluation_policy: {
        classification: 'unclassified',
        reasons: ['missing_evaluation_policy'],
      },
      accounting: { state: 'unclassified' },
      temporal: { state: 'unknown' },
    })
    expect(block).toHaveTextContent('Prueba anterior: sin datos de alcance')
  })

  it('partial funding is provisional and says the minimum is not met', async () => {
    const block = await scopeOf({
      evaluation_policy: baseline,
      accounting: {
        state: 'provisional',
        observed_net_usd: 8,
        definitive_net_usd: null,
        funding_complete_share: 0.8,
        minimum_complete_share: 0.95,
        funding_eligible: false,
      },
    })
    expect(block).toHaveTextContent('Resultado provisional (8 USD observado)')
    expect(block).toHaveTextContent('todavía no es el neto definitivo')
    expect(block).toHaveTextContent(
      '80 % de las operaciones (mínimo 95 %): no llega al mínimo',
    )
    expect(block).not.toHaveTextContent('Resultado definitivo')
  })

  it('unsupported temporal evidence is a limitation, not a measured failure', async () => {
    const block = await scopeOf({
      evaluation_policy: baseline,
      temporal: { state: 'unsupported', reasons: ['unsupported_embargo'] },
    })
    expect(block).toHaveTextContent('no evaluable')
    expect(block).toHaveTextContent('limitación, no un fallo medido')
  })
})
