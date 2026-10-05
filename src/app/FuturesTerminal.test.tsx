import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import FuturesTerminal from './FuturesTerminal.tsx'
import type {
  TerminalBootstrap,
  TerminalEnvelope,
} from '../features/connected-trading/infrastructure/terminal-stream-client.ts'
import { parseTerminalEnvelope } from '../features/connected-trading/infrastructure/terminal-stream-client.ts'
import { reasonLabel } from './terminal-copy.ts'

vi.mock(
  '../features/trading-view/presentation/ApprovedTerminalChart.tsx',
  () => ({
    default: () => null,
  }),
)

class TestWebSocket {
  static readonly OPEN = 1
  static instances: TestWebSocket[] = []
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: ((message: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  sent: string[] = []

  constructor(url: string) {
    void url
    TestWebSocket.instances.push(this)
  }

  send(message: string) {
    this.sent.push(message)
  }

  open() {
    this.readyState = TestWebSocket.OPEN
    this.onopen?.()
  }

  receive(event: TerminalEnvelope) {
    this.onmessage?.({ data: JSON.stringify(event) })
  }

  close() {
    this.readyState = 3
    this.onclose?.()
  }
}

class TerminalSocket {
  static latest: TerminalSocket | undefined
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  readyState = 1

  constructor() {
    TerminalSocket.latest = this
    queueMicrotask(() => this.onopen?.())
  }

  send(): void {}
  close(): void {
    this.readyState = 3
  }

  publish(event: TerminalEnvelope): void {
    this.onmessage?.({ data: JSON.stringify(event) })
  }
}

const bootstrap: TerminalBootstrap = {
  schema_version: 1,
  mode: 'mock',
  source: 'local-protection.v1',
  active_run_id: 'local-protection-v1',
  engine: { scenario_status: 'Escenario iniciado' },
  terminal_market: {
    schema_version: 'mock-terminal-market.v1',
    as_of_ms: 21_600_000,
    interval_ms: 60_000,
    candles: [
      {
        time_ms: 21_540_000,
        open: '100000',
        high: '100050',
        low: '99950',
        close: '100000',
        volume_btc: '1',
        closed: true,
      },
    ],
  },
}

describe('FuturesTerminal local scenario presentation', () => {
  afterEach(() => {
    cleanup()
    TestWebSocket.instances = []
    vi.unstubAllGlobals()
  })

  it('preserves backend reason-code copy', () => {
    expect(reasonLabel('no_directional_proposal')).toBe(
      'No hay una propuesta direccional disponible; el motor espera.',
    )
  })

  it('still shows the latest actual public trade instead of the last candle close', async () => {
    vi.stubGlobal('WebSocket', TerminalSocket)
    render(
      <FuturesTerminal
        bootstrap={{
          schema_version: 1,
          mode: 'paper_live',
          source: 'kraken-public-live-stream.v1',
          active_run_id: 'live-run',
          market: {
            status: 'live',
            last_received_at: 1_800_000_000_125,
            funding: 'unknown',
          },
          engine: { status: 'warming', funding: 'unresolved' },
        }}
      />,
    )
    await waitFor(() => expect(TerminalSocket.latest).toBeDefined())
    const snapshot: TerminalEnvelope = {
      schema_version: 1,
      event_id: 'snapshot-1',
      stream_id: 'stream-1',
      run_id: 'live-run',
      seq: 0,
      type: 'snapshot',
      instrument_id: 'kraken-futures:PF_XBTUSD',
      event_time: 1_800_000_000_000,
      published_at: 1_800_000_000_125,
      data: {
        watermark: 0,
        market: {
          schema_version: 'futures-terminal-market.v1',
          as_of_ms: 1_800_000_000_125,
          interval_ms: 60_000,
          candles: [
            {
              time_ms: 1_799_999_940_000,
              open: '99999',
              high: '99999',
              low: '99999',
              close: '99999',
              volume_btc: '0.01',
              closed: false,
            },
          ],
        },
        state: {
          run_id: 'live-run',
          state_version: 0,
          market: {
            feed: 'trade',
            event_time: 1_800_000_000_000,
            received_at: 1_800_000_000_125,
            last_received_at: 1_800_000_000_125,
            normalized: { type: 'trade', priceUsd: '100123.45' },
          },
          account: {
            cash_usd: '10000',
            equity_usd: '10000',
            realized_gross_usd: '0',
            fees_usd: '0',
            funding_paid_usd: '0',
            funding_complete: false,
            net_usd: null,
          },
          position: null,
          orders: [],
          fills: [],
          analyses: [],
          ledger_events: [],
        },
      },
    }
    expect(parseTerminalEnvelope(snapshot)).not.toBeNull()
    TerminalSocket.latest!.publish(snapshot)
    expect(await screen.findByText(/100\.123,45/)).toBeTruthy()
    expect(screen.getByText('Último trade público · USD/BTC')).toBeTruthy()
    expect(
      screen.getByText(/Evento .* UTC · recibido .* UTC · hace \d+ s/),
    ).toBeTruthy()
    expect(screen.getByText(/Profundidad bid\/ask: no expuesta/)).toBeTruthy()
    expect(screen.getByText(/Financiación: desconocida/)).toBeTruthy()
    expect(screen.getByText('Incompleto')).toBeTruthy()
  })

  it('renders backend status and exact account/order/position values without controls or polling', async () => {
    const interval = vi.spyOn(globalThis, 'setInterval')
    vi.stubGlobal('WebSocket', TestWebSocket)
    render(<FuturesTerminal bootstrap={bootstrap} />)
    const socket = TestWebSocket.instances[0]!
    await act(async () => socket.open())
    expect(JSON.parse(socket.sent[0]!)).toMatchObject({
      type: 'subscribe',
      run_id: bootstrap.active_run_id,
    })
    await act(async () =>
      socket.receive(envelope('snapshot', 0, { watermark: 0, state: {} })),
    )
    expect(screen.getByText('MOCK · mercado simulado')).toBeTruthy()
    expect(screen.getByText('Escenario iniciado')).toBeTruthy()
    expect(interval).not.toHaveBeenCalled()

    await act(async () => {
      socket.receive(
        envelope('engine.status', 1, {
          scenario_status: 'running',
          message: 'Escenario ejecutándose',
        }),
      )
      socket.receive(
        envelope('market.updated', 2, {
          candle: {
            bucket_start_ms: 21_540_000,
            interval_ms: 60_000,
            known_at_ms: 21_600_000,
            closed: true,
            open: '100000',
            high: '100050',
            low: '99950',
            close: '100000',
            volume_btc: '1',
          },
        }),
      )
      socket.receive(
        envelope('position.updated', 3, {
          position: { side: 'long', quantity_btc: '0.005' },
        }),
      )
      socket.receive(
        envelope('account.updated', 4, {
          account: {
            cash_usd: '10000',
            equity_usd: '9999.21014',
            realized_gross_usd: '-0.29',
            fees_usd: '0.49986',
            funding_paid_usd: '0',
            funding_complete: true,
            net_usd: '-0.78986',
          },
        }),
      )
      socket.receive(
        envelope('order.updated', 5, {
          order: {
            order_id: 'local-entry',
            side: 'buy',
            type: 'partially_filled',
            quantity_btc: '0.005',
          },
        }),
      )
    })
    expect(screen.getByText('Escenario ejecutándose')).toBeTruthy()
    expect(screen.getByText('long · 0.005 BTC')).toBeTruthy()

    await act(async () => {
      socket.receive(
        envelope('position.updated', 6, {
          position: { side: null, quantity_btc: '0' },
        }),
      )
      socket.receive(
        envelope('account.updated', 7, {
          account: {
            cash_usd: '9999.78986',
            equity_usd: '9999.21014',
            realized_gross_usd: '-0.29',
            fees_usd: '0.49986',
            funding_paid_usd: '0',
            funding_complete: true,
            net_usd: '-0.78986',
          },
        }),
      )
      socket.receive(
        envelope('engine.status', 8, {
          scenario_status: 'completed',
          message: 'Escenario finalizado',
        }),
      )
    })
    expect(screen.getByText('Escenario finalizado')).toBeTruthy()
    expect(screen.getByText('0 BTC · Sin exposición')).toBeTruthy()
    const values = document.querySelectorAll('dd[data-value]')
    expect(
      [...values].map((item) => item.getAttribute('data-value')),
    ).toContain('9999.21014')
    expect(
      [...values].map((item) => item.getAttribute('data-value')),
    ).toContain('0.49986')
    expect(screen.queryByText('Controles simulados')).toBeNull()
    expect(
      screen.queryByRole('button', { name: 'Iniciar simulación' }),
    ).toBeNull()
    expect(screen.getByText(/0.005 · local-entry/)).toBeTruthy()
    interval.mockRestore()
  })
})

function envelope(
  type: string,
  seq: number,
  data: Record<string, unknown>,
): TerminalEnvelope {
  return {
    schema_version: 1,
    event_id: `event-${seq}-${type}`,
    stream_id: 'local-stream',
    run_id: bootstrap.active_run_id,
    seq,
    type,
    instrument_id: 'kraken-futures:PF_XBTUSD',
    event_time: 21_600_000 + seq,
    published_at: 21_600_000 + seq,
    data,
  }
}
