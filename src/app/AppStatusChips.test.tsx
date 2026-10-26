import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import healthDegraded from '../../docs/mission-control/b1/ejemplo-degradado.json'
import AppStatusChips from './AppStatusChips.tsx'
import { decodeHealth } from '../features/observability/infrastructure/observability-api.ts'

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('AppStatusChips', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('reads the quote time the live gateway reports in /health', async () => {
    // The shape `GET /api-live/health` returns: capture time in camelCase.
    const health = {
      process: 'live-gateway',
      capture: { status: 'live', reason: null, lastReceivedAt: Date.now() },
      processes: {
        capture: { status: 'running' },
        live: { status: 'running' },
      },
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.endsWith('/health') ? json(health) : json({}),
      ),
    )
    render(<AppStatusChips apiBase="/api-live" showUsage={false} />)
    expect(await screen.findByText('Flujo en vivo')).toBeInTheDocument()
    expect(screen.queryByText('Sin precio recibido todavía')).toBeNull()
  })

  it('is one chip: B1 health first, flow and PAPER as details, inspector on click', () => {
    vi.useFakeTimers({ now: 1_791_000_240_000 })
    const override = { connected: false, processes: null, quoteAgeMs: null }
    const receivedAt = Date.now()
    const data = decodeHealth({
      ...healthDegraded,
      generated_at_ms: receivedAt - 10_000,
    })
    render(
      <AppStatusChips
        apiBase="/api-live"
        showUsage={false}
        override={override}
        b1={{ data, receivedAt, error: null }}
      />,
    )
    const chip = screen.getByTestId('health-indicator')
    expect(chip).toHaveTextContent('Salud: 5 con problemas')
    expect(chip).not.toHaveTextContent('lectura anterior')
    expect(within(chip).getByTestId('flow-status')).toHaveTextContent(
      'Flujo sin conexión',
    )
    expect(chip).toHaveTextContent('PAPER')
    expect(screen.getAllByTestId('health-indicator')).toHaveLength(1)
    fireEvent.click(chip)
    const dialog = screen.getByRole('dialog', { name: 'Salud del sistema' })
    expect(within(dialog).getByText('FLUJO DESCONECTADO')).toBeInTheDocument()
    expect(within(dialog).getAllByRole('heading', { level: 3 })).toHaveLength(6)
    expect(within(dialog).getByText(/Generación:/)).toHaveTextContent(
      'hace 10 s · Recepción: hace 0 s',
    )
  })

  it('opens the flow diagnosis without fetching or controlling a process', async () => {
    const user = userEvent.setup()
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    render(
      <AppStatusChips
        apiBase="/api-live"
        override={{ connected: false, processes: null, quoteAgeMs: null }}
        showUsage={false}
        diagnosis={<p>Detalle técnico del terminal</p>}
      />,
    )
    await user.click(screen.getByTestId('health-indicator'))
    const dialog = screen.getByRole('dialog', { name: 'Salud del sistema' })
    const summary = within(dialog).getByText(
      'Diagnóstico del flujo, uso y modo',
    )
    expect(summary.closest('details')).not.toHaveAttribute('open')
    await user.click(summary)
    expect(summary.closest('details')).toHaveAttribute('open')
    expect(
      within(dialog).getByText('Detalle técnico del terminal'),
    ).toBeVisible()
    expect(within(dialog).getByText(/sin órdenes reales/)).toBeInTheDocument()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('without a B1 read says «sin datos», never healthy; where B1 does not apply it says so', async () => {
    const override = { connected: true, processes: {}, quoteAgeMs: 1000 }
    const { rerender } = render(
      <AppStatusChips
        apiBase="/api-live"
        showUsage={false}
        override={override}
        b1={{ data: null, error: 'sin respuesta' }}
      />,
    )
    expect(screen.getByTestId('health-indicator')).toHaveTextContent(
      'Salud: sin datos',
    )
    expect(screen.getByTestId('health-indicator')).not.toHaveTextContent(
      'correcta',
    )
    rerender(
      <AppStatusChips
        apiBase="/api-live"
        showUsage={false}
        override={override}
      />,
    )
    const chip = screen.getByTestId('health-indicator')
    expect(chip).not.toHaveTextContent('Salud')
    await userEvent.click(chip)
    expect(
      screen.getByText('Salud B1: no disponible en este modo'),
    ).toBeInTheDocument()
  })
})
