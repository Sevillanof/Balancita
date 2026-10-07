import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import ReplayPanel from './ReplayPanel.tsx'
import { syntheticCandles } from '../infrastructure/lab-candles.ts'
import type {
  ReplayApi,
  ReplayDetail,
  ReplayRun,
} from '../infrastructure/replay-api.ts'

vi.mock('../../trading-view/presentation/ApprovedTerminalChart.tsx', () => ({
  default: ({ markers }: { markers: unknown[] }) => (
    <div data-testid="replay-chart">{markers.length} marcas</div>
  ),
}))

const run: ReplayRun = {
  id: 'r1',
  status: 'done',
  product_id: 'PF_XBTUSD',
  start_ms: Date.UTC(2026, 9, 1),
  end_ms: Date.UTC(2026, 9, 4),
  qwen: { trigger: 'entry' },
  error: null,
}
const summary = {
  strategy_id: 'c25',
  trades: 4,
  wins: 3,
  trade_hit_rate: 0.75,
  pnl_usd: 2.5,
  return_pct_on_notional: 2.5,
  decisions: 6,
  decision_hit_rate: 0.5,
  skipped: 0,
}
const detail: ReplayDetail = {
  id: 'r1',
  status: 'done',
  summaries: [summary],
  trades: [
    {
      strategy_id: 'c25',
      side: 'LONG',
      entry_time_ms: 1_790_000_000_000,
      exit_time_ms: 1_790_000_600_000,
      net_bp: 12,
      pnl_usd: 0.12,
      hit: true,
    },
  ],
  qwen: {
    decisions: [
      { bucket_start: 1_790_000_000_000, chosen: 'buy', confidence: 0.6 },
      { bucket_start: 1_790_000_060_000, chosen: 'hold', confidence: 0.5 },
    ],
    report: {
      decisions: { hit_rate: 0.4, scored: 5, points: -1 },
      trading: {
        trades: 2,
        wins: 1,
        hit_rate: 0.5,
        pnl_usd: -1,
        return_pct: -1,
      },
    },
  },
}

const fakeApi = (runs: ReplayRun[]): ReplayApi => ({
  list: vi.fn().mockResolvedValue(runs),
  start: vi.fn().mockResolvedValue({ ...run, id: 'r2', status: 'running' }),
  detail: vi.fn().mockResolvedValue(detail),
  candles: vi.fn().mockResolvedValue(syntheticCandles(120)),
})

describe('ReplayPanel', () => {
  it('says there are no replays yet', async () => {
    render(<ReplayPanel api={fakeApi([])} />)
    expect(await screen.findByText(/Todavía no corriste/)).toBeInTheDocument()
  })

  it('shows the results of a run and draws the chosen trades or Qwen decisions', async () => {
    const user = userEvent.setup()
    render(<ReplayPanel api={fakeApi([run])} />)
    await user.click(
      await screen.findByRole('button', {
        name: /PF_XBTUSD · 2026-10-01 → 2026-10-04/,
      }),
    )
    const table = await screen.findByRole('table')
    expect(within(table).getByText('c25')).toBeInTheDocument()
    expect(within(table).getByText('Qwen')).toBeInTheDocument()
    expect(await screen.findByTestId('replay-chart')).toHaveTextContent(
      '2 marcas',
    )
    await user.click(within(table).getByRole('button', { name: 'Qwen' }))
    expect(screen.getByTestId('replay-chart')).toHaveTextContent('1 marcas')
  })

  it('starts a replay with the chosen range and Qwen trigger', async () => {
    const user = userEvent.setup()
    const api = fakeApi([])
    render(<ReplayPanel api={api} />)
    await screen.findByText(/Todavía no corriste/)
    await user.click(screen.getByLabelText(/Que Qwen decida/))
    await user.selectOptions(screen.getByLabelText(/Preguntarle/), '5min')
    await user.click(screen.getByRole('button', { name: 'Correr replay' }))
    expect(api.start).toHaveBeenCalledWith(
      expect.objectContaining({
        product: 'PF_XBTUSD',
        qwen: { trigger: '5min' },
      }),
    )
  })

  it('reports a registry error instead of an empty list', async () => {
    const api = fakeApi([])
    api.list = vi.fn().mockRejectedValue(new Error('sin respuesta'))
    render(<ReplayPanel api={api} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('sin respuesta')
  })
})
