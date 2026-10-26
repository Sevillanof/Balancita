import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import StrategyRunView from './StrategyRunView.tsx'
import type { GateApi, GateOverview } from '../infrastructure/gate-api.ts'
import type { RunVisualApi } from '../infrastructure/run-visual-api.ts'
import type { StrategyDetail } from '../infrastructure/strategy-api.ts'
import {
  VectorbtError,
  type VectorbtApi,
} from '../infrastructure/vectorbt-api.ts'
import {
  comparison,
  exampleReport,
  exampleSpec,
  exploration,
  fakeVectorbt,
  variantsReport,
  vbtState,
} from '../testing/vectorbt-fixture.ts'

vi.mock('../../trading-view/presentation/ApprovedTerminalChart.tsx', () => ({
  default: () => <div data-testid="chart" />,
}))

/* DATOS DE EJEMPLO: pruebas y estrategias inventadas solo para estas pruebas. */
const idle: GateOverview = { runs: [], exam: { taken: false }, running: null }
const gateWith = (data: GateOverview = idle): GateApi => ({
  overview: vi.fn(async () => data),
  start: vi.fn(async () => ({ run_id: 99 })),
  cancel: vi.fn(),
  report: vi.fn(),
})
const visual = (): RunVisualApi => ({
  summary: vi.fn(),
  candles: vi.fn(),
  trades: vi.fn(),
  decisions: vi.fn(),
})
const registryWith = (detail: Partial<StrategyDetail> = {}) => ({
  detail: vi.fn(
    async () =>
      ({
        id: 'x2',
        version: 1,
        name: 'X2',
        description: '',
        state: 'draft',
        active_version: null,
        spec: exampleSpec(),
        versions: [],
        events: [],
        ...detail,
      }) as StrategyDetail,
  ),
})

const mount = (
  vectorbt: VectorbtApi,
  extra: Partial<React.ComponentProps<typeof StrategyRunView>> = {},
) =>
  render(
    <StrategyRunView
      strategyId="x2"
      strategyName="X2 Breakout"
      version={1}
      gate={gateWith()}
      visual={visual()}
      vectorbt={vectorbt}
      registry={registryWith()}
      kind="rules"
      {...extra}
    />,
  )

const explore = () =>
  screen.findByRole('button', {
    name: /Explorar con VectorBT|Exploración en curso/,
  })

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('botón «Explorar con VectorBT»', () => {
  it('se habilita junto a Testear cuando todo está disponible', async () => {
    mount(fakeVectorbt(vbtState()))
    expect(await explore()).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Testear' })).toBeInTheDocument()
  })

  it('queda deshabilitado con el motivo si la estrategia no es de reglas', async () => {
    mount(fakeVectorbt(vbtState()), { kind: 'qwen_exit' })
    const button = await explore()
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute(
      'title',
      'VectorBT solo explora estrategias de reglas.',
    )
  })

  it('si el entorno no está, muestra el texto del servidor con los comandos en un bloque copiable', async () => {
    const reason =
      'Falta instalar el entorno de VectorBT: ejecutá «uv venv --python 3.12 .venv-vectorbt» y después «uv pip install --python .venv-vectorbt/bin/python -r research/vectorbt/requirements.lock».'
    mount(fakeVectorbt(vbtState({ available: false, reason })))
    expect(await explore()).toBeDisabled()
    const install = await screen.findByTestId('vbt-install')
    expect(install).toHaveTextContent('Falta instalar el entorno de VectorBT')
    const block = within(install).getByLabelText('Comandos de instalación')
    expect(block).toHaveTextContent('uv venv --python 3.12 .venv-vectorbt')
    expect(block.textContent).toContain('\n')
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })
    await userEvent.click(
      within(install).getByRole('button', { name: 'Copiar comandos' }),
    )
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining('uv pip install --python'),
    )
    expect(
      await within(install).findByRole('button', { name: 'Copiado' }),
    ).toBeInTheDocument()
  })

  it('con otra exploración en curso (busy_with) dice cuál y no deja empezar', async () => {
    mount(
      fakeVectorbt(
        vbtState({
          busy_with: {
            exploration_id: 'e9',
            strategy_id: 'c27-breakout-perp-v1',
          },
        }),
      ),
    )
    expect(await explore()).toBeDisabled()
    expect(await screen.findByTestId('vbt-why')).toHaveTextContent(
      'c27-breakout-perp-v1',
    )
  })

  it('con una prueba de la compuerta en curso explica que comparten procesador', async () => {
    mount(fakeVectorbt(vbtState()), {
      gate: gateWith({ ...idle, running: { id: 4, strategy_id: 'x2' } }),
    })
    expect(await explore()).toBeDisabled()
    await waitFor(() =>
      expect(screen.getByTestId('vbt-why')).toHaveTextContent(
        'comparte el procesador',
      ),
    )
  })

  it('si no puede consultar al servidor lo dice sin romper la tarjeta', async () => {
    const api = fakeVectorbt(vbtState(), {
      status: async () => {
        throw new Error('sin respuesta')
      },
    })
    mount(api)
    expect(await explore()).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Testear' })).toBeInTheDocument()
  })
})

describe('modal', () => {
  it('Diagnóstico lanza la estrategia tal cual y avisa de la ventana de datos', async () => {
    const user = userEvent.setup()
    const launch = vi.fn(async () => ({ exploration_id: 'e1', pid: 1 }))
    mount(fakeVectorbt(vbtState(), { launch }))
    await user.click(await explore())
    const dialog = screen.getByRole('dialog', { name: 'Explorar con VectorBT' })
    expect(dialog).toHaveTextContent('19-abr-2026')
    expect(dialog).toHaveTextContent('el examen queda intacto')
    await user.click(within(dialog).getByRole('button', { name: 'Explorar' }))
    expect(launch).toHaveBeenCalledWith('x2', { mode: 'diagnostic' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('Variantes lista lo que se puede cambiar, cuenta las variantes y avisa los intentos', async () => {
    const user = userEvent.setup()
    const launch = vi.fn(async () => ({ exploration_id: 'e1', pid: 1 }))
    mount(fakeVectorbt(vbtState({ attempts_in_family: 7 }), { launch }))
    await user.click(await explore())
    const dialog = screen.getByRole('dialog')
    await user.click(within(dialog).getByRole('radio', { name: /Variantes/ }))
    const select = await within(dialog).findByLabelText('¿Qué querés cambiar?')
    await user.selectOptions(select, 'stop_atr')
    expect(within(dialog).getByTestId('vbt-current')).toHaveTextContent(
      'Ahora vale 1,5',
    )
    await user.type(within(dialog).getByLabelText('Mínimo'), '1')
    await user.type(within(dialog).getByLabelText('Máximo'), '2,5')
    await user.type(within(dialog).getByLabelText('Paso'), '0,5')
    expect(within(dialog).getByTestId('vbt-count')).toHaveTextContent(
      'Saldrían 4 variantes',
    )
    expect(dialog).toHaveTextContent('Llevás 7 intentos con esta estrategia')
    expect(dialog).toHaveTextContent('Una sola condición por vez')
    await user.click(within(dialog).getByRole('button', { name: 'Explorar' }))
    expect(launch).toHaveBeenCalledWith('x2', {
      mode: 'variants',
      vary: 'stop_atr',
      values: ['1', '1.5', '2', '2.5'],
    })
  })

  it('con más de 12 valores avisa y no deja explorar; una lista a mano también vale', async () => {
    const user = userEvent.setup()
    const launch = vi.fn(async () => ({ exploration_id: 'e1', pid: 1 }))
    mount(fakeVectorbt(vbtState(), { launch }))
    await user.click(await explore())
    const dialog = screen.getByRole('dialog')
    await user.click(within(dialog).getByRole('radio', { name: /Variantes/ }))
    await within(dialog).findByLabelText('¿Qué querés cambiar?')
    await user.type(within(dialog).getByLabelText('Mínimo'), '1')
    await user.type(within(dialog).getByLabelText('Máximo'), '20')
    await user.type(within(dialog).getByLabelText('Paso'), '1')
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      'Salen 20 valores y el máximo es 12',
    )
    expect(
      within(dialog).getByRole('button', { name: 'Explorar' }),
    ).toBeDisabled()
    await user.click(
      within(dialog).getByRole('radio', { name: /lista a mano/ }),
    )
    await user.type(within(dialog).getByLabelText(/Valores/), '1; 1,5; 3')
    expect(within(dialog).getByTestId('vbt-count')).toHaveTextContent(
      'Saldrían 3 variantes',
    )
    await user.click(within(dialog).getByRole('button', { name: 'Explorar' }))
    expect(launch).toHaveBeenCalledWith('x2', {
      mode: 'variants',
      vary: 'volume_multiplier',
      values: ['1', '1.5', '3'],
    })
  })

  it('una condición solo admite enteros', async () => {
    const user = userEvent.setup()
    mount(fakeVectorbt(vbtState()))
    await user.click(await explore())
    const dialog = screen.getByRole('dialog')
    await user.click(within(dialog).getByRole('radio', { name: /Variantes/ }))
    const select = await within(dialog).findByLabelText('¿Qué querés cambiar?')
    await user.selectOptions(select, 'rules.checks[1].node.right')
    await user.click(
      within(dialog).getByRole('radio', { name: /lista a mano/ }),
    )
    await user.type(within(dialog).getByLabelText(/Valores/), '45; 52,5')
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      'solo admite números enteros',
    )
  })

  it('muestra el error del servidor (409 busy) y deja reintentar', async () => {
    const user = userEvent.setup()
    const launch = vi.fn(async () => {
      throw new VectorbtError(
        'busy',
        409,
        'Ya hay una exploración de VectorBT en curso (c27).',
      )
    })
    mount(fakeVectorbt(vbtState(), { launch }))
    await user.click(await explore())
    const dialog = screen.getByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Explorar' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Ya hay una exploración de VectorBT en curso (c27).',
    )
    expect(
      within(dialog).getByRole('button', { name: 'Explorar' }),
    ).toBeEnabled()
  })

  it('si no se puede leer la estrategia, Variantes lo dice', async () => {
    const user = userEvent.setup()
    mount(fakeVectorbt(vbtState()), {
      registry: {
        detail: async () => {
          throw new Error('No existe la estrategia')
        },
      },
    })
    await user.click(await explore())
    const dialog = screen.getByRole('dialog')
    await user.click(within(dialog).getByRole('radio', { name: /Variantes/ }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'No se pudo leer la estrategia',
    )
  })
})

describe('progreso de la exploración', () => {
  const running = exploration({
    status: 'running',
    progress: 37.5,
    phase: 'Descargando datos',
    detail: 'Descargando velas de Kraken (ETH 2/3)',
    eta: 240,
    report: null,
  })

  it('retoma la exploración en curso al cargar: relleno real, fase, detalle, aviso y tiempo', async () => {
    mount(fakeVectorbt(vbtState({ running })))
    const bar = await screen.findByRole('progressbar', {
      name: 'Progreso de la exploración con VectorBT',
    })
    expect(bar).toHaveAttribute('aria-valuenow', '38')
    expect(bar).toHaveAttribute('aria-valuemax', '100')
    const fill = within(bar).getAllByTestId('run-progress-fill')[0]
    expect(fill?.style.width).toBe('37.5%')
    const text = screen.getByTestId('vbt-progress-text')
    expect(text).toHaveTextContent('Descargando velas de Kraken (ETH 2/3)')
    expect(text).toHaveTextContent('faltan unos 4 min')
    expect(bar).toHaveTextContent('La primera vez tarda más')
    expect(await explore()).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Testear' })).toBeDisabled()
  })

  it('va debajo de las etapas', async () => {
    mount(fakeVectorbt(vbtState({ running })))
    const bar = await screen.findByRole('progressbar')
    const stages = screen.getByRole('list', { name: 'Etapa de la estrategia' })
    expect(
      stages.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it('Cancelar le avisa al servidor', async () => {
    const user = userEvent.setup()
    const cancel = vi.fn(async () => undefined)
    mount(fakeVectorbt(vbtState({ running }), { cancel }))
    await user.click(await screen.findByRole('button', { name: 'Cancelar' }))
    expect(cancel).toHaveBeenCalledWith('x2', running.id)
  })

  it('consulta cada pocos segundos mientras corre y muestra el reporte cuando termina', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const done = exploration({ report: exampleReport() })
    let calls = 0
    const status = vi.fn(async () => {
      calls += 1
      if (calls < 3)
        return vbtState({
          running: {
            ...running,
            progress: 10 * calls,
            phase: 'Probando la estrategia',
            detail: '',
          },
        })
      return vbtState({ explorations: [done] })
    })
    mount(fakeVectorbt(vbtState(), { status }))
    await screen.findByRole('progressbar')
    await act(() => vi.advanceTimersByTimeAsync(2600))
    await act(() => vi.advanceTimersByTimeAsync(2600))
    expect(status.mock.calls.length).toBeGreaterThanOrEqual(3)
    expect(await screen.findByTestId('vbt-report')).toBeInTheDocument()
    expect(screen.queryByRole('progressbar')).toBeNull()
    expect(await explore()).toBeEnabled()
  })
})

describe('reporte de VectorBT', () => {
  it('muestra qué funciona, qué falla, tablas, totales, ventana y que es un diagnóstico rápido', async () => {
    mount(fakeVectorbt(vbtState({ explorations: [exploration()] })))
    const report = await screen.findByTestId('vbt-report')
    expect(within(report).getByText('Qué funciona')).toBeInTheDocument()
    expect(report).toHaveTextContent(
      'Los cierres por objetivo ganan +70 pb en promedio.',
    )
    expect(within(report).getByText('Qué falla')).toBeInTheDocument()
    expect(report).toHaveTextContent('En total pierde 4,2 pb por operación')
    const products = within(report).getByRole('table', { name: 'Por producto' })
    expect(products).toHaveTextContent('PF_XBTUSD')
    expect(products).toHaveTextContent('−2,5 pb')
    const exits = within(report).getByRole('table', {
      name: 'Por tipo de salida',
    })
    expect(exits).toHaveTextContent('Objetivo')
    expect(exits).toHaveTextContent('24 %')
    const totals = report.querySelector('dl')
    expect(totals).toHaveTextContent('143')
    expect(totals).toHaveTextContent('−4,2 pb')
    expect(totals).toHaveTextContent('46 %')
    expect(screen.getByTestId('vbt-window')).toHaveTextContent(
      '16-oct-2025 a 19-abr-2026',
    )
    expect(screen.getByTestId('vbt-window')).toHaveTextContent(
      'diagnóstico rápido, no un veredicto',
    )
    expect(screen.getByTestId('vbt-warning')).toHaveTextContent('no un PASA')
  })

  it('es plegable', async () => {
    const user = userEvent.setup()
    mount(fakeVectorbt(vbtState({ explorations: [exploration()] })))
    const report = await screen.findByTestId('vbt-report')
    await user.click(within(report).getByRole('button', { name: 'Ocultar' }))
    expect(within(report).queryByText('Qué funciona')).toBeNull()
    await user.click(within(report).getByRole('button', { name: 'Mostrar' }))
    expect(within(report).getByText('Qué funciona')).toBeInTheDocument()
  })

  it('copia el reporte en Markdown', async () => {
    const user = userEvent.setup()
    mount(fakeVectorbt(vbtState({ explorations: [exploration()] })))
    const report = await screen.findByTestId('vbt-report')
    await user.click(
      within(report).getByRole('button', { name: 'Copiar en Markdown' }),
    )
    expect(await navigator.clipboard.readText()).toContain(
      '# Reporte de VectorBT: X2 Ejemplo',
    )
    expect(
      within(report).getByRole('button', { name: 'Copiado ✓' }),
    ).toBeInTheDocument()
  })

  it('una estrategia no soportada muestra el motivo sin dramatismo', async () => {
    const unsupported = exploration({
      status: 'unsupported',
      report: exampleReport({
        status: 'unsupported',
        diagnostic: null,
        unsupported: { reason: 'usa el funding de 30 días (5m.fundpct)' },
      }),
    })
    mount(fakeVectorbt(vbtState({ explorations: [unsupported] })))
    const note = await screen.findByTestId('vbt-unsupported')
    expect(note).toHaveTextContent('usa el funding de 30 días')
    expect(note).toHaveTextContent('Testear')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('una exploración fallida o cancelada se avisa en una línea', async () => {
    mount(
      fakeVectorbt(
        vbtState({
          explorations: [
            exploration({
              status: 'failed',
              report: null,
              detail: 'El proceso terminó sin cerrar la exploración.',
            }),
          ],
        }),
      ),
    )
    expect(await screen.findByTestId('vbt-last-failed')).toHaveTextContent(
      'El proceso terminó sin cerrar la exploración.',
    )
  })

  it('permite elegir entre exploraciones anteriores', async () => {
    const user = userEvent.setup()
    const older = exploration({
      id: 'old',
      created_at: Date.UTC(2026, 9, 20, 9, 0),
      report: variantsReport(),
      mode: 'variants',
      vary: 'stop_atr',
    })
    mount(fakeVectorbt(vbtState({ explorations: [exploration(), older] })))
    const report = await screen.findByTestId('vbt-report')
    expect(within(report).queryByTestId('vbt-ranking')).toBeNull()
    await user.selectOptions(
      within(report).getByLabelText('Exploración'),
      'old',
    )
    expect(await screen.findByTestId('vbt-ranking')).toBeInTheDocument()
  })
})

describe('ranking de variantes', () => {
  const withVariants = (confirmed: Record<string, string> = {}) =>
    exploration({
      mode: 'variants',
      vary: 'stop_atr',
      values: ['2', '2.5', '1.5', '1', '3'],
      report: variantsReport(),
      confirmed,
    })

  it('lista el ranking con el contador de intentos y el aviso de hipótesis', async () => {
    mount(
      fakeVectorbt(
        vbtState({ explorations: [withVariants()], attempts_in_family: 9 }),
      ),
    )
    const ranking = await screen.findByTestId('vbt-ranking')
    expect(screen.getByTestId('vbt-attempts')).toHaveTextContent(
      'Llevás 9 intentos con esta estrategia.',
    )
    expect(screen.getByTestId('vbt-attempts')).toHaveTextContent(
      'Son hipótesis',
    )
    const rows = within(ranking).getAllByTestId('vbt-row')
    expect(rows).toHaveLength(5)
    expect(rows[0]).toHaveTextContent('2')
    expect(rows[0]).toHaveTextContent('+5,0 pb')
    expect(rows[2]).toHaveTextContent('(la actual)')
    expect(rows[4]).toHaveTextContent('No se pudo probar: valor no admitido')
  })

  it('«Confirmar en simulador» solo en las 3 primeras filas y nunca en la actual', async () => {
    mount(fakeVectorbt(vbtState({ explorations: [withVariants()] })))
    const ranking = await screen.findByTestId('vbt-ranking')
    const buttons = within(ranking).getAllByRole('button', {
      name: 'Confirmar en simulador',
    })
    expect(buttons).toHaveLength(2)
    const rows = within(ranking).getAllByTestId('vbt-row')
    expect(
      within(rows[0]!).getByRole('button', { name: 'Confirmar en simulador' }),
    ).toBeInTheDocument()
    expect(
      within(rows[2]!).queryByRole('button', {
        name: 'Confirmar en simulador',
      }),
    ).toBeNull()
    expect(
      within(rows[3]!).queryByRole('button', {
        name: 'Confirmar en simulador',
      }),
    ).toBeNull()
  })

  it('confirmar crea el borrador, lanza Testear sobre él y avisa con una nota', async () => {
    const user = userEvent.setup()
    const confirm = vi.fn(async () => ({
      strategy_id: 'x2-v2',
      version: 1,
      title: 'X2 Ejemplo · stop_atr=2',
      state: 'draft' as const,
      already: false,
    }))
    const gate = gateWith()
    const onVariantStarted = vi.fn()
    mount(
      fakeVectorbt(vbtState({ explorations: [withVariants()] }), { confirm }),
      {
        gate,
        onVariantStarted,
      },
    )
    const ranking = await screen.findByTestId('vbt-ranking')
    const first = within(ranking).getAllByTestId('vbt-row')[0]!
    await user.click(
      within(first).getByRole('button', { name: 'Confirmar en simulador' }),
    )
    await waitFor(() => expect(onVariantStarted).toHaveBeenCalled())
    expect(confirm).toHaveBeenCalledWith('x2', 'x2-20261022-101500', '2')
    expect(gate.start).toHaveBeenCalledWith('x2-v2', {
      from: '2025-01-01',
      to: '2025-04-01',
    })
    expect(onVariantStarted).toHaveBeenCalledWith(
      'x2-v2',
      'Se creó «X2 Ejemplo · stop_atr=2» como borrador y se está probando.',
    )
  })

  it('si Testear no puede empezar, igual avisa que el borrador existe', async () => {
    const user = userEvent.setup()
    const gate = gateWith()
    vi.mocked(gate.start).mockRejectedValue(
      new Error('Hay una prueba en curso.'),
    )
    const onVariantStarted = vi.fn()
    mount(fakeVectorbt(vbtState({ explorations: [withVariants()] })), {
      gate,
      onVariantStarted,
    })
    const ranking = await screen.findByTestId('vbt-ranking')
    await user.click(
      within(within(ranking).getAllByTestId('vbt-row')[0]!).getByRole(
        'button',
        {
          name: 'Confirmar en simulador',
        },
      ),
    )
    await waitFor(() => expect(onVariantStarted).toHaveBeenCalled())
    const note = onVariantStarted.mock.calls[0]![1] as string
    expect(note).toContain('como borrador, pero no se pudo empezar la prueba')
    expect(note).toContain('Hay una prueba en curso.')
  })

  it('si confirmar falla muestra el motivo y no cambia de estrategia', async () => {
    const user = userEvent.setup()
    const confirm = vi.fn(async () => {
      throw new VectorbtError(
        'duplicate_spec',
        409,
        'Ya existe una estrategia con las mismas reglas.',
      )
    })
    const gate = gateWith()
    const onVariantStarted = vi.fn()
    mount(
      fakeVectorbt(vbtState({ explorations: [withVariants()] }), { confirm }),
      {
        gate,
        onVariantStarted,
      },
    )
    const ranking = await screen.findByTestId('vbt-ranking')
    await user.click(
      within(within(ranking).getAllByTestId('vbt-row')[0]!).getByRole(
        'button',
        {
          name: 'Confirmar en simulador',
        },
      ),
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Ya existe una estrategia con las mismas reglas.',
    )
    expect(gate.start).not.toHaveBeenCalled()
    expect(onVariantStarted).not.toHaveBeenCalled()
  })

  it('una variante ya creada muestra «VectorBT vs simulador» con las frases y el aviso', async () => {
    const user = userEvent.setup()
    const compare = vi.fn(async () => comparison())
    mount(
      fakeVectorbt(
        vbtState({ explorations: [withVariants({ '2': 'x2-v2' })] }),
        {
          compare,
        },
      ),
    )
    const ranking = await screen.findByTestId('vbt-ranking')
    const first = within(ranking).getAllByTestId('vbt-row')[0]!
    expect(first).toHaveTextContent('Ya creada')
    expect(
      within(first).queryByRole('button', { name: 'Confirmar en simulador' }),
    ).toBeNull()
    await user.click(
      within(first).getByRole('button', { name: /Ver VectorBT vs simulador/ }),
    )
    const panel = await screen.findByRole('region', {
      name: 'VectorBT contra el simulador',
    })
    expect(compare).toHaveBeenCalledWith(
      'x2',
      'x2-20261022-101500',
      '2',
      undefined,
    )
    expect(panel).toHaveTextContent('VectorBT')
    expect(panel).toHaveTextContent('Simulador')
    expect(panel).toHaveTextContent('El simulador paga 2 pb más de costos')
    expect(within(panel).getByTestId('vbt-compare-warning')).toHaveTextContent(
      'Sigue siendo una hipótesis',
    )
    expect(
      within(panel).getByRole('row', { name: /Resultado neto por operación/ }),
    ).toHaveTextContent('+5,0 pb')
  })

  it('la fila actual también se compara con el simulador', async () => {
    const user = userEvent.setup()
    const compare = vi.fn(async () =>
      comparison({ is_base: true, value: '1.5' }),
    )
    mount(
      fakeVectorbt(vbtState({ explorations: [withVariants()] }), { compare }),
    )
    const ranking = await screen.findByTestId('vbt-ranking')
    const base = within(ranking).getAllByTestId('vbt-row')[2]!
    await user.click(
      within(base).getByRole('button', { name: /VectorBT vs simulador/ }),
    )
    await waitFor(() => expect(compare).toHaveBeenCalled())
    expect(compare).toHaveBeenCalledWith(
      'x2',
      'x2-20261022-101500',
      '1.5',
      undefined,
    )
  })

  it('si todavía no hay práctica terminada de la variante, muestra el motivo del servidor', async () => {
    const user = userEvent.setup()
    const compare = vi.fn(async () => {
      throw new VectorbtError(
        'run_not_found',
        404,
        'Todavía no hay una prueba terminada de esa variante.',
      )
    })
    mount(
      fakeVectorbt(
        vbtState({ explorations: [withVariants({ '2': 'x2-v2' })] }),
        {
          compare,
        },
      ),
    )
    const ranking = await screen.findByTestId('vbt-ranking')
    await user.click(
      within(within(ranking).getAllByTestId('vbt-row')[0]!).getByRole(
        'button',
        {
          name: /VectorBT vs simulador/,
        },
      ),
    )
    expect(await screen.findByTestId('vbt-compare-error')).toHaveTextContent(
      'Todavía no hay una prueba terminada de esa variante.',
    )
  })
})

describe('la variante creada con VectorBT', () => {
  const parentExploration = exploration({
    strategy_id: 'x2',
    mode: 'variants',
    report: variantsReport(),
    confirmed: { '2': 'x2-v2' },
  })
  const asVariant = () =>
    registryWith({
      id: 'x2-v2',
      origin: 'vectorbt',
      parent: { id: 'x2', version: 1 },
    })
  const statusOf = (id: string) =>
    id === 'x2' ? vbtState({ explorations: [parentExploration] }) : vbtState()

  it('guarda el vínculo con su exploración y compara cuando su práctica terminó', async () => {
    const user = userEvent.setup()
    const compare = vi.fn(async () => comparison({ strategy_id: 'x2' }))
    const api = fakeVectorbt(vbtState(), {
      status: async (id) => statusOf(id),
      compare,
    })
    const done = {
      ...idle,
      runs: [
        {
          id: 12,
          strategy_id: 'x2-v2',
          kind: 'practice',
          status: 'done',
          verdict: 'NO PASA',
          progress: 100,
          phase: 'terminada',
          detail: null,
          eta_s: null,
          started_at: 1,
          finished_at: 2,
          attempts: 1,
          error: null,
          has_report: true,
        },
      ],
    } as GateOverview
    render(
      <StrategyRunView
        strategyId="x2-v2"
        strategyName="X2 · stop_atr=2"
        version={1}
        gate={gateWith(done)}
        visual={{
          summary: vi.fn(async () => {
            throw new Error('sin operaciones guardadas')
          }),
          candles: vi.fn(),
          trades: vi.fn(),
          decisions: vi.fn(),
        }}
        vectorbt={api}
        registry={asVariant()}
        kind="rules"
      />,
    )
    const origin = await screen.findByTestId('vbt-origin')
    expect(origin).toHaveTextContent('variante de «X2 Ejemplo»')
    const button = screen.getByRole('button', { name: 'VectorBT vs simulador' })
    await waitFor(() => expect(button).toBeEnabled())
    await user.click(button)
    await screen.findByRole('region', { name: 'VectorBT contra el simulador' })
    expect(compare).toHaveBeenCalledWith(
      'x2',
      'x2-20261022-101500',
      '2',
      undefined,
    )
  })

  it('mientras su práctica no terminó, el botón espera y lo explica', async () => {
    const api = fakeVectorbt(vbtState(), { status: async (id) => statusOf(id) })
    render(
      <StrategyRunView
        strategyId="x2-v2"
        strategyName="X2 · stop_atr=2"
        version={1}
        gate={gateWith()}
        visual={visual()}
        vectorbt={api}
        registry={asVariant()}
        kind="rules"
      />,
    )
    const origin = await screen.findByTestId('vbt-origin')
    expect(origin).toHaveTextContent('Cuando termine su prueba de práctica')
    expect(
      screen.getByRole('button', { name: 'VectorBT vs simulador' }),
    ).toBeDisabled()
  })

  it('una estrategia común no muestra ningún vínculo', async () => {
    mount(fakeVectorbt(vbtState()))
    await explore()
    expect(screen.queryByTestId('vbt-origin')).toBeNull()
  })
})
