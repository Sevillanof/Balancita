/* eslint-disable @typescript-eslint/no-explicit-any -- loosely typed JSON fixtures */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import healthDegraded from '../../docs/mission-control/b1/ejemplo-degradado.json'
import AppStatusChips from './AppStatusChips.tsx'

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('AppStatusChips', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
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
    expect(await screen.findByText('En vivo')).toBeInTheDocument()
    expect(screen.queryByText('Sin precio recibido todavía')).toBeNull()
  })

  it('is one chip: B1 health first, flow and PAPER as details, inspector on click', async () => {
    const override = { connected: false, processes: null, quoteAgeMs: null }
    render(
      <AppStatusChips
        apiBase="/api-live"
        showUsage={false}
        override={override}
        b1={{ data: healthDegraded as any, error: null }}
      />,
    )
    const chip = screen.getByTestId('health-indicator')
    expect(chip).toHaveTextContent('Salud: 5 con problemas')
    expect(within(chip).getByTestId('flow-status')).toHaveTextContent(
      'Sin conexión',
    )
    expect(chip).toHaveTextContent('PAPER')
    expect(screen.getAllByTestId('health-indicator')).toHaveLength(1)
    await userEvent.click(chip)
    const dialog = screen.getByRole('dialog', { name: 'Salud del sistema' })
    expect(within(dialog).getByText('FLUJO DESCONECTADO')).toBeInTheDocument()
    expect(within(dialog).getAllByRole('heading', { level: 3 })).toHaveLength(6)
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
