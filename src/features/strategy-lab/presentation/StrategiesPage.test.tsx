import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import StrategiesPage from './StrategiesPage.tsx'
import { exampleRow } from '../testing/inventory-fixture.ts'
import {
  StrategyApiError,
  type DeletePreview,
  type StrategyApi,
  type StrategyDetail,
} from '../infrastructure/strategy-api.ts'
import type { StrategySpec } from '../domain/strategy-spec.ts'
import type { RunSummary } from '../infrastructure/run-visual-api.ts'

vi.mock('./StrategyRunView.tsx', () => ({
  default: ({
    strategyName,
    onModify,
    onCreate,
  }: {
    strategyName: string
    onModify?: () => void
    onCreate?: () => void
  }) => (
    <div data-testid="run-view">
      {strategyName}
      <button type="button" onClick={onModify} disabled={!onModify}>
        Modificar
      </button>
      <button type="button" onClick={onCreate}>
        Crear
      </button>
    </div>
  ),
}))

const summary = (patch: Partial<RunSummary> = {}): RunSummary => ({
  verdict: 'NO PASA',
  verdict_note: null,
  inconclusive_reasons: [],
  trades: 115,
  min_trades: 100,
  mean_bp: -52.3,
  ci: [-80, -20],
  positive_folds: 1,
  folds: 5,
  min_positive_fold_share: 0.6,
  percentile: 3,
  min_percentile: 95,
  funding_share: 1,
  funding_status: {},
  open_at_end: null,
  contaminated: false,
  rules: [
    {
      id: 'mean_net_positive',
      label: 'Media neta > 0',
      value: { mean: -52.3, ci_low: -80, ci_high: -20 },
      threshold: 0,
      ok: false,
    },
    {
      id: 'percentile_random',
      label: 'Percentil',
      value: 3,
      threshold: 95,
      ok: false,
    },
    {
      id: 'n_trades',
      label: 'Operaciones',
      value: 115,
      threshold: 100,
      ok: true,
    },
  ],
  ...patch,
})

vi.mock('../infrastructure/gate-api.ts', () => ({
  gateApi: {
    overview: vi.fn(async () => ({
      runs: [
        {
          id: 5,
          strategy_id: 'c40',
          kind: 'practice',
          status: 'done',
          verdict: 'NO PASA',
          progress: 100,
          phase: null,
          detail: null,
          eta_s: null,
          started_at: 0,
          finished_at: 0,
          attempts: 1,
          error: null,
          has_report: true,
          same_version: true,
          params: { from: '2026-01-17', to: '2026-04-19' },
        },
      ],
      exam: { taken: false },
      running: null,
    })),
  },
}))

vi.mock('../infrastructure/run-visual-api.ts', () => ({
  runVisualApi: {
    summary: vi.fn(async () => ({ run_id: 5, summary: summary() })),
  },
}))

const SPEC = {
  schema: 'balancita-strategy.v1',
  id: 'c40',
  version: 1,
  name: 'C40 Ruptura',
  params: { z: '3' },
} as unknown as StrategySpec

const detail = (): StrategyDetail =>
  ({
    id: 'c40',
    version: 1,
    name: 'C40 Ruptura',
    description: '',
    state: 'draft',
    active_version: null,
    created_at: 1_790_000_000_000,
    spec: SPEC,
    versions: [{ id: 'c40', version: 1 }],
    events: [],
  }) as unknown as StrategyDetail

const preview = (patch: Partial<DeletePreview> = {}): DeletePreview => ({
  id: 'c40',
  name: 'C40 Ruptura',
  state: 'draft',
  versions: [{ version: 1, state: 'draft' }],
  active_ms: 0,
  created_at: 0,
  forward_trades: 0,
  forward_net_usd: 0,
  gate_runs: 1,
  exam: { taken: false },
  ledger_kept: false,
  warnings: [],
  operating: false,
  blocked: false,
  ...patch,
})

function fakeApi(state = 'draft') {
  const rows = [
    exampleRow({
      id: 'c40',
      name: 'C40 Ruptura',
      operational: { state, basis: 'registry', since_ms: null, reason: null },
    }),
    exampleRow({
      id: 'c27-retirada',
      name: 'C27 Retirada',
      operational: {
        state: 'closed',
        basis: 'config',
        since_ms: null,
        reason: null,
      },
    }),
    exampleRow({
      id: 'c99-sin-registro',
      name: 'C99 Sin registro',
      operational: {
        state: 'unverified',
        basis: 'none',
        since_ms: null,
        reason: null,
      },
    }),
    exampleRow({
      id: 'kronos-small-1h-h4-v1',
      name: 'Kronos',
      kind: 'model',
    }),
  ]
  const api = {
    mode: 'registry',
    inventory: vi.fn(async () => ({ strategies: rows })),
    detail: vi.fn(async () => detail()),
    importSpec: vi.fn(async (spec: StrategySpec) => ({
      id: 'c41-nueva',
      version: 1,
      name: spec.name,
    })),
    save: vi.fn(async (spec: StrategySpec) => ({
      id: spec.id,
      version: 2,
      name: spec.name,
    })),
    rename: vi.fn(async (id: string, title: string) => ({
      id,
      version: 1,
      name: title,
    })),
    deletePreview: vi.fn(async () =>
      preview({
        operating: state === 'active',
        blocked: state === 'active',
        state: state as DeletePreview['state'],
      }),
    ),
    deleteStrategy: vi.fn(async () => ({
      purge_id: null,
      state: 'done' as const,
      consumers: {},
    })),
    purgeStatus: vi.fn(),
    setState: vi.fn(async () => ({
      id: 'c40',
      version: 1,
      name: 'x',
      gates: [],
    })),
    gatePassed: vi.fn(async () => false),
  }
  return api as unknown as StrategyApi & typeof api
}

async function openMenu(name: string) {
  const user = userEvent.setup()
  await screen.findByRole('navigation', { name: 'Lista de estrategias' })
  await user.click(screen.getByRole('button', { name: `Opciones de ${name}` }))
  return user
}

function renderPage(api: StrategyApi) {
  return render(<StrategiesPage api={api} connectError={null} reload={0} />)
}

beforeEach(() => vi.clearAllMocks())

describe('StrategiesPage list', () => {
  it('lists only what exists: no retired and no unknown strategies, Kronos stays', async () => {
    renderPage(fakeApi())
    const list = await screen.findByRole('navigation', {
      name: 'Lista de estrategias',
    })
    await waitFor(() =>
      expect(within(list).getByText('C40 Ruptura')).toBeVisible(),
    )
    expect(within(list).getByText('Kronos')).toBeVisible()
    expect(within(list).queryByText('C27 Retirada')).toBeNull()
    expect(within(list).queryByText('C99 Sin registro')).toBeNull()
  })
})

describe('StrategiesPage menu', () => {
  it('offers detalles, modificar and borrar on a strategy of rules', async () => {
    renderPage(fakeApi())
    await openMenu('C40 Ruptura')
    const menu = screen.getByRole('menu')
    for (const item of ['Detalles', 'Modificar', 'Borrar'])
      expect(within(menu).getByRole('menuitem', { name: item })).toBeVisible()
  })

  it('offers only detalles on Kronos, which is never edited or deleted here', async () => {
    renderPage(fakeApi())
    await openMenu('Kronos')
    const menu = screen.getByRole('menu')
    expect(within(menu).getAllByRole('menuitem')).toHaveLength(1)
    expect(
      within(menu).getByRole('menuitem', { name: 'Detalles' }),
    ).toBeVisible()
  })
})

describe('Borrar', () => {
  it('asks once and deletes only after Aceptar', async () => {
    const api = fakeApi()
    renderPage(api)
    const user = await openMenu('C40 Ruptura')
    await user.click(screen.getByRole('menuitem', { name: 'Borrar' }))
    const dialog = await screen.findByRole('dialog')
    expect(
      within(dialog).getByText(
        '¿Está seguro que quiere eliminar «C40 Ruptura»?',
      ),
    ).toBeVisible()
    await user.click(within(dialog).getByRole('button', { name: 'Cancelar' }))
    expect(api.deleteStrategy).not.toHaveBeenCalled()

    await user.click(
      screen.getByRole('button', { name: 'Opciones de C40 Ruptura' }),
    )
    await user.click(screen.getByRole('menuitem', { name: 'Borrar' }))
    const again = await screen.findByRole('dialog')
    await waitFor(() =>
      expect(
        within(again).getByRole('button', { name: 'Aceptar' }),
      ).toBeEnabled(),
    )
    await user.click(within(again).getByRole('button', { name: 'Aceptar' }))
    await waitFor(() =>
      expect(api.deleteStrategy).toHaveBeenCalledWith('c40', 'c40'),
    )
    expect(await screen.findByText(/se borró por completo/)).toBeVisible()
  })

  it('refuses a strategy that is operating and says to switch it off first', async () => {
    const api = fakeApi('active')
    renderPage(api)
    const user = await openMenu('C40 Ruptura')
    await user.click(screen.getByRole('menuitem', { name: 'Borrar' }))
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByText(/Primero apagala/)).toBeVisible()
    expect(within(dialog).queryByRole('button', { name: 'Aceptar' })).toBeNull()
    expect(api.deleteStrategy).not.toHaveBeenCalled()
  })
})

describe('Crear', () => {
  it('creates with a title and the pasted JSON, and selects the new strategy', async () => {
    const api = fakeApi()
    renderPage(api)
    const user = userEvent.setup()
    await screen.findByTestId('run-view')
    await user.click(screen.getByRole('button', { name: 'Crear' }))
    const dialog = await screen.findByRole('dialog', {
      name: 'Crear estrategia',
    })
    await user.type(within(dialog).getByLabelText('Título'), 'Mi idea')
    const area = within(dialog).getByLabelText('JSON de la estrategia')
    await user.click(area)
    await user.paste(JSON.stringify({ ...SPEC, id: 'c41', name: 'otro' }))
    await user.click(within(dialog).getByRole('button', { name: 'Crear' }))
    await waitFor(() => expect(api.importSpec).toHaveBeenCalled())
    expect(api.importSpec.mock.calls[0]![0]).toMatchObject({ name: 'Mi idea' })
    expect(await screen.findByText(/Se creó «Mi idea»/)).toBeVisible()
  })

  it('says it in plain words when the JSON is not valid', async () => {
    renderPage(fakeApi())
    const user = userEvent.setup()
    await screen.findByTestId('run-view')
    await user.click(screen.getByRole('button', { name: 'Crear' }))
    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByLabelText('Título'), 'X')
    await user.click(within(dialog).getByLabelText('JSON de la estrategia'))
    await user.paste('{ no es json')
    await user.click(within(dialog).getByRole('button', { name: 'Crear' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'No es un JSON válido',
    )
  })

  it('explains a duplicate instead of printing the server text', async () => {
    const api = fakeApi()
    api.importSpec.mockRejectedValueOnce(
      new StrategyApiError('duplicate_spec', 'same rules as c40 v1', 409, []),
    )
    renderPage(api)
    const user = userEvent.setup()
    await screen.findByTestId('run-view')
    await user.click(screen.getByRole('button', { name: 'Crear' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByLabelText('JSON de la estrategia'))
    await user.paste(JSON.stringify(SPEC))
    await user.click(within(dialog).getByRole('button', { name: 'Crear' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'mismas reglas y parámetros',
    )
  })
})

describe('Modificar', () => {
  async function openEditor(api: ReturnType<typeof fakeApi>) {
    renderPage(api)
    const user = userEvent.setup()
    await screen.findByTestId('run-view')
    await user.click(screen.getByRole('button', { name: 'Modificar' }))
    const dialog = await screen.findByRole('dialog', {
      name: 'Modificar estrategia',
    })
    await waitFor(() =>
      expect(within(dialog).getByLabelText('Título')).toHaveValue(
        'C40 Ruptura',
      ),
    )
    return { user, dialog }
  }

  it('a new title alone is a rename, not a new version', async () => {
    const api = fakeApi()
    const { user, dialog } = await openEditor(api)
    const title = within(dialog).getByLabelText('Título')
    await user.clear(title)
    await user.type(title, 'Nombre nuevo')
    await user.click(within(dialog).getByRole('button', { name: 'Guardar' }))
    await waitFor(() =>
      expect(api.rename).toHaveBeenCalledWith('c40', 'Nombre nuevo'),
    )
    expect(api.save).not.toHaveBeenCalled()
  })

  it('a changed JSON saves a new version of the same strategy', async () => {
    const api = fakeApi()
    const { user, dialog } = await openEditor(api)
    const area = within(dialog).getByLabelText('JSON de la estrategia')
    await user.clear(area)
    await user.click(area)
    await user.paste(JSON.stringify({ ...SPEC, params: { z: '4' } }))
    await user.click(within(dialog).getByRole('button', { name: 'Guardar' }))
    await waitFor(() => expect(api.save).toHaveBeenCalled())
    const [spec, mode] = api.save.mock.calls[0] as unknown as [
      StrategySpec,
      string,
    ]
    expect(mode).toBe('modify')
    expect(spec).toMatchObject({ id: 'c40', params: { z: '4' } })
    expect(api.rename).not.toHaveBeenCalled()
    expect(
      await screen.findByText(/versión 2\. Sus pruebas empiezan de cero/),
    ).toBeVisible()
  })

  it('changing nothing just closes', async () => {
    const api = fakeApi()
    const { user, dialog } = await openEditor(api)
    await user.click(within(dialog).getByRole('button', { name: 'Guardar' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(api.save).not.toHaveBeenCalled()
    expect(api.rename).not.toHaveBeenCalled()
  })
})

describe('Detalles', () => {
  it('shows each test that did not pass with where it failed and why', async () => {
    renderPage(fakeApi())
    const user = await openMenu('C40 Ruptura')
    await user.click(screen.getByRole('menuitem', { name: 'Detalles' }))
    const dialog = await screen.findByRole('dialog', {
      name: 'Detalles de C40 Ruptura',
    })
    const reasons = await within(dialog).findByRole('list', {
      name: 'En qué falló Práctica #5',
    })
    expect(reasons).toHaveTextContent(
      'Perdió en promedio −52,3 pb por operación',
    )
    expect(reasons).toHaveTextContent('No le ganó al azar')
    expect(reasons).not.toHaveTextContent('Pocas operaciones')
    expect(
      within(dialog).getByText('2026-01-17 a 2026-04-19', { exact: false }),
    ).toBeVisible()
  })
})
