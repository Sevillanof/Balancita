import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { agoText, stateLine } from '../domain/forward-text.ts'
import { exampleRow } from '../testing/inventory-fixture.ts'
import type {
  ForwardHealth as Health,
  ForwardResult as Result,
} from '../infrastructure/strategy-api.ts'
import { ForwardHealth } from './ForwardHealth.tsx'
import { ForwardResult } from './ForwardResult.tsx'

// DATOS DE EJEMPLO: cifras sintéticas de pruebas, nunca de la app.
const NOW = 1_800_000_000_000
const side = (closed: number, net: number) => ({
  closed,
  net_usd: net,
  mean_net_bp: closed ? 10 : null,
  hit_rate: null,
  funding_incomplete: 0,
  net_is_definitive: true,
})

const result = (patch: Partial<Result> = {}): Result => ({
  state: { code: 'active', reason: 'activa en el registro', since_ms: null },
  problems: [],
  available: true,
  live: side(37, 12.5),
  recovered: side(4, -3),
  open: {
    count: 1,
    label: 'abierta, valuada a mercado',
    pnl_usd: 1.2,
    positions: [
      {
        product_id: 'PF_XBTUSD',
        side: 'SHORT',
        entry_price: '100',
        opened_at_ms: NOW - 3_600_000,
        label: 'abierta, valuada a mercado',
        mark_price: '99',
        mark_bucket_ms: NOW - 60_000,
        pnl_usd: 1.2,
        net_bp: 120,
      },
    ],
  },
  progress: { live_trades: 37, min_trades: 100, remaining: 63, reached: false },
  last_run_ms: NOW - 20 * 60_000,
  late: false,
  funding_state: {},
  ...patch,
})

const rowWith = (trades: Result | null, missing: string | null = null) =>
  exampleRow({
    id: 'x',
    name: 'X',
    forward: {
      registered: true,
      start_ms: 1,
      registered_at: null,
      min_trades: 100,
      trades,
      available: trades !== null,
      missing,
      problems: [],
    },
  })

describe('ForwardResult (datos de ejemplo)', () => {
  it('shows live and recovered apart, progress, the open position labelled and the last run', () => {
    render(<ForwardResult row={rowWith(result())} now={NOW} />)
    expect(screen.getByTestId('forward-live')).toHaveTextContent(
      'En vivo: 37 cerradas · +12,50 USD netos',
    )
    expect(screen.getByTestId('forward-recovered')).toHaveTextContent(
      'Recuperadas: 4 cerradas · −3,00 USD netos',
    )
    expect(screen.getByTestId('forward-progress')).toHaveTextContent(
      '37/100 operaciones en vivo',
    )
    expect(screen.getByRole('progressbar')).toHaveAttribute('value', '37')
    const open = screen.getByTestId('forward-open')
    expect(open).toHaveTextContent('Abiertas: 1')
    expect(open).toHaveTextContent('PF_XBTUSD corta desde 100')
    expect(open).toHaveTextContent('+1,20 USD')
    expect(open).toHaveTextContent('abierta, valuada a mercado')
    expect(screen.getByTestId('forward-last-run')).toHaveTextContent(
      'Último ciclo: hace 20 min',
    )
    expect(screen.queryByText('Atrasado')).not.toBeInTheDocument()
  })

  it('flags a late forward and names every problem', () => {
    render(
      <ForwardResult
        row={rowWith(
          result({
            late: true,
            last_run_ms: NOW - 3 * 3_600_000,
            problems: [
              {
                code: 'late',
                reason: 'el forward no corre desde hace 180 min',
              },
            ],
          }),
        )}
        now={NOW}
      />,
    )
    expect(screen.getByText('Atrasado')).toBeInTheDocument()
    expect(screen.getByTestId('forward-last-run')).toHaveTextContent('hace 3 h')
    expect(screen.getByTestId('forward-problem')).toHaveTextContent('180 min')
  })

  it('warns that a net with incomplete funding can still change', () => {
    const live = {
      ...side(5, 2),
      funding_incomplete: 2,
      net_is_definitive: false,
    }
    render(<ForwardResult row={rowWith(result({ live }))} now={NOW} />)
    expect(screen.getByTestId('forward-live')).toHaveTextContent(
      'Funding incompleto en 2',
    )
  })

  it('says a position cannot be valued instead of inventing a number', () => {
    const base = result()
    const position = {
      ...base.open.positions[0],
      pnl_usd: null,
      mark_price: null,
    }
    render(
      <ForwardResult
        row={rowWith(result({ open: { ...base.open, positions: [position] } }))}
        now={NOW}
      />,
    )
    expect(screen.getByTestId('forward-open')).toHaveTextContent(
      'sin precio para valuarla',
    )
  })

  it('shows an off strategy with its reason and since date, and never a bare unknown', () => {
    render(
      <ForwardResult
        row={rowWith(
          result({
            state: {
              code: 'off',
              reason: 'usa funding inventado',
              since_ms: Date.UTC(2026, 9, 18),
            },
          }),
        )}
        now={NOW}
      />,
    )
    expect(screen.getByTestId('forward-state')).toHaveTextContent(
      'Apagada: usa funding inventado (desde 2026-10-18)',
    )
  })

  it('shows the reason when the strategy has no forward result', () => {
    render(
      <ForwardResult
        row={rowWith(null, 'Kronos guarda su actividad aparte')}
        now={NOW}
      />,
    )
    expect(screen.getByTestId('forward-result')).toHaveTextContent(
      'Kronos guarda su actividad aparte',
    )
  })
})

const health = (patch: Partial<Health> = {}): Health => ({
  generated_ms: NOW,
  cadence_s: 3600,
  late_after_s: 5400,
  summary_updated_ms: NOW,
  summary_available: true,
  funding: {
    PF_XBTUSD: {
      usable: true,
      code: 'ok',
      reason: 'ok',
      checked_ms: NOW - 60_000,
    },
    PF_ETHUSD: {
      usable: false,
      code: 'stale_history',
      reason: 'el funding llega con retraso',
      checked_ms: NOW - 60_000,
    },
  },
  q_skips: {
    available: true,
    reason: null,
    windows: {
      '1h': { total: 2, by_code: { model_down: 2 } },
      '24h': { total: 3, by_code: { model_down: 2, calm_skip: 1 } },
    },
    latest: [
      {
        product_id: 'PF_XBTUSD',
        bucket_start: 0,
        question_id: 'q',
        code: 'model_down',
        reason: 'modelo local caído (llama-server no responde)',
        written_at: NOW - 5 * 60_000,
      },
    ],
  },
  ...patch,
})

describe('ForwardHealth (datos de ejemplo)', () => {
  it('lists funding per product with the reason of the unusable ones, and Q skips by code', () => {
    render(<ForwardHealth health={health()} now={NOW} />)
    const funding = within(screen.getByTestId('funding-list'))
    expect(funding.getByText(/PF_XBTUSD/)).toBeInTheDocument()
    expect(
      screen.getByText(/PF_ETHUSD: el funding llega con retraso/),
    ).toBeInTheDocument()
    const counts = screen.getByTestId('skip-counts')
    expect(counts).toHaveTextContent('Última hora2Modelo local caído 2')
    expect(counts).toHaveTextContent('Modelo local caído 2 · Filtro de calma 1')
    expect(screen.getByTestId('skip-latest')).toHaveTextContent(
      'modelo local caído (llama-server no responde)',
    )
  })

  it('says why Q skips or the funding cannot be read', () => {
    render(
      <ForwardHealth
        health={health({
          funding: {},
          summary_available: false,
          q_skips: {
            available: false,
            reason: 'sin base de decisiones de Q',
            windows: {},
            latest: [],
          },
        })}
        now={NOW}
      />,
    )
    expect(screen.getByText(/Sin resumen del forward/)).toBeInTheDocument()
    expect(screen.getByText('sin base de decisiones de Q')).toBeInTheDocument()
  })

  it('explains a service with no forward reading', () => {
    render(<ForwardHealth health={null} now={NOW} />)
    expect(screen.getByTestId('forward-health')).toHaveTextContent(
      'no tiene configurada la lectura del forward',
    )
  })
})

describe('forward-text', () => {
  it('writes the age in minutes up to 90 and in hours after', () => {
    expect(agoText(NOW - 89 * 60_000, NOW)).toBe('hace 89 min')
    expect(agoText(NOW - 90 * 60_000, NOW)).toBe('hace 2 h')
    expect(agoText(null, NOW)).toBeNull()
  })

  it('omits the date when the state has no start', () => {
    expect(stateLine({ code: 'retired', reason: 'x', since_ms: null })).toBe(
      'Desactivada: x',
    )
  })
})
