import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import MovementsPanel from './MovementsPanel.tsx'
import type {
  Movement,
  MovementsQuery,
  MovementsReport,
} from '../infrastructure/movements-api.ts'

const base: Movement = {
  id: 'qwen:PF_XBTUSD:1',
  source: 'qwen',
  product_id: 'PF_XBTUSD',
  side: 'LONG',
  status: 'closed',
  opened_at_ms: 1791000000000,
  closed_at_ms: 1791003600000,
  entry_price: '100',
  exit_price: '101',
  quantity: '1',
  notional_usd: 100,
  fees_usd: 0.1,
  funding_usd: 0.01,
  funding_status: 'complete',
  net_usd: 0.8,
  net_pct: 0.8,
  open_reason: 'pullback@c25',
  close_reason: 'qwen_close',
  decision: { answer: 'close', probability: 0.7, at_ms: 1 },
  forecast: null,
}
const summary = (n: number) => ({
  operations: n,
  open: 1,
  closed: n - 1,
  wins: 1,
  hit_rate: 1,
  net_usd: 0.6,
  forecasts_without_trade: null,
})
const report = (
  items: Movement[],
  over: Partial<MovementsReport> = {},
): MovementsReport => ({
  status: 'ok',
  source: 'qwen',
  summary: { qwen: summary(items.length), kronos: summary(0) },
  total: items.length,
  items,
  sources: { qwen: 'ok', kronos: 'ok' },
  reasons: { qwen: null, kronos: null },
  ...over,
})

describe('MovementsPanel', () => {
  it('shows the summary, plain-language reasons and highlights open ones', async () => {
    const open: Movement = {
      ...base,
      id: 'o',
      status: 'open',
      closed_at_ms: null,
      exit_price: null,
      decision: { answer: 'hold', probability: 0.6, at_ms: 2 },
    }
    const load = vi.fn((query: MovementsQuery) =>
      Promise.resolve(report([open, base], { source: query.source })),
    )
    render(<MovementsPanel load={load} />)
    expect(
      await screen.findByText(/Qwen decidió cerrar \(70 %\)/),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/Última decisión de Qwen: mantener \(60 %\)/),
    ).toBeInTheDocument()
    const rows = screen.getAllByRole('row')
    expect(rows[1]).toHaveClass('is-open')
    expect(
      within(screen.getByLabelText('Resumen')).getByText('Resultado total'),
    ).toBeInTheDocument()
  })

  it('switches to Kronos and explains an empty list', async () => {
    const load = vi.fn((q: MovementsQuery) =>
      Promise.resolve(
        report([], {
          source: q.source,
          summary: {
            qwen: summary(0),
            kronos: { ...summary(0), forecasts_without_trade: 5 },
          },
        }),
      ),
    )
    render(<MovementsPanel load={load} />)
    expect(
      await screen.findByText(/solo entra cuando una estrategia da señal/),
    ).toBeInTheDocument()
    await userEvent.click(screen.getByRole('tab', { name: 'Kronos' }))
    expect(
      await screen.findByText(
        /hizo 5 pronósticos pero ninguno superó el umbral/,
      ),
    ).toBeInTheDocument()
    expect(load).toHaveBeenLastCalledWith(
      expect.objectContaining({ source: 'kronos' }),
    )
  })

  it('polls every 10 seconds', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const load = vi.fn(() => Promise.resolve(report([base])))
    render(<MovementsPanel load={load} />)
    await screen.findByText('Largo')
    const before = load.mock.calls.length
    await vi.advanceTimersByTimeAsync(10_000)
    expect(load.mock.calls.length).toBe(before + 1)
    vi.useRealTimers()
  })

  it('tells when the server is unreachable', async () => {
    render(
      <MovementsPanel
        load={() => Promise.resolve(report([], { status: 'unreachable' }))}
      />,
    )
    expect(await screen.findByText(/No se pudo conectar/)).toBeInTheDocument()
  })
})
