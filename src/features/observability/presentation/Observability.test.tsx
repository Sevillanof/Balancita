/* eslint-disable @typescript-eslint/no-explicit-any -- loosely typed JSON fixtures */
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import healthDegraded from '../../../../docs/mission-control/b1/ejemplo-degradado.json'
import healthHealthy from '../../../../docs/mission-control/b1/ejemplo-saludable.json'
import activityBusy from '../../../../docs/mission-control/b2/ejemplo-con-actividad.json'
import activityNoData from '../../../../docs/mission-control/b2/ejemplo-sin-datos.json'
import activityQuiet from '../../../../docs/mission-control/b2/ejemplo-sin-actividad.json'
import HealthIndicator from './HealthIndicator.tsx'
import { decodeHealth } from '../infrastructure/observability-api.ts'
import { reportTiming } from './health-view.ts'
import { useHealth } from './useHealth.ts'
import ObserverPanel from './ObserverPanel.tsx'
import type { GatewayClock, LatestDecision } from './latest-decision.ts'

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

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

/** The browser's clock in the panel tests (fake timers start here). */
const NOW = 1_791_000_240_000

/**
 * B1 as the gateway would report it when its newest verdict of `product` is
 * `bucket`, generated 10 s before NOW on the gateway's clock.
 */
function healthWithVerdict(
  bucket: number,
  status = 'ok',
  product = 'PF_XBTUSD',
  generatedAtMs = NOW - 10_000,
) {
  const body: any = clone(healthHealthy)
  body.generated_at_ms = generatedAtMs
  const item = body.components
    .find((c: any) => c.id === 'decisions')
    .items.find((i: any) => i.product_id === product)
  item.bucket_start_ms = bucket
  item.status = status
  return body
}

/** The indicator as the Terminal mounts it: fed by the shared B1 read. */
function Indicator() {
  const health = useHealth()
  return <HealthIndicator {...health} />
}

type ObserverProps = {
  product?: string | null
  latest?: LatestDecision | null
  connected?: boolean
  connectedAtMs?: number | null
  clock?: GatewayClock | null
  localNowMs?: number
  children?: React.ReactNode
}

/**
 * The observer panel with its own B1 read, as the Terminal gives it. By
 * default everything holds: connected, a gateway clock that agrees with the
 * browser's, connection opened a minute ago.
 */
function Observer({
  product = 'PF_XBTUSD',
  latest = null,
  connected = true,
  connectedAtMs = NOW - 60_000,
  clock = { publishedAtMs: NOW, receivedAtMs: NOW },
  localNowMs = NOW,
  children,
}: ObserverProps) {
  const health = useHealth()
  return (
    <ObserverPanel
      product={product}
      health={health}
      latest={latest}
      connected={connected}
      connectedAtMs={connectedAtMs}
      clock={clock}
      localNowMs={localNowMs}
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

  it('treats a response that is not the documented contract as «sin datos», never healthy', async () => {
    serve({ health: () => json({ schema: 'otra-cosa', components: [] }) })
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
    for (const [i, component] of healthDegraded.components.entries()) {
      const row = screen.getByTestId(`health-${component.id}`)
      expect(row).toHaveAttribute('data-status', component.status)
      expect(within(row).getByRole('heading', { level: 3 })).toHaveTextContent(
        `${i + 1}. ${component.label}`,
      )
      expect(row).toHaveTextContent(component.summary)
      for (const check of component.checks) {
        expect(row).toHaveTextContent(check.rule)
        if (check.detail) expect(row).toHaveTextContent(check.detail)
      }
    }
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
    expect(
      screen
        .getAllByText(/^(Sin verificar|Correctos) \(/)
        .map((node) => node.textContent),
    ).toEqual(['Sin verificar (1)', 'Correctos (5)'])
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
      health: () =>
        fail
          ? json({}, 500)
          : json({
              ...healthDegraded,
              generated_at_ms: Date.now() - 10_000,
            }),
    })
    vi.useFakeTimers({ now: NOW, shouldAdvanceTime: true })
    try {
      render(<Indicator />)
      const button = await screen.findByTestId('health-indicator')
      await waitFor(() => expect(button).toHaveTextContent('5 con problemas'))
      fail = true
      await vi.advanceTimersByTimeAsync(31_000)
      await waitFor(() => expect(button).toHaveTextContent('lectura anterior'))
      expect(button).toHaveTextContent('5 con problemas')
      fireEvent.click(button)
      expect(screen.getByText(/Generación:/)).toHaveTextContent(
        'hace 41 s · Recepción: hace 31 s',
      )
      fail = false
      await vi.advanceTimersByTimeAsync(30_000)
      await waitFor(() =>
        expect(button).not.toHaveTextContent('lectura anterior'),
      )
      expect(screen.getByText(/Generación:/)).toHaveTextContent(
        'hace 11 s · Recepción: hace 1 s',
      )
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('health presentation freshness', () => {
  beforeEach(() => vi.useFakeTimers({ now: NOW }))

  it.each([
    ['inclusive generation limit', NOW - 90_000, NOW, NOW, 'fresh'],
    ['old cached generation, new receipt', NOW - 90_001, NOW, NOW, 'stale'],
    ['inclusive receipt limit', NOW - 85_000, NOW - 90_000, NOW, 'fresh'],
    ['expired receipt', NOW - 89_000, NOW - 90_001, NOW, 'stale'],
    ['future generation', NOW + 5_001, NOW, NOW, 'unverified'],
    [
      'future generation stays invalid later',
      NOW + 5_001,
      NOW,
      NOW + 10_000,
      'unverified',
    ],
    ['tolerated skew', NOW + 5_000, NOW, NOW, 'fresh'],
    ['backward clock', NOW, NOW, NOW - 5_001, 'unverified'],
    ['tolerated backward clock', NOW, NOW, NOW - 5_000, 'fresh'],
    ['missing receipt', NOW, null, NOW, 'unverified'],
    ['nonfinite receipt', NOW, NaN, NOW, 'unverified'],
    ['nonfinite generation', Infinity, NOW, NOW, 'unverified'],
    ['nonfinite clock', NOW, NOW, NaN, 'unverified'],
  ])('%s', (_name, generated, receipt, now, state) => {
    const timing = reportTiming(now, receipt, generated)
    expect(timing.state).toBe(state)
    if (state === 'unverified') expect(timing.reference).toBeNull()
  })

  it.each([
    [1_060_000, 1_060_000, 61_000],
    [1_070_000, 1_060_000, 71_000],
    [1_070_000, 1_070_000, 71_000],
  ])(
    'keeps generation-based evidence age at now=%i, receipt=%i',
    (now, receipt, age) => {
      const timing = reportTiming(now, receipt, 1_000_000)
      expect(timing.state).toBe('fresh')
      expect(timing.reference! - 999_000).toBe(age)
    },
  )

  it('cannot rewind evidence when a cached generation is received again', () => {
    const data = decodeHealth(healthHealthy)
    data.generatedAtMs = NOW - 60_000
    data.components[0].evidence[0].lastUpdatedMs = NOW - 61_000
    const { rerender } = render(
      <HealthIndicator
        data={data}
        error={null}
        receivedAt={data.generatedAtMs}
      />,
    )
    fireEvent.click(screen.getByTestId('health-indicator'))
    const evidence = screen.getByTestId('health-data').querySelector('dd')
    expect(evidence).toHaveTextContent('hace 1 min')
    act(() => vi.advanceTimersByTime(10_000))
    expect(evidence).toHaveTextContent('hace 1 min')
    rerender(
      <HealthIndicator
        data={{ ...data }}
        error={null}
        receivedAt={Date.now()}
      />,
    )
    expect(screen.getByText(/Generación:/)).toHaveTextContent(
      'hace 1 min · Recepción: hace 0 s',
    )
    expect(evidence).toHaveTextContent('hace 1 min')
    expect(evidence).not.toHaveTextContent('hace 1 s')
  })

  it('advances all ages without requests, even closed, and cleans up the clock', () => {
    const data = decodeHealth(healthHealthy)
    data.generatedAtMs = NOW - 10_000
    // Base age is 12 s plus 10 s since generation: 22 s on receipt.
    data.components[0].evidence[0].lastUpdatedMs = NOW - 22_000
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const intervals = vi.spyOn(globalThis, 'setInterval')
    const clearClock = vi.spyOn(globalThis, 'clearInterval')
    const { unmount } = render(
      <HealthIndicator data={data} error={null} receivedAt={NOW} />,
    )
    const button = screen.getByTestId('health-indicator')
    fireEvent.click(button)
    expect(screen.getByText(/Generación:/)).toHaveTextContent(
      'hace 10 s · Recepción: hace 0 s',
    )
    expect(screen.getByTestId('health-data')).toHaveTextContent('hace 22 s')
    act(() => vi.advanceTimersByTime(2_000))
    expect(screen.getByText(/Generación:/)).toHaveTextContent(
      'hace 12 s · Recepción: hace 2 s',
    )
    expect(screen.getByTestId('health-data')).toHaveTextContent('hace 24 s')
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar' }))
    act(() => vi.advanceTimersByTime(79_000))
    expect(button).toHaveTextContent('informe obsoleto')
    fireEvent.click(button)
    expect(screen.getByText(/Generación:/)).toHaveTextContent(
      'hace 1 min · Recepción: hace 1 min',
    )
    expect(screen.getByTestId('health-data')).toHaveTextContent('hace 1 min')
    expect(screen.getByRole('dialog')).toHaveTextContent('Lectura anterior')
    expect(fetch).not.toHaveBeenCalled()
    const clock = intervals.mock.results[0].value
    expect(intervals.mock.calls[0][1]).toBe(1_000)
    unmount()
    expect(clearClock).toHaveBeenCalledWith(clock)
    intervals.mockRestore()
    clearClock.mockRestore()
  })

  it('qualifies an old ok, invalid clocks and missing receipts, then clears on fresh recovery', () => {
    const data = decodeHealth(healthHealthy)
    data.generatedAtMs = NOW
    data.overall = {
      status: 'ok',
      reason: 'fixture verificada',
      failing: [],
      unverified: [],
    }
    const view = (receivedAt?: number, error: string | null = null) => (
      <HealthIndicator data={data} receivedAt={receivedAt} error={error} />
    )
    const { rerender } = render(view())
    const button = screen.getByTestId('health-indicator')
    expect(button).toHaveTextContent('frescura/reloj sin verificar')
    expect(button).toHaveAttribute('data-tone', 'unknown')
    rerender(view(NOW, 'falló'))
    expect(button).toHaveTextContent('lectura anterior')
    expect(button).not.toHaveAttribute('data-tone', 'ok')
    rerender(view(NOW))
    expect(button).toHaveTextContent('Salud: correcta')
    expect(button).not.toHaveTextContent('lectura anterior')
    expect(button).toHaveAttribute('data-tone', 'ok')
    act(() => vi.advanceTimersByTime(91_000))
    rerender(view(Date.now()))
    expect(button).toHaveTextContent('informe obsoleto')
    expect(button).toHaveAttribute('data-tone', 'unknown')
    data.generatedAtMs = Date.now()
    rerender(view(Date.now()))
    expect(button).not.toHaveTextContent('lectura anterior')
    data.generatedAtMs = Date.now() + 6_000
    rerender(view(Date.now()))
    fireEvent.click(button)
    expect(screen.getByText(/Generación:/)).toHaveTextContent('en el futuro')
    expect(screen.getByRole('dialog')).toHaveTextContent(
      'frescura/reloj sin verificar',
    )
  })

  it.each([
    'expectativas ilegibles: no se pudo leer el registro',
    'Ninguna estrategia debe estar actualizándose',
  ])('keeps the supplied unknown reason: %s', (reason) => {
    const data = decodeHealth(healthHealthy)
    data.generatedAtMs = NOW
    data.components[2].status = 'unknown'
    data.components[2].summary = reason
    render(<HealthIndicator data={data} error={null} receivedAt={NOW} />)
    fireEvent.click(screen.getByTestId('health-indicator'))
    expect(screen.getByTestId('health-strategies')).toHaveTextContent(reason)
    expect(screen.getByTestId('health-strategies')).toHaveAttribute(
      'data-status',
      'unknown',
    )
  })
})

describe('ObserverPanel (right column)', () => {
  const quiet = () => json(activityQuiet)
  // The panel compares every evidence with the browser's clock: pin it.
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, shouldAdvanceTime: true })
  })

  it('never deduces the last decision from an aggregate', async () => {
    serve({ activity: quiet })
    render(<Observer />)
    const now = await screen.findByTestId('observer-now')
    expect(screen.getByTestId('last-decision')).toHaveTextContent(
      'Última decisión: No disponible',
    )
    // No «Esperando» just because there are no directional proposals.
    expect(screen.queryByText(/Esperando/)).toBeNull()
    expect(now).toHaveTextContent('para este producto')
    expect(screen.queryByText('Error')).toBeNull()
  })

  it('shows the last decision only from a real stream analysis, with its source', async () => {
    serve({
      health: () => json(healthWithVerdict(1_791_000_060_000)),
      activity: quiet,
    })
    render(
      <Observer
        latest={{
          action: 'WAIT',
          reasonCode: 'no_directional_proposal',
          regime: 'range',
          decisionTimeMs: 1_791_000_120_000,
          bucketStartMs: 1_791_000_060_000,
          proposals: { total: 2, directional: 0 },
        }}
      />,
    )
    expect(await screen.findByTestId('now-action')).toHaveTextContent('Espera')
    const detail = screen.getByTestId('now-detail')
    expect(detail).toHaveTextContent('no_directional_proposal')
    expect(detail).toHaveTextContent('Régimen range')
    expect(detail).toHaveTextContent('hace 2 min')
    expect(screen.getByTestId('now-source')).toHaveTextContent(
      'Espera: el selector no abrió operación',
    )
    // The verdict lists its proposals: only then may it say none was LONG/SHORT.
    expect(screen.getByTestId('now-source')).toHaveTextContent(
      'Ninguna de las 2 propuestas registradas en el veredicto fue LONG/SHORT',
    )
    expect(screen.getByTestId('now-source')).toHaveTextContent(
      'flujo en vivo del gateway; no describe el estado del forward',
    )
    expect(detail).toHaveTextContent('(hora del servidor)')
    expect(detail).toHaveAttribute('data-standing', 'current')
    expect(screen.queryByTestId('now-unconfirmed')).toBeNull()
    // Waiting is not an error and not a proposal.
    expect(screen.getByTestId('observer-now')).not.toHaveTextContent(
      'propuesta, no operación',
    )
  })

  it('shows an old analysis as history, not as the current decision', async () => {
    serve({ activity: quiet })
    render(
      <Observer
        latest={{
          action: 'LONG',
          reasonCode: 'c25_long_pullback',
          regime: 'trend',
          decisionTimeMs: 1_791_000_240_000 - 3_600_000,
          bucketStartMs: null,
          proposals: null,
        }}
      />,
    )
    await screen.findByTestId('observer-now')
    expect(screen.getByTestId('last-decision')).toHaveTextContent(
      'No disponible',
    )
    expect(screen.queryByTestId('now-action')).toBeNull()
    expect(screen.getByTestId('now-historic')).toHaveTextContent(
      'histórica, no es el estado actual',
    )
    expect(screen.getByTestId('now-historic')).toHaveTextContent('hace 1 h')
  })

  it('does not show a decision dated in the future of this clock', async () => {
    serve({ activity: quiet })
    render(
      <Observer
        latest={{
          action: 'LONG',
          reasonCode: 'x',
          regime: null,
          decisionTimeMs: 1_791_000_240_000 + 600_000,
          bucketStartMs: null,
          proposals: null,
        }}
      />,
    )
    await screen.findByTestId('observer-now')
    expect(screen.getByTestId('last-decision')).toHaveTextContent(
      'No disponible',
    )
    expect(screen.queryByTestId('now-historic')).toBeNull()
  })

  it('does not claim any proposal fact for a WAIT without a proposals list', async () => {
    serve({
      health: () => json(healthWithVerdict(1_791_000_060_000)),
      activity: quiet,
    })
    render(
      <Observer
        latest={{
          action: 'WAIT',
          reasonCode: 'no_setup',
          regime: null,
          decisionTimeMs: 1_791_000_120_000,
          bucketStartMs: 1_791_000_060_000,
          proposals: null,
        }}
      />,
    )
    await screen.findByTestId('now-action')
    const source = screen.getByTestId('now-source')
    expect(source).toHaveTextContent('no trae el detalle de las propuestas')
    expect(source).not.toHaveTextContent('Ninguna de las')
  })

  it('young but not confirmed by B1 is shown as unconfirmed, never as current', async () => {
    // B1 reads an older bucket: the stream and the source disagree.
    serve({
      health: () => json(healthWithVerdict(1_790_999_940_000)),
      activity: quiet,
    })
    render(
      <Observer
        latest={{
          action: 'LONG',
          reasonCode: 'c25_long_pullback',
          regime: 'trend',
          decisionTimeMs: 1_791_000_120_000,
          bucketStartMs: 1_791_000_060_000,
          proposals: null,
        }}
      />,
    )
    await screen.findByTestId('observer-now')
    await waitFor(() =>
      expect(screen.getByTestId('now-unconfirmed')).toHaveAttribute(
        'data-standing',
        'unconfirmed',
      ),
    )
    expect(screen.getByTestId('last-decision')).toHaveTextContent(
      'Sin confirmar',
    )
    expect(screen.queryByTestId('now-action')).toBeNull()
    expect(screen.getByTestId('now-unconfirmed')).toHaveTextContent(
      'B1 no confirma',
    )
  })

  it('does not confirm a young decision when B1 says the source is not ok', async () => {
    serve({
      health: () => json(healthWithVerdict(1_791_000_060_000, 'error')),
      activity: quiet,
    })
    render(
      <Observer
        latest={{
          action: 'WAIT',
          reasonCode: 'x',
          regime: null,
          decisionTimeMs: 1_791_000_120_000,
          bucketStartMs: 1_791_000_060_000,
          proposals: null,
        }}
      />,
    )
    await screen.findByTestId('observer-now')
    await waitFor(() =>
      expect(screen.getByTestId('now-unconfirmed')).toHaveAttribute(
        'data-standing',
        'unconfirmed',
      ),
    )
    expect(screen.getByTestId('last-decision')).toHaveTextContent(
      'Sin confirmar',
    )
  })

  it('labels a LONG or SHORT as a proposal, never as an operation', async () => {
    serve({
      health: () => json(healthWithVerdict(1_791_000_060_000)),
      activity: quiet,
    })
    render(
      <Observer
        latest={{
          action: 'SHORT',
          reasonCode: 'c26_short_reversion',
          regime: null,
          decisionTimeMs: 1_791_000_120_000,
          bucketStartMs: 1_791_000_060_000,
          proposals: null,
        }}
      />,
    )
    await screen.findByTestId('now-action')
    expect(screen.getByTestId('last-decision')).toHaveTextContent(
      'SHORT propuesta, no operación',
    )
    expect(screen.getByTestId('now-detail')).toHaveTextContent(
      'Régimen No disponible',
    )
  })

  it('shows what B1 says about the decisions source, apart from the trading figures', async () => {
    serve({
      health: () => json(healthWithVerdict(1_791_000_120_000, 'error')),
      activity: quiet,
    })
    render(<Observer />)
    const now = await screen.findByTestId('observer-now')
    await waitFor(() => expect(now).toHaveTextContent('Error'))
    expect(screen.getByTestId('last-decision')).toHaveTextContent(
      'No disponible',
    )
  })

  it('shows the stored operations and no engine activity', async () => {
    serve({ activity: quiet })
    render(<Observer />)
    await screen.findByTestId('stored-total')
    expect(screen.queryByText('Evaluaciones')).toBeNull()
    expect(screen.queryByText('Propuestas direccionales')).toBeNull()
    expect(screen.queryByTestId('activity-discards')).toBeNull()
    expect(screen.queryByTestId('last-proposal')).toBeNull()
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
    await screen.findByTestId('stored-total')
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

  it('lists no book of a strategy that is not approved among the stored results', async () => {
    const busy = clone(activityBusy) as any
    busy.product = 'PF_XBTUSD'
    busy.operations.experiments[0].experiment_id = 'c31-momentum-breakout-5m'
    serve({ activity: () => json(busy) })
    render(<Observer />)
    const exps = await screen.findByTestId('activity-experiments')
    expect(exps).not.toHaveTextContent('c31-momentum-breakout-5m')
    expect(exps).not.toHaveTextContent('C30')
    expect(within(exps).queryAllByText(/Último ciclo propio/)).toHaveLength(0)
    expect(screen.getByTestId('stored-total')).toHaveTextContent('0')
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

describe('AHORA: a decision is current only with every evidence at once', () => {
  const quiet = () => json(activityQuiet)
  const BUCKET = 1_791_000_060_000
  const decision: LatestDecision = {
    action: 'LONG',
    reasonCode: 'c25_long_pullback',
    regime: 'trend',
    decisionTimeMs: NOW - 120_000,
    bucketStartMs: BUCKET,
    proposals: null,
  }
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, shouldAdvanceTime: true })
  })
  const label = () => screen.getByTestId('last-decision')
  const settled = async () => {
    await waitFor(() =>
      expect(screen.getByTestId('activity-panel')).toBeInTheDocument(),
    )
    // Let the B1 read land.
    await vi.advanceTimersByTimeAsync(50)
  }

  it('is current when connected, the clock is valid and B1 agrees', async () => {
    serve({ health: () => json(healthWithVerdict(BUCKET)), activity: quiet })
    render(<Observer latest={decision} />)
    expect(await screen.findByTestId('now-action')).toHaveTextContent('LONG')
    expect(screen.queryByTestId('now-unconfirmed')).toBeNull()
    expect(label()).not.toHaveTextContent('Sin confirmar')
  })

  it('goes back to «Sin confirmar» when the WebSocket drops, and re-evaluates from scratch on recovery', async () => {
    let calls = 0
    serve({
      health: () => {
        calls += 1
        return json(healthWithVerdict(BUCKET))
      },
      activity: quiet,
    })
    const { rerender } = render(<Observer latest={decision} />)
    await screen.findByTestId('now-action')

    // Disconnected: the same decision and the same B1 are no longer current.
    rerender(
      <Observer
        latest={decision}
        connected={false}
        connectedAtMs={null}
        clock={null}
      />,
    )
    expect(label()).toHaveTextContent('Sin confirmar')
    expect(screen.queryByTestId('now-action')).toBeNull()
    expect(screen.getByTestId('now-blockers')).toHaveTextContent(
      'sin conexión WebSocket',
    )

    // Reconnected: the clock is valid again but the B1 read predates this
    // connection, so nothing earlier is reused as current.
    await vi.advanceTimersByTimeAsync(5_000)
    const reconnectedAt = Date.now()
    rerender(
      <Observer
        latest={decision}
        connectedAtMs={reconnectedAt}
        clock={{ publishedAtMs: reconnectedAt, receivedAtMs: reconnectedAt }}
        localNowMs={reconnectedAt}
      />,
    )
    expect(label()).toHaveTextContent('Sin confirmar')
    expect(screen.getByTestId('now-blockers')).toHaveTextContent(
      'lectura de B1',
    )

    // A new B1 read, taken on this connection, restores it.
    const before = calls
    await vi.advanceTimersByTimeAsync(31_000)
    await waitFor(() => expect(calls).toBeGreaterThan(before))
    const later = Date.now()
    rerender(
      <Observer
        latest={{ ...decision, decisionTimeMs: later - 30_000 }}
        connectedAtMs={reconnectedAt}
        clock={{ publishedAtMs: later, receivedAtMs: later }}
        localNowMs={later}
      />,
    )
    // Every evidence is now of this connection and agrees: current again.
    expect(await screen.findByTestId('now-action')).toHaveTextContent('LONG')
    expect(label()).not.toHaveTextContent('Sin confirmar')
  })

  it('B1 obsolete: a perfect match read long ago is not evidence of now', async () => {
    serve({ health: () => json(healthWithVerdict(BUCKET)), activity: quiet })
    const { rerender } = render(<Observer latest={decision} />)
    await screen.findByTestId('now-action')
    const later = NOW + 100_000
    rerender(
      <Observer
        latest={{ ...decision, decisionTimeMs: later - 60_000 }}
        clock={{ publishedAtMs: later, receivedAtMs: later }}
        localNowMs={later}
      />,
    )
    expect(label()).toHaveTextContent('Sin confirmar')
    expect(screen.getByTestId('now-blockers')).toHaveTextContent(
      'falta, es obsoleta',
    )
  })

  it('B1 whose refresh fails is obsolete even though its data is still there', async () => {
    let fail = false
    serve({
      health: () => (fail ? json({}, 503) : json(healthWithVerdict(BUCKET))),
      activity: quiet,
    })
    const { rerender } = render(<Observer latest={decision} />)
    await screen.findByTestId('now-action')
    fail = true
    await vi.advanceTimersByTimeAsync(31_000)
    rerender(<Observer latest={decision} />)
    await waitFor(() => expect(label()).toHaveTextContent('Sin confirmar'))
  })

  it('B1 without a read yet is not confirmation', async () => {
    serve({ health: () => json({}, 503), activity: quiet })
    render(<Observer latest={decision} />)
    await settled()
    expect(label()).toHaveTextContent('Sin confirmar')
  })

  it.each([
    ['no gateway clock yet', null],
    [
      'a gateway clock in the future of its arrival',
      { publishedAtMs: NOW + 30_000, receivedAtMs: NOW },
    ],
    [
      'a gateway message older than a few heartbeats',
      { publishedAtMs: NOW - 120_000, receivedAtMs: NOW },
    ],
    [
      'no message from the gateway for a minute',
      { publishedAtMs: NOW - 60_000, receivedAtMs: NOW - 60_000 },
    ],
  ])(
    'an invalid gateway clock (%s) leaves it unconfirmed',
    async (_name, clock) => {
      serve({ health: () => json(healthWithVerdict(BUCKET)), activity: quiet })
      render(<Observer latest={decision} clock={clock} />)
      await settled()
      expect(label()).toHaveTextContent('Sin confirmar')
      expect(screen.getByTestId('now-blockers')).toHaveTextContent(
        'reloj del gateway',
      )
      expect(screen.getByTestId('now-unconfirmed')).toHaveTextContent(
        '(hora local)',
      )
    },
  )

  it('B1 of another product does not confirm this product’s decision', async () => {
    // ETH reads this very bucket; XBT (the product on screen) reads an older one.
    const body = healthWithVerdict(BUCKET - 60_000, 'ok', 'PF_XBTUSD')
    body.components
      .find((c: any) => c.id === 'decisions')
      .items.find((i: any) => i.product_id === 'PF_ETHUSD').bucket_start_ms =
      BUCKET
    serve({ health: () => json(body), activity: quiet })
    render(<Observer latest={decision} />)
    await settled()
    expect(label()).toHaveTextContent('Sin confirmar')
    expect(screen.getByTestId('now-blockers')).toHaveTextContent(
      'B1 no confirma',
    )
  })

  it('B1 with another bucket for the same product does not confirm it', async () => {
    serve({
      health: () => json(healthWithVerdict(BUCKET + 60_000)),
      activity: quiet,
    })
    render(<Observer latest={decision} />)
    await settled()
    expect(label()).toHaveTextContent('Sin confirmar')
  })

  it('shows the source health of the selected product, not the global one', async () => {
    const body = healthWithVerdict(BUCKET)
    body.components
      .find((c: any) => c.id === 'decisions')
      .items.find((i: any) => i.product_id === 'PF_ETHUSD').status = 'error'
    serve({ health: () => json(body), activity: quiet })
    const { rerender } = render(<Observer latest={null} product="PF_XBTUSD" />)
    await waitFor(() =>
      expect(screen.getByTestId('source-health')).toHaveTextContent('Correcto'),
    )
    expect(screen.getByTestId('source-health')).toHaveTextContent('XBT')
    rerender(<Observer latest={null} product="PF_ETHUSD" />)
    expect(screen.getByTestId('source-health')).toHaveTextContent('Error')
    expect(screen.getByTestId('source-health')).toHaveTextContent('ETH')
    // A product B1 has no reading for says so; it never borrows the global one.
    rerender(<Observer latest={null} product="PF_NOEXISTE" />)
    expect(screen.getByTestId('source-health')).toHaveTextContent('Sin datos')
    expect(screen.getByTestId('source-health')).not.toHaveTextContent(
      'Correcto',
    )
  })

  describe('source health is «Correcto» only on a fresh B1 read', () => {
    const health = () => screen.getByTestId('source-health')

    it('shows the product status while the read is fresh', async () => {
      serve({ health: () => json(healthWithVerdict(BUCKET)), activity: quiet })
      render(<Observer latest={null} />)
      await waitFor(() => expect(health()).toHaveTextContent('Correcto'))
      expect(health()).not.toHaveTextContent('Sin confirmar')
    })

    it('an old report is «Sin confirmar», never «Correcto»', async () => {
      serve({ health: () => json(healthWithVerdict(BUCKET)), activity: quiet })
      const { rerender } = render(<Observer latest={null} />)
      await waitFor(() => expect(health()).toHaveTextContent('Correcto'))
      const later = NOW + 100_000
      rerender(
        <Observer
          latest={null}
          clock={{ publishedAtMs: later, receivedAtMs: later }}
          localNowMs={later}
        />,
      )
      expect(health()).toHaveTextContent('Sin confirmar')
      expect(health()).not.toHaveTextContent('Correcto')
    })

    it('a failed refresh is «Sin confirmar» although the data is still there', async () => {
      let fail = false
      serve({
        health: () => (fail ? json({}, 503) : json(healthWithVerdict(BUCKET))),
        activity: quiet,
      })
      const { rerender } = render(<Observer latest={null} />)
      await waitFor(() => expect(health()).toHaveTextContent('Correcto'))
      fail = true
      await vi.advanceTimersByTimeAsync(31_000)
      rerender(<Observer latest={null} />)
      await waitFor(() => expect(health()).toHaveTextContent('Sin confirmar'))
      expect(health()).not.toHaveTextContent('Correcto')
    })

    it('without any read it is «Sin confirmar»', async () => {
      serve({ health: () => json({}, 503), activity: quiet })
      render(<Observer latest={null} />)
      await settled()
      expect(health()).toHaveTextContent('Sin confirmar')
      expect(health()).not.toHaveTextContent('Correcto')
    })

    it('a read older than this connection is «Sin confirmar»', async () => {
      serve({ health: () => json(healthWithVerdict(BUCKET)), activity: quiet })
      const { rerender } = render(<Observer latest={null} />)
      await waitFor(() => expect(health()).toHaveTextContent('Correcto'))
      rerender(<Observer latest={null} connectedAtMs={NOW + 5_000} />)
      expect(health()).toHaveTextContent('Sin confirmar')
    })

    it('recovers with a new read taken on a valid clock', async () => {
      let fail = false
      serve({
        health: () => (fail ? json({}, 503) : json(healthWithVerdict(BUCKET))),
        activity: quiet,
      })
      const { rerender } = render(<Observer latest={null} />)
      await waitFor(() => expect(health()).toHaveTextContent('Correcto'))
      fail = true
      await vi.advanceTimersByTimeAsync(31_000)
      rerender(<Observer latest={null} />)
      await waitFor(() => expect(health()).toHaveTextContent('Sin confirmar'))
      fail = false
      await vi.advanceTimersByTimeAsync(31_000)
      const later = Date.now()
      serve({
        health: () =>
          json(healthWithVerdict(BUCKET, 'ok', 'PF_XBTUSD', later - 5_000)),
        activity: quiet,
      })
      await vi.advanceTimersByTimeAsync(31_000)
      const now = Date.now()
      rerender(
        <Observer
          latest={null}
          clock={{ publishedAtMs: now, receivedAtMs: now }}
          localNowMs={now}
        />,
      )
      await waitFor(() => expect(health()).toHaveTextContent('Correcto'))
    })
  })
})
