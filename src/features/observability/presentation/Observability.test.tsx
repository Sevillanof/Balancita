/* eslint-disable @typescript-eslint/no-explicit-any -- loosely typed JSON fixtures */
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import healthDegraded from '../../../../docs/mission-control/b1/ejemplo-degradado.json'
import healthHealthy from '../../../../docs/mission-control/b1/ejemplo-saludable.json'
import activityBusy from '../../../../docs/mission-control/b2/ejemplo-con-actividad.json'
import activityNoData from '../../../../docs/mission-control/b2/ejemplo-sin-datos.json'
import activityQuiet from '../../../../docs/mission-control/b2/ejemplo-sin-actividad.json'
import HealthIndicator from './HealthIndicator.tsx'
import { useHealth } from './useHealth.ts'
import ObserverPanel from './ObserverPanel.tsx'
import type { LatestDecision } from './latest-decision.ts'

/**
 * The fixtures are the documented examples the backend tests generate from its
 * own code, so these tests break if the screen and the contract drift apart.
 */
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value))

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function serve(routes: {
  health?: () => Response
  activity?: (url: URL) => Response
}) {
  const calls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      calls.push(input)
      const url = new URL(input, 'http://localhost')
      if (url.pathname.endsWith('/observability/health'))
        return routes.health?.() ?? json(healthHealthy)
      if (url.pathname.endsWith('/observability/activity'))
        return routes.activity?.(url) ?? json(activityQuiet)
      throw new Error(`unexpected ${input}`)
    }),
  )
  return calls
}

afterEach(() => vi.unstubAllGlobals())

/** The indicator as the Terminal mounts it: fed by the shared B1 read. */
function Indicator() {
  const health = useHealth()
  return <HealthIndicator data={health.data} error={health.error} />
}

/** The observer panel with its own B1 read, as the Terminal gives it. */
function Observer({
  product = 'PF_XBTUSD',
  latest = null,
  children,
}: {
  product?: string | null
  latest?: LatestDecision | null
  children?: React.ReactNode
}) {
  const health = useHealth()
  return (
    <ObserverPanel
      product={product}
      health={health}
      latest={latest}
      nowMs={1_791_000_240_000}
    >
      {children}
    </ObserverPanel>
  )
}

describe('HealthIndicator (header)', () => {
  it('is never «correcta» while a component is unverified', async () => {
    serve({ health: () => json(healthHealthy) })
    render(<Indicator />)
    const button = await screen.findByTestId('health-indicator')
    await waitFor(() => expect(button).toHaveTextContent('1 sin verificar'))
    expect(button).toHaveTextContent('5/6')
    expect(button).not.toHaveTextContent('correcta')
    expect(button).toHaveAttribute('data-tone', 'unknown')
  })

  it('says «sin datos» when the gateway does not answer, never healthy', async () => {
    serve({ health: () => json({}, 503) })
    render(<Indicator />)
    const button = screen.getByTestId('health-indicator')
    await waitFor(() => expect(button).toHaveAttribute('title'))
    expect(button).toHaveTextContent('Salud: sin datos')
    await userEvent.click(button)
    expect(
      await screen.findByText('No se pudo leer la salud'),
    ).toBeInTheDocument()
    expect(screen.queryByText('Correcto')).toBeNull()
  })

  it('opens the inspector with problems first and the technical detail folded', async () => {
    serve({ health: () => json(healthDegraded) })
    render(<Indicator />)
    const button = await screen.findByTestId('health-indicator')
    await waitFor(() => expect(button).toHaveTextContent('5 con problemas'))
    await userEvent.click(button)
    const dialog = await screen.findByRole('dialog', {
      name: 'Salud del sistema',
    })
    const groups = within(dialog)
      .getAllByText(/^(Con problemas|Sin verificar|Correctos) \(/)
      .map((node) => node.textContent)
    expect(groups).toEqual(['Con problemas (5)', 'Sin verificar (1)'])
    // Components keep their fixed number whatever the order shown.
    expect(
      within(screen.getByTestId('health-risk')).getByRole('heading', {
        level: 3,
      }),
    ).toHaveTextContent('6.')
    // Checks, rules and evidence are folded until asked for.
    const details = dialog.querySelectorAll('details')
    expect(details.length).toBe(6)
    for (const detail of details) expect(detail).not.toHaveAttribute('open')
    expect(screen.getByTestId('health-overall')).toHaveTextContent(
      healthDegraded.overall.reason,
    )
  })

  it('shows every limitation the backend lists inside the folded detail', async () => {
    serve({ health: () => json(healthHealthy) })
    render(<Indicator />)
    await userEvent.click(await screen.findByTestId('health-indicator'))
    await screen.findByTestId('health-risk')
    for (const component of healthHealthy.components)
      for (const limitation of component.limitations)
        expect(
          within(screen.getByTestId(`health-${component.id}`)).getAllByText(
            limitation,
          ).length,
        ).toBeGreaterThan(0)
  })

  it('closes with Escape and with the close button', async () => {
    serve({ health: () => json(healthHealthy) })
    render(<Indicator />)
    await userEvent.click(await screen.findByTestId('health-indicator'))
    await screen.findByRole('dialog')
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    await userEvent.click(screen.getByTestId('health-indicator'))
    await userEvent.click(screen.getByRole('button', { name: 'Cerrar' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('keeps the previous read but flags it when a refresh fails', async () => {
    let fail = false
    serve({
      health: () => (fail ? json({}, 500) : json(healthDegraded)),
    })
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      render(<Indicator />)
      const button = await screen.findByTestId('health-indicator')
      await waitFor(() => expect(button).toHaveTextContent('5 con problemas'))
      fail = true
      await vi.advanceTimersByTimeAsync(31_000)
      await waitFor(() => expect(button).toHaveTextContent('lectura anterior'))
      expect(button).toHaveTextContent('5 con problemas')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('ObserverPanel (right column)', () => {
  const quiet = () => json(activityQuiet)

  it('never deduces the last decision from an aggregate', async () => {
    serve({ activity: quiet })
    render(<Observer />)
    const now = await screen.findByTestId('observer-now')
    expect(screen.getByTestId('last-decision')).toHaveTextContent(
      'Última decisión: No disponible',
    )
    // No «Esperando» just because there are no directional proposals.
    expect(screen.queryByText(/Esperando/)).toBeNull()
    expect(now).toHaveTextContent('Fuente de decisiones (B1)')
    expect(screen.queryByText('Error')).toBeNull()
  })

  it('shows the last decision only from a real stream analysis, with its source', async () => {
    serve({ activity: quiet })
    render(
      <Observer
        latest={{
          action: 'WAIT',
          reasonCode: 'no_directional_proposal',
          regime: 'range',
          decisionTimeMs: 1_791_000_120_000,
          bucketStartMs: 1_791_000_060_000,
        }}
      />,
    )
    await screen.findByTestId('observer-now')
    expect(screen.getByTestId('now-action')).toHaveTextContent('Espera')
    const detail = screen.getByTestId('now-detail')
    expect(detail).toHaveTextContent('no_directional_proposal')
    expect(detail).toHaveTextContent('Régimen range')
    expect(detail).toHaveTextContent('hace 2 min')
    expect(screen.getByTestId('now-source')).toHaveTextContent(
      'análisis del motor recibido por el stream',
    )
    // Waiting is not an error and not a proposal.
    expect(screen.getByTestId('observer-now')).not.toHaveTextContent(
      'propuesta, no operación',
    )
  })

  it('labels a LONG or SHORT as a proposal, never as an operation', async () => {
    serve({ activity: quiet })
    render(
      <Observer
        latest={{
          action: 'SHORT',
          reasonCode: 'c26_short_reversion',
          regime: null,
          decisionTimeMs: 1_791_000_120_000,
          bucketStartMs: null,
        }}
      />,
    )
    await screen.findByTestId('observer-now')
    expect(screen.getByTestId('last-decision')).toHaveTextContent(
      'SHORT propuesta, no operación',
    )
    expect(screen.getByTestId('now-detail')).toHaveTextContent(
      'Régimen No disponible',
    )
  })

  it('shows what B1 says about the decisions source, apart from the trading figures', async () => {
    serve({ health: () => json(healthDegraded), activity: quiet })
    render(<Observer />)
    const now = await screen.findByTestId('observer-now')
    await waitFor(() => expect(now).toHaveTextContent('Error'))
    expect(screen.getByTestId('last-decision')).toHaveTextContent(
      'No disponible',
    )
  })

  it('separates evaluations, proposals and stored operations', async () => {
    serve({ activity: quiet })
    render(<Observer />)
    await screen.findByTestId('activity-discards')
    expect(screen.getByText('Evaluaciones')).toBeInTheDocument()
    expect(screen.getByText('Propuestas direccionales')).toBeInTheDocument()
    expect(screen.getByTestId('stored-total')).toHaveTextContent('0')
    expect(
      screen.getByText(/Una propuesta no es una operación/),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/Posiciones actuales: No disponible/),
    ).toBeInTheDocument()
  })

  it('reads this product and the 3 h window, and asks 24 h on demand', async () => {
    const calls = serve({ activity: quiet })
    render(<Observer />)
    await screen.findByTestId('activity-discards')
    expect(calls.filter((c) => c.includes('/activity')).at(-1)).toContain(
      'window=3h',
    )
    expect(calls.filter((c) => c.includes('/activity')).at(-1)).toContain(
      'product=PF_XBTUSD',
    )
    const q = clone(activityQuiet) as any
    q.window = '24h'
    serve({ activity: () => json(q) })
    await userEvent.click(screen.getByRole('button', { name: '24 h' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '24 h' })).toHaveAttribute(
        'aria-pressed',
        'true',
      ),
    )
  })

  it('lists the reasons as the engine wrote them, counts included', async () => {
    serve({ activity: quiet })
    render(<Observer />)
    const list = await screen.findByTestId('activity-discards')
    const first = activityQuiet.discards.by_reason[0] as any
    expect(within(list).getByText(first.reason_code)).toBeInTheDocument()
    expect(list).toHaveTextContent(`${first.count}×`)
  })

  it('gives each experiment its own cycle, never one timestamp for all', async () => {
    const busy = clone(activityBusy) as any
    busy.product = 'PF_XBTUSD'
    serve({ activity: () => json(busy) })
    render(<Observer />)
    const exps = await screen.findByTestId('activity-experiments')
    expect(screen.getByTestId('stored-total')).toHaveTextContent('1')
    for (const id of ['C29', 'C30']) expect(exps).toHaveTextContent(id)
    expect(within(exps).getAllByText(/Último ciclo propio/)).toHaveLength(2)
    expect(screen.queryByText(/Último ciclo del forward/)).toBeNull()
    expect(screen.queryByText(/posición abierta/i)).toBeNull()
  })

  it('shows «No disponible» with the reason for a section the backend could not read', async () => {
    const down = clone(activityNoData) as any
    down.window = '3h'
    down.product = 'PF_XBTUSD'
    serve({ activity: () => json(down) })
    render(<Observer />)
    expect(await screen.findByTestId('stored-total')).toHaveTextContent(
      'Sin datos',
    )
    expect(screen.getAllByText('No disponible').length).toBeGreaterThan(0)
  })

  it('shows an error and no earlier value as current when the read fails', async () => {
    serve({ activity: () => json({}, 503) })
    render(<Observer />)
    expect(
      await screen.findByText('No se pudo leer la actividad'),
    ).toBeInTheDocument()
    expect(screen.queryByTestId('activity-discards')).toBeNull()
  })

  it('keeps the terminal decisions list inside it as the history', async () => {
    serve({ activity: quiet })
    render(
      <Observer>
        <p>lista de decisiones del terminal</p>
      </Observer>,
    )
    const history = await screen.findByRole('region', { name: 'Historial' })
    expect(history).toHaveTextContent('lista de decisiones del terminal')
  })
})
