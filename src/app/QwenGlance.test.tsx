import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import QwenGlance from './QwenGlance.tsx'

const hook = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('./useQwenTrades.ts', () => ({
  useQwenTrades: () => hook.read(),
}))

afterEach(cleanup)
beforeEach(() => hook.read.mockReset())

describe('QwenGlance position certainty', () => {
  it.each(['loading', 'error', 'off'])(
    'does not claim a flat account when the source is %s',
    (state) => {
      hook.read.mockReturnValue({
        trades: [],
        source: { state, reason: 'unavailable' },
      })
      render(<QwenGlance product="PF_ETHUSD" latest={null} nowMs={1000} />)
      expect(screen.queryByText(/Sin posición abierta/)).not.toBeInTheDocument()
      expect(screen.getByTestId('glance-position')).toHaveTextContent(
        /Cargando|No se puede confirmar/,
      )
    },
  )

  it('keeps the last known position visibly unconfirmed on a read failure', () => {
    hook.read.mockReturnValue({
      trades: [{ open: true, side: 'LONG', entryMs: 0, netUsd: 5 }],
      source: { state: 'error' },
    })
    render(<QwenGlance product="PF_ETHUSD" latest={null} nowMs={1000} />)
    expect(screen.getByTestId('glance-position')).toHaveTextContent(
      /último dato|Último dato|sin confirmar/,
    )
    expect(screen.queryByText(/Sin posición abierta/)).not.toBeInTheDocument()
  })

  it('shows flat only when the source confirms there is no open position', () => {
    hook.read.mockReturnValue({ trades: [], source: { state: 'ok' } })
    render(<QwenGlance product="PF_ETHUSD" latest={null} nowMs={1000} />)
    expect(screen.getByTestId('glance-position')).toHaveTextContent(
      'Sin posición abierta',
    )
  })

  it('does not color bearish news green just because it supports a short signal', () => {
    hook.read.mockReturnValue({ trades: [], source: { state: 'ok' } })
    render(
      <QwenGlance
        product="PF_ETHUSD"
        nowMs={1000}
        latest={{
          formula_action: 'MANTENER',
          formula: {
            maestro: -2,
            portero_si: false,
            noticias_si: true,
            noticias: { disponible: true, n: 2, sentimiento: -1 },
          },
        }}
      />,
    )
    const chip = screen.getByText(/Noticias/)
    expect(chip).toHaveClass('text-short')
    expect(chip).not.toHaveClass('text-long')
    expect(chip).toHaveTextContent(/bajistas/)
  })
})
