import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import StrategyDetailView from './StrategyDetailView.tsx'
import { exampleStrategyApi } from '../testing/example-strategy-api.ts'
import StrategyLab from './StrategyLab.tsx'
import { exampleInventory } from '../testing/inventory-fixture.ts'
import { syntheticCandles } from '../testing/synthetic-candles.ts'
import type {
  StrategyApi,
  StrategyDetail,
  StrategyPlan,
} from '../infrastructure/strategy-api.ts'
import type {
  ActivityReport,
  ExperimentActivity,
} from '../../observability/infrastructure/observability-api.ts'
import type { StrategySpec } from '../domain/strategy-spec.ts'
import { verdictStatement } from '../domain/strategy-detail.ts'

vi.mock('../../trading-view/presentation/ApprovedTerminalChart.tsx', () => ({
  default: () => <div data-testid="lab-chart" />,
}))

/* DATOS DE EJEMPLO: a made-up spec, plan and activity for unit tests only. */
const spec: StrategySpec = {
  schema: 'balancita-strategy.v1',
  id: 'x2',
  version: 1,
  name: 'X2 Sin ventaja',
  description: 'Tesis de ejemplo para la prueba.',
  params: { z_min: '2.5', stop_atr: '2', target_stop_ratio: '1.5' },
  indicators: { logret: [72], logvol: [288] },
  rules: {
    checks: [
      {
        name: 'long',
        node: {
          cmp: 'up',
          left: '5m.logret72',
          op: '>',
          right: { mul: ['5m.logvol288', '$z_min'] },
        },
      },
    ],
    sides: {
      LONG: { requires: ['long'], reason: 'x2_long', invalidation: 'stop' },
    },
    exit: {
      LONG: { cmp: 'none', left: '0', op: '>', right: '1' },
      SHORT: { cmp: 'none', left: '0', op: '>', right: '1' },
    },
    risk: {
      stop_atr: '$stop_atr',
      target_stop_ratio: '$target_stop_ratio',
      vol: '5m.logvol288',
      vol_minutes: 5,
    },
    horizon_minutes: 1440,
  },
}

const detail: StrategyDetail = {
  id: 'x2',
  version: 1,
  name: 'X2 Sin ventaja',
  description: '',
  state: 'active',
  active_version: 1,
  origin: 'builtin',
  spec,
  versions: [],
  events: [
    { version: 1, state: 'active', reason: 'builtin', known_at: 0 },
    {
      version: 1,
      state: 'active',
      reason: 'manual',
      known_at: 1_791_000_000_000,
    },
  ],
}

const plan: StrategyPlan = {
  id: 'x2',
  version: 1,
  signal: { type: 'rules' },
  entry: { sides: ['LONG', 'SHORT'], checks: [] },
  exit: {
    stop_atr: '2',
    target_stop_ratio: '1.5',
    volatility: 'vol. 24 h',
    time_minutes: 1440,
    rule: {},
  },
  size: { mode: 'fixed', notional_usd: '100' },
  products: 'all',
  costs: { model: 'kraken-futures-costs.v2', scope: 'all' },
  params: {},
}

const evidence = {
  source: 's',
  origin: null,
  state: 'ok',
  detail: null,
  rule: '',
}

const report = (experiments: ExperimentActivity[]): ActivityReport => ({
  generatedAtMs: 1_791_100_000_000,
  window: '24h',
  fromMs: 0,
  toMs: 0,
  product: null,
  evaluations: { state: 'unavailable', evidence, detail: 'n/a' },
  signals: { state: 'unavailable', evidence, detail: 'n/a' },
  discards: { state: 'unavailable', evidence, detail: 'n/a' },
  operations: {
    state: 'ok',
    evidence,
    pairSource: 'x',
    experiments,
    notes: [],
  },
})

const api = {
  mode: 'registry',
  detail: () => Promise.resolve(detail),
  plans: () => Promise.resolve({ x2: plan }),
  inventory: () => Promise.resolve(exampleInventory),
} as unknown as StrategyApi

const x2 = exampleInventory.strategies[1]!

function view(loadActivity: () => Promise<ActivityReport>) {
  return render(
    <StrategyDetailView
      api={api}
      row={x2}
      inventory={exampleInventory}
      onBack={() => {}}
      onOpenLab={() => {}}
      loadActivity={loadActivity}
    />,
  )
}

describe('StrategyDetailView (datos de ejemplo)', () => {
  it('keeps backtest, out of sample and forward apart, each with its source', async () => {
    view(() => Promise.resolve(report([])))
    const perf = within(await screen.findByTestId('module-performance'))
    expect(perf.getByText('Backtest · todo el período')).toBeInTheDocument()
    expect(perf.getByText('Fuera de muestra (OOS)')).toBeInTheDocument()
    expect(
      perf.getByText('Forward paper · desde el primer ciclo'),
    ).toBeInTheDocument()
    expect(perf.getByText('+24,02 pb/op')).toBeInTheDocument()
    // The ranges last 237 days by their real buckets, never the 240 of a label.
    expect(perf.getByTestId('range-table')).toHaveTextContent('237')
    expect(perf.getByTestId('range-table')).not.toHaveTextContent('240')
    expect(screen.getByTestId('module-performance')).toHaveTextContent(
      '2 rangos de 237 d',
    )
    // No forward block: the reason is said, never a number.
    expect(perf.getAllByText('No disponible').length).toBeGreaterThan(0)
    expect(
      perf.getAllByText(/resultados del forward: el servicio no tiene/).length,
    ).toBe(2)
    // A positive mean with a no_edge verdict is never called profitable.
    const verdict = perf.getByTestId('verdict')
    expect(verdict).toHaveTextContent('Sin ventaja demostrada')
    expect(verdict).toHaveTextContent('no es rentabilidad demostrada')
    expect(perf.getByTestId('oos-note')).toHaveTextContent(
      'No disponible: la fuente no marca ningún tramo como fuera de muestra',
    )
    expect(screen.getByTestId('sources-table')).toHaveTextContent(
      'config/strategy-reliability.json',
    )
  })

  it('shows the real spec: sentences, parameters and the reason codes without counts', async () => {
    view(() => Promise.resolve(report([])))
    expect(
      await screen.findByText('Tesis de ejemplo para la prueba.'),
    ).toBeVisible()
    const long = within(screen.getByTestId('side-LONG'))
    expect(long.getByText(/Retorno 6 h >/)).toBeInTheDocument()
    expect(long.getByText('x2_long')).toBeInTheDocument()
    const params = within(screen.getByTestId('params-table'))
    expect(params.getByText('z_min')).toBeInTheDocument()
    expect(params.getByText('2,5')).toBeInTheDocument()
    expect(params.getByText('24 h')).toBeInTheDocument()
    const codes = within(screen.getByTestId('reason-codes'))
    expect(codes.getByText('x2_long')).toBeInTheDocument()
    expect(codes.getByText('B3')).toBeInTheDocument()
    expect(screen.getByTestId('module-pipeline')).toHaveTextContent(
      'no es atribución a una estrategia',
    )
    expect(screen.getByTestId('state-events')).toHaveTextContent(
      'incluida con el código',
    )
  })

  it('offers the general Terminal and does not promise to select the experiment', async () => {
    view(() => Promise.resolve(report([])))
    const link = await screen.findByRole('link', { name: /Abrir la Terminal/ })
    expect(link).toHaveAttribute('href', '/terminal')
    expect(link).toHaveAccessibleDescription(
      'Abre la Terminal general; no selecciona el experimento X2.',
    )
    expect(screen.queryByText(/Ver en Terminal/)).not.toBeInTheDocument()
  })

  it('draws no chart and states that there is no equity curve', async () => {
    const { container } = view(() => Promise.resolve(report([])))
    await screen.findByTestId('module-operations')
    expect(container.querySelector('svg, canvas')).toBeNull()
    expect(screen.getByTestId('module-operations')).toHaveTextContent(
      'Curva de equity y trailing: no disponible',
    )
  })

  it('reads stored operations from B2 and never calls an open record a position', async () => {
    view(() =>
      Promise.resolve(
        report([
          {
            experimentId: 'x2',
            expectedActive: true,
            tradesInWindow: 1,
            openRecords: 0,
            lastCycleMs: 1_791_099_000_000,
            lastTrade: {
              product: 'PF_XBTUSD',
              side: 'LONG',
              entryBucketMs: 1_791_000_000_000,
              exitBucketMs: 1_791_050_000_000,
              exitReason: 'target',
            },
          },
        ]),
      ),
    )
    const ops = within(await screen.findByTestId('stored-ops'))
    expect(ops.getByText('XBTUSD largo')).toBeInTheDocument()
    expect(ops.getByText('Objetivo')).toBeInTheDocument()
    expect(ops.getByText('hace 28 h')).toBeInTheDocument()
    expect(
      ops.getByText(/forward_open: historia, no posición actual/),
    ).toBeVisible()
    expect(screen.getByTestId('module-operations')).toHaveTextContent(
      'Posición actual verificada',
    )
  })

  it('says «No disponible» when B2 fails or has no row for the strategy', async () => {
    const { unmount } = view(() => Promise.reject(new Error('HTTP 404')))
    expect(
      await screen.findByText(/no se pudo leer B2 \(HTTP 404\)/),
    ).toBeVisible()
    unmount()
    view(() => Promise.resolve(report([])))
    expect(await screen.findByText(/B2 no tiene una fila/)).toBeVisible()
  })

  it('words the verdict by research state, never as profitable', () => {
    const x1 = exampleInventory.strategies[0]!
    expect(verdictStatement(x1)).toMatch(/solo el forward/)
    expect(verdictStatement(x1)).not.toMatch(/es rentable/)
  })
})

describe('StrategyLab opens the detail from the strategies page', () => {
  it('shows the detail beside the list and switches strategy', async () => {
    render(
      <StrategyLab
        loadCandles={() =>
          Promise.resolve({ source: 'live', candles: syntheticCandles() })
        }
        connect={() => Promise.resolve(api)}
        loadActivity={() => Promise.resolve(report([]))}
      />,
    )
    await userEvent.click(
      await screen.findByRole('button', { name: 'Ver X2 Sin ventaja' }),
    )
    const detail = await screen.findByTestId('strategy-detail')
    expect(detail).toBeVisible()
    expect(detail).toHaveAccessibleName('Detalle de X2 Sin ventaja')
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(
      screen.getByRole('heading', { name: 'Un libro paper por estrategia' }),
    ).toBeVisible()
  })

  it('opens the laboratory from Nueva estrategia and comes back', async () => {
    const candles = syntheticCandles()
    const off = { status: 'off' as const, reason: 'off', products: [] }
    render(
      <StrategyLab
        loadCandles={() => Promise.resolve({ source: 'live', candles })}
        connect={() =>
          Promise.resolve({
            ...exampleStrategyApi(candles),
            inventory: api.inventory,
          })
        }
        loadQwen={() => Promise.resolve(off)}
        loadKronos={() => Promise.resolve(off)}
        loadActivity={() => Promise.resolve(report([]))}
      />,
    )
    await userEvent.click(
      await screen.findByRole('button', { name: 'Nueva estrategia' }),
    )
    expect(await screen.findByRole('dialog')).toBeVisible()
    expect(screen.getByRole('heading', { name: 'Laboratorio' })).toBeVisible()
    await userEvent.keyboard('{Escape}')
    await userEvent.click(screen.getByRole('button', { name: '← Estrategias' }))
    expect(
      await screen.findByRole('heading', {
        name: 'Un libro paper por estrategia',
      }),
    ).toBeVisible()
  })
})
