/* eslint-disable @typescript-eslint/no-explicit-any -- loosely typed JSON fixtures */
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import healthDegraded from '../../../../docs/mission-control/b1/ejemplo-degradado.json'
import healthHealthy from '../../../../docs/mission-control/b1/ejemplo-saludable.json'
import healthNoData from '../../../../docs/mission-control/b1/ejemplo-sin-datos.json'
import activityBusy from '../../../../docs/mission-control/b2/ejemplo-con-actividad.json'
import activityNoData from '../../../../docs/mission-control/b2/ejemplo-sin-datos.json'
import activityQuiet from '../../../../docs/mission-control/b2/ejemplo-sin-actividad.json'
import {
  decodeActivity,
  decodeHealth,
} from '../infrastructure/observability-api.ts'
import ObservabilityPage from './ObservabilityPage.tsx'

/**
 * The fixtures are the documented examples the backend tests generate from its
 * own code, so these tests break if the screen and the contract drift apart.
 */
type Json = Record<string, any>
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value))

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

type Routes = {
  health?: () => Response | Promise<Response>
  activity?: (url: URL) => Response | Promise<Response>
}

function serve(routes: Routes) {
  const calls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      calls.push(input)
      const url = new URL(input, 'http://localhost')
      if (url.pathname.endsWith('/observability/health'))
        return routes.health?.() ?? json(healthHealthy)
      if (url.pathname.endsWith('/observability/activity'))
        return routes.activity?.(url) ?? json(activityBusy)
      throw new Error(`unexpected ${input}`)
    }),
  )
  return calls
}

afterEach(() => vi.unstubAllGlobals())

/** The component's own status pill (the first one, in its header). */
const headPill = (component: HTMLElement) =>
  component.querySelector('.obs-component__head .mc-pill')?.textContent

describe('ObservabilityPage: health', () => {
  it('shows the six components and never a green global state while one is unverified', async () => {
    serve({ health: () => json(healthHealthy) })
    render(<ObservabilityPage />)
    const list = await screen.findByRole('list', {
      name: 'Componentes de salud',
    })
    const labels = within(list)
      .getAllByRole('heading', { level: 3 })
      .map((h) => h.textContent)
    expect(labels).toEqual([
      'Datos',
      'Procesamiento',
      'Estrategias',
      'Decisiones',
      'Ejecución paper',
      'Riesgo',
    ])
    // Riesgo has no source: «Sin datos», not healthy.
    const risk = screen.getByTestId('health-risk')
    expect(within(risk).getAllByText('Sin datos').length).toBeGreaterThan(0)
    expect(headPill(risk)).toBe('Sin datos')
    expect(within(risk).queryByText('Correcto')).toBeNull()
    const panel = screen.getByRole('region', { name: 'Salud del sistema' })
    expect(
      within(panel).queryAllByText('Correcto', { selector: '.mc-pill' }).length,
    ).toBeGreaterThan(0)
    // The overall pill is the one in the panel header: «Sin datos».
    const overall = screen.getByTestId('health-overall').textContent
    expect(overall).toBe(healthHealthy.overall.reason)
    expect(
      within(panel.querySelector('.mc-panel__header') as HTMLElement).getByText(
        'Sin datos',
      ),
    ).toBeInTheDocument()
    expect(screen.getByText(/nunca es correcto/)).toBeInTheDocument()
  })

  it('names the components with problems and shows what the backend said about each', async () => {
    serve({ health: () => json(healthDegraded) })
    render(<ObservabilityPage />)
    expect(await screen.findByText('Con problemas:')).toBeInTheDocument()
    const strategies = screen.getByTestId('health-strategies')
    expect(headPill(strategies)).toBe('Advertencia')
    expect(strategies).toHaveTextContent(
      (healthDegraded.components[2] as Json).summary,
    )
    expect(
      within(screen.getByTestId('health-data')).getAllByText('Error', {
        selector: '.mc-pill',
      })[0],
    ).toBeInTheDocument()
  })

  it('keeps every limitation the backend lists', async () => {
    serve({ health: () => json(healthHealthy) })
    render(<ObservabilityPage />)
    await screen.findByTestId('health-risk')
    for (const component of healthHealthy.components)
      for (const limitation of component.limitations)
        expect(
          within(screen.getByTestId(`health-${component.id}`)).getAllByText(
            limitation,
          ).length,
        ).toBeGreaterThan(0)
  })

  it('shows «Sin datos» for everything when no source could be read', async () => {
    serve({ health: () => json(healthNoData) })
    render(<ObservabilityPage />)
    const list = await screen.findByRole('list', {
      name: 'Componentes de salud',
    })
    for (const item of within(list).getAllByRole('listitem', {
      name: '',
    })) {
      if (!item.hasAttribute('data-status')) continue
      expect(item).toHaveAttribute('data-status', 'unknown')
    }
    expect(screen.queryByText('Correcto', { selector: '.mc-pill' })).toBeNull()
  })

  it('says the read failed instead of showing a healthy state', async () => {
    serve({ health: () => json({ error: 'x' }, 503) })
    render(<ObservabilityPage />)
    const alert = await screen.findByText(
      'No se pudo leer la salud del sistema',
    )
    expect(alert).toBeInTheDocument()
    expect(screen.queryByText('Correcto', { selector: '.mc-pill' })).toBeNull()
    expect(screen.getByText(/HTTP 503/)).toBeInTheDocument()
  })

  it('rejects a response that is not the documented contract', async () => {
    serve({ health: () => json({ schema: 'otra-cosa', components: [] }) })
    render(<ObservabilityPage />)
    expect(
      await screen.findByText(/respuesta inesperada: schema/),
    ).toBeInTheDocument()
  })
})

describe('ObservabilityPage: activity', () => {
  it('shows evaluations, signals, discards and the last stored operation per experiment', async () => {
    serve({})
    render(<ObservabilityPage />)
    const products = await screen.findByTestId('activity-products')
    expect(within(products).getByText('XBT')).toBeInTheDocument()
    expect(within(products).getAllByRole('row').length).toBe(
      1 + activityBusy.evaluations.by_product.length,
    )
    const reasons = screen.getByTestId('activity-discards')
    for (const r of activityBusy.discards.by_reason)
      expect(within(reasons).getByText(r.reason_code)).toBeInTheDocument()
    const experiments = screen.getByTestId('activity-experiments')
    expect(within(experiments).getByText('C29')).toBeInTheDocument()
    expect(within(experiments).getByText(/salida: target/)).toBeInTheDocument()
    expect(
      screen.getByText('Veredictos (evaluaciones)').nextSibling,
    ).toHaveTextContent(String(activityBusy.evaluations.total))
  })

  it('does not present proposals as executed or stored records as current positions', async () => {
    serve({})
    render(<ObservabilityPage />)
    const experiments = await screen.findByTestId('activity-experiments')
    // Column names say what the figures are.
    expect(
      within(experiments).getByText('Operaciones almacenadas en la ventana'),
    ).toBeInTheDocument()
    expect(
      within(experiments).getByText('Registros abiertos (no verificados)'),
    ).toBeInTheDocument()
    expect(
      within(experiments).getByText('Último ciclo del forward'),
    ).toBeInTheDocument()
    const page = document.body.textContent ?? ''
    expect(page).not.toMatch(/Posiciones? (abiertas?|actuales?)/)
    expect(page).not.toMatch(/Operaciones ejecutadas/)
    expect(screen.getByText(/Propuestas, no órdenes/)).toBeInTheDocument()
    expect(
      screen.getByText(/una señal o propuesta no es una operación/),
    ).toBeInTheDocument()
  })

  it('shows a stopped forward with its old last cycle next to the open records', async () => {
    const stopped = clone(activityBusy) as Json
    const day = 24 * 3_600_000
    stopped.operations.experiments[0].last_cycle_ms =
      stopped.generated_at_ms - 3 * day
    stopped.operations.experiments[0].open_records = 2
    serve({ activity: () => json(stopped) })
    render(<ObservabilityPage />)
    const row = (await screen.findByText('C29')).closest('tr') as HTMLElement
    expect(within(row).getByText(/hace 3 d/)).toBeInTheDocument()
    expect(within(row).getByText('2')).toBeInTheDocument()
    expect(
      screen.getAllByText(/no posiciones actuales verificadas/).length,
    ).toBeGreaterThan(0)
  })

  it('keeps the limitations visible: quiet is not an error and missing is not health', async () => {
    // The example is the unfiltered read of the selection the page makes.
    serve({ activity: () => json({ ...clone(activityQuiet), product: null }) })
    render(<ObservabilityPage />)
    const limitations = await screen.findByTestId('activity-limitations')
    expect(limitations).toHaveTextContent(/no es un error/)
    expect(limitations).toHaveTextContent(/cadencia nominal/)
    expect(limitations).toHaveTextContent(/no un diagnóstico/)
    for (const text of activityQuiet.discards.not_recorded)
      expect(limitations).toHaveTextContent(`No se registra: ${text}.`)
    expect(screen.getByText('Ninguna en la ventana')).toBeInTheDocument()
  })

  it('shows unavailable sections with the reason and without figures', async () => {
    serve({
      activity: () => json({ ...clone(activityNoData), window: '3h' }),
    })
    render(<ObservabilityPage />)
    const panel = await screen.findByRole('region', {
      name: 'Actividad verificable',
    })
    await waitFor(() =>
      expect(
        within(panel).getAllByText('No disponible').length,
      ).toBeGreaterThan(0),
    )
    expect(within(panel).getAllByText(/file_not_found/).length).toBeGreaterThan(
      0,
    )
    expect(within(panel).queryByTestId('activity-products')).toBeNull()
    expect(within(panel).queryByTestId('activity-experiments')).toBeNull()
    // Totals are «Sin datos», never a made-up zero.
    expect(
      within(panel).getAllByText('Sin datos').length,
    ).toBeGreaterThanOrEqual(3)
  })

  it('tells how many discards the cut-off reasons hold when the list was truncated', async () => {
    const cut = clone(activityBusy) as Json
    cut.discards.truncated = true
    cut.discards.distinct_reasons = 70
    cut.discards.omitted_count = 12
    serve({ activity: () => json(cut) })
    render(<ObservabilityPage />)
    const note = await screen.findByTestId('discards-truncated')
    expect(note).toHaveTextContent('de 70')
    expect(note).toHaveTextContent('suman 12')
    expect(note).toHaveTextContent(`(${cut.discards.total})`)
  })

  it('asks the gateway for the chosen window and product', async () => {
    const calls = serve({})
    const user = userEvent.setup()
    render(<ObservabilityPage />)
    await screen.findByTestId('activity-products')
    await user.click(screen.getByRole('button', { name: 'Últimas 24 h' }))
    await waitFor(() =>
      expect(calls.some((c) => c.includes('window=24h'))).toBe(true),
    )
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Últimas 24 h' }),
      ).toHaveAttribute('aria-pressed', 'true'),
    )
    const select = await screen.findByRole('combobox')
    await user.selectOptions(select, 'PF_ETHUSD')
    await waitFor(() =>
      expect(
        calls.some(
          (c) => c.includes('window=24h') && c.includes('product=PF_ETHUSD'),
        ),
      ).toBe(true),
    )
  })

  it('does not show a report of another window as the answer to the new selection', async () => {
    let release: (() => void) | undefined
    serve({
      activity: (url) => {
        if (url.searchParams.get('window') === '24h')
          return new Promise<Response>((resolve) => {
            release = () =>
              resolve(json({ ...clone(activityBusy), window: '24h' }))
          })
        return json(activityBusy)
      },
    })
    const user = userEvent.setup()
    render(<ObservabilityPage />)
    await screen.findByTestId('activity-products')
    await user.click(screen.getByRole('button', { name: 'Últimas 24 h' }))
    await waitFor(() => expect(release).toBeDefined())
    expect(screen.queryByTestId('activity-products')).toBeNull()
    release?.()
    expect(await screen.findByTestId('activity-products')).toBeInTheDocument()
  })

  it('reports a failed read without any previous number as current', async () => {
    serve({ activity: () => json({}, 500) })
    render(<ObservabilityPage />)
    expect(
      await screen.findByText('No se pudo leer la actividad'),
    ).toBeInTheDocument()
    expect(screen.queryByTestId('activity-products')).toBeNull()
  })
})

describe('decoders', () => {
  it('decode the documented examples', () => {
    for (const example of [healthHealthy, healthDegraded, healthNoData])
      expect(decodeHealth(example).components).toHaveLength(6)
    for (const example of [activityBusy, activityQuiet, activityNoData])
      expect(decodeActivity(example).window).toMatch(/3h|24h/)
  })

  it('refuse a status the contract does not define', () => {
    const bad = clone(healthHealthy) as Json
    bad.components[0].status = 'great'
    expect(() => decodeHealth(bad)).toThrow(/component.status/)
  })

  it('refuse an activity section in an unknown state', () => {
    const bad = clone(activityBusy) as Json
    bad.signals.state = 'maybe'
    expect(() => decodeActivity(bad)).toThrow(/signals.state/)
  })
})
