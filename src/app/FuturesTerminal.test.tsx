import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import FuturesTerminal from './FuturesTerminal.tsx'
import { reasonLabel } from './terminal-copy.ts'
import { parseTerminalEnvelope } from '../features/connected-trading/infrastructure/terminal-stream-client.ts'
import type { TerminalEnvelope } from '../features/connected-trading/infrastructure/terminal-stream-client.ts'

vi.mock(
  '../features/trading-view/presentation/ApprovedTerminalChart.tsx',
  () => ({
    default: () => null,
  }),
)

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

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('futures terminal copy', () => {
  it('renders WAIT reasons in Spanish rather than exposing the backend code', () => {
    expect(reasonLabel('no_directional_proposal')).toBe(
      'No hay una propuesta direccional disponible; el motor espera.',
    )
  })

  it('shows the latest actual public trade instead of the last candle close', async () => {
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
})
