import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import FuturesTerminal from './FuturesTerminal.tsx'
import type {
  TerminalBootstrap,
  TerminalEnvelope,
} from '../features/connected-trading/infrastructure/terminal-stream-client.ts'
import { parseTerminalEnvelope } from '../features/connected-trading/infrastructure/terminal-stream-client.ts'
import { reasonLabel } from './terminal-copy.ts'

type ChartClickParameter = {
  hoveredInfo?: { objectId?: string }
  hoveredObjectId?: string
  time?: number
}

const chartHarness = vi.hoisted(() => ({
  clickHandlers: [] as Array<(parameter: ChartClickParameter) => void>,
  markerSets: [] as Array<Record<string, unknown>[]>,
}))

vi.mock('lightweight-charts', () => {
  const priceScale = { applyOptions() {} }
  const series = {
    setData() {},
    update() {},
    priceScale: () => priceScale,
    createPriceLine: () => ({}),
    removePriceLine() {},
    applyOptions() {},
  }
  const timeScale = {
    getVisibleLogicalRange: () => null,
    setVisibleLogicalRange() {},
    fitContent() {},
    scrollToRealTime() {},
  }
  const chart = {
    addSeries: () => series,
    removeSeries() {},
    panes: () => [],
    removePane() {},
    timeScale: () => timeScale,
    subscribeClick(handler: (parameter: ChartClickParameter) => void) {
      chartHarness.clickHandlers.push(handler)
    },
    unsubscribeClick(handler: (parameter: ChartClickParameter) => void) {
      chartHarness.clickHandlers = chartHarness.clickHandlers.filter(
        (candidate) => candidate !== handler,
      )
    },
    remove() {},
  }
  return {
    CandlestickSeries: 'candlestick',
    ColorType: { Solid: 'solid' },
    HistogramSeries: 'histogram',
    LineSeries: 'line',
    createChart: () => chart,
    createSeriesMarkers: () => ({
      setMarkers(markers: Record<string, unknown>[]) {
        chartHarness.markerSets.push(markers)
      },
    }),
  }
})

class TestWebSocket {
  static readonly OPEN = 1
  static instances: TestWebSocket[] = []
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: ((message: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  sent: string[] = []
  readonly url: string

  constructor(url: string) {
    this.url = url
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
    chartHarness.clickHandlers = []
    chartHarness.markerSets = []
    vi.unstubAllGlobals()
  })

  it('opens the stream on the selected API base and closes it on unmount', () => {
    vi.stubGlobal('WebSocket', TestWebSocket)
    const view = render(
      <FuturesTerminal bootstrap={bootstrap} apiBase="/api-live" />,
    )
    const socket = TestWebSocket.instances[0]!
    expect(socket.url).toBe(`ws://${location.host}/api-live/terminal/stream`)
    view.unmount()
    expect(socket.readyState).toBe(3)
  })

  it('renders the entry-owned source switch inside the terminal header', () => {
    vi.stubGlobal('WebSocket', TestWebSocket)
    render(
      <FuturesTerminal
        bootstrap={bootstrap}
        sourceSwitch={<div data-testid="switch-slot" />}
      />,
    )
    expect(
      screen.getByTestId('switch-slot').closest('.demo-shell__status'),
    ).not.toBeNull()
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

  it('renders candles and the live price with the engine off, without fake account or analysis', async () => {
    vi.stubGlobal('WebSocket', TerminalSocket)
    render(
      <FuturesTerminal
        bootstrap={{
          schema_version: 1,
          mode: 'paper_live',
          source: 'kraken-public-live-stream.v1',
          active_run_id: 'live-market-view',
          market: {
            status: 'live',
            last_received_at: 1_800_000_000_125,
            funding: 'unknown',
          },
          engine: { status: 'off', reason: 'engine_not_running' },
          terminal_market: {
            schema_version: 'futures-terminal-market.v1',
            as_of_ms: 1_800_000_000_000,
            interval_ms: 60_000,
            candles: [
              {
                time_ms: 1_799_999_940_000,
                open: '99999',
                high: '100010',
                low: '99990',
                close: '100001',
                volume_btc: '0.5',
                closed: true,
              },
            ],
          },
        }}
      />,
    )
    await waitFor(() => expect(TerminalSocket.latest).toBeDefined())
    const envelope = (
      seq: number,
      type: string,
      data: Record<string, unknown>,
    ): TerminalEnvelope => ({
      schema_version: 1,
      event_id: `evt-${seq}-${type}`,
      stream_id: 'stream-1',
      run_id: 'live-market-view',
      seq,
      type,
      instrument_id: 'kraken-futures:PF_XBTUSD',
      event_time: 1_800_000_000_000,
      published_at: 1_800_000_000_125,
      data,
    })
    TerminalSocket.latest!.publish(
      envelope(10, 'snapshot', {
        watermark: 10,
        market: {
          schema_version: 'futures-terminal-market.v1',
          as_of_ms: 1_800_000_000_000,
          interval_ms: 60_000,
          candles: [
            {
              time_ms: 1_799_999_940_000,
              open: '99999',
              high: '100010',
              low: '99990',
              close: '100001',
              volume_btc: '0.5',
              closed: true,
            },
          ],
        },
        state: {
          run_id: 'live-market-view',
          state_version: 0,
          engine: { status: 'off', reason: 'engine_not_running' },
          market: {
            feed: 'ticker',
            event_time: 1_800_000_000_000,
            received_at: 1_800_000_000_125,
            normalized: { type: 'ticker', last: '100123.45' },
          },
        },
      }),
    )
    expect(await screen.findByText(/100\.123,45/)).toBeTruthy()
    expect(screen.getByText('Última vela cerrada')).toBeTruthy()
    expect(screen.getByText(/Motor de decisiones apagado/)).toBeTruthy()
    TerminalSocket.latest!.publish(
      envelope(11, 'market.updated', {
        candle: {
          id: 'c',
          interval_ms: 60_000,
          bucket_start_ms: 1_800_000_000_000,
          known_at_ms: 1_800_000_030_000,
          close_at_ms: null,
          closed: false,
          coverage: 'observed_trades_only_no_gap_certification',
          open: '100001',
          high: '100200',
          low: '100000',
          close: '100150',
          volume_btc: '0.2',
          trade_count: 2,
        },
        feed: 'trade',
        normalized: { type: 'trade', priceUsd: '100150' },
        event_time: 1_800_000_030_000,
        received_at: 1_800_000_030_100,
        last_received_at: 1_800_000_030_100,
        market_status: 'live',
      }),
    )
    expect(await screen.findByText('Vela en formación')).toBeTruthy()
    expect(screen.getByText(/100\.150/)).toBeTruthy()
    // No fabricated engine state while the engine is off.
    expect(screen.queryByText('Controles simulados')).toBeNull()
    expect(screen.queryByText('Saldo USD')).toBeNull()
    expect(screen.queryByText('Aún no hay análisis registrados.')).toBeNull()
    expect(screen.queryByText('Posiciones y operaciones')).toBeNull()
  })

  it('keeps the live bootstrap candle history when the snapshot carries no market', async () => {
    vi.stubGlobal('WebSocket', TerminalSocket)
    render(
      <FuturesTerminal
        bootstrap={{
          schema_version: 1,
          mode: 'paper_live',
          source: 'kraken-public-live-stream.v1',
          active_run_id: 'live-run',
          market: { status: 'live', funding: 'unknown' },
          engine: { status: 'warming', funding: 'unresolved' },
          terminal_market: {
            schema_version: 'futures-terminal-market.v1',
            as_of_ms: 1_800_000_000_000,
            interval_ms: 60_000,
            candles: [
              {
                time_ms: 1_799_999_940_000,
                open: '99999',
                high: '100010',
                low: '99990',
                close: '100001',
                volume_btc: '0.5',
                closed: true,
              },
            ],
          },
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
        state: {
          run_id: 'live-run',
          state_version: 0,
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
    expect(await screen.findByText('Incompleto')).toBeTruthy()
    expect(
      screen.queryByText('El snapshot no contiene velas BTC/USD verificables.'),
    ).toBeNull()
  })

  it('renders backend status and exact account/order/position values with MOCK entry controls and no polling', async () => {
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
    expect(screen.getByText('Controles simulados')).toBeTruthy()
    expect(screen.getByText(/no detiene el motor/)).toBeTruthy()
    for (const name of [
      'Pausar entradas (MOCK)',
      'Reanudar entradas (MOCK)',
      'Nueva cuenta/run (MOCK)',
    ])
      expect(screen.getByRole('button', { name })).toBeTruthy()
    for (const name of ['Iniciar simulación', 'Cerrar posición'])
      expect(screen.queryByRole('button', { name })).toBeNull()
    expect(screen.getByText(/0.005 · local-entry/)).toBeTruthy()
    interval.mockRestore()
  })

  it('sends entry pause and resume to the active run and renders paused state only from durable risk', async () => {
    vi.stubGlobal('WebSocket', TestWebSocket)
    render(<FuturesTerminal bootstrap={bootstrap} />)
    const socket = TestWebSocket.instances[0]!
    await act(async () => socket.open())
    await act(async () =>
      socket.receive(
        envelope('snapshot', 0, {
          watermark: 0,
          state: { state_version: 3, analyses: [], orders: [], fills: [] },
        }),
      ),
    )
    expect(screen.getByText('Estado de entradas no disponible')).toBeTruthy()
    await act(async () =>
      screen.getByRole('button', { name: 'Pausar entradas (MOCK)' }).click(),
    )
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
      type: 'paper.command',
      run_id: bootstrap.active_run_id,
      action: 'paper.pause',
      expected_state_version: 3,
    })
    expect(screen.queryByText(/Entradas pausadas por el usuario/)).toBeNull()
    await act(async () =>
      socket.receive(
        envelope('engine.status', 1, {
          scenario_status: 'running',
          message: 'Escenario ejecutándose',
          risk: {
            user_paused: true,
            entry_paused: true,
            daily_loss_latched: false,
            system_paused: false,
          },
        }),
      ),
    )
    expect(
      screen.getByText('Entradas pausadas por el usuario (MOCK)'),
    ).toBeTruthy()
    await act(async () =>
      socket.receive(
        envelope('engine.status', 2, {
          scenario_status: 'running',
          message: 'Escenario ejecutándose',
          risk: {
            user_paused: false,
            entry_paused: true,
            daily_loss_latched: true,
            system_paused: false,
          },
        }),
      ),
    )
    expect(
      screen.getByText('Entradas bloqueadas por límite de pérdida diaria'),
    ).toBeTruthy()
    expect(screen.queryByText('Entradas activas')).toBeNull()
    await act(async () =>
      socket.receive(
        envelope('engine.status', 3, {
          scenario_status: 'running',
          message: 'Escenario ejecutándose',
          risk: {
            user_paused: false,
            entry_paused: false,
            daily_loss_latched: false,
            system_paused: false,
          },
        }),
      ),
    )
    expect(screen.getByText('Entradas activas')).toBeTruthy()
  })

  it('switches the displayed run to the isolated child after a new run', async () => {
    vi.stubGlobal('WebSocket', TestWebSocket)
    render(<FuturesTerminal bootstrap={bootstrap} />)
    const socket = TestWebSocket.instances[0]!
    await act(async () => socket.open())
    await act(async () =>
      socket.receive(
        envelope('snapshot', 0, {
          watermark: 0,
          state: {
            state_version: 6,
            analyses: [{ analysis_id: 'parent-analysis', action: 'WAIT' }],
            orders: [],
            fills: [],
          },
        }),
      ),
    )
    await act(async () =>
      screen.getByRole('button', { name: 'Nueva cuenta/run (MOCK)' }).click(),
    )
    await act(async () =>
      screen.getByRole('button', { name: 'Confirmar nueva cuenta' }).click(),
    )
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
      action: 'paper.new_run',
      run_id: bootstrap.active_run_id,
      expected_state_version: 6,
    })
    await act(async () => {
      socket.receive(
        envelope('command.result', 1, {
          command_id: 'x',
          child_run_id: 'child-run',
          result: { result: { status: 'committed', applied_state_version: 1 } },
        }),
      )
      socket.receive(
        envelope(
          'snapshot',
          0,
          {
            watermark: 4,
            state: {
              run_id: 'child-run',
              state_version: 1,
              account: { equity_usd: '10000', cash_usd: '10000' },
              position: null,
              analyses: [{ analysis_id: 'child-analysis-1', action: 'WAIT' }],
              orders: [],
              fills: [],
            },
          },
          21_600_000,
          'child-run',
        ),
      )
    })
    await act(async () =>
      socket.receive(
        envelope(
          'engine.status',
          5,
          {
            scenario_status: 'running',
            message: 'Escenario ejecutándose',
            risk: { user_paused: false, entry_paused: false },
          },
          21_600_005,
          'child-run',
        ),
      ),
    )
    expect(screen.getByText('Entradas activas')).toBeTruthy()
    expect(screen.getByText(`Run: child-run`)).toBeTruthy()
    expect(screen.queryByText(`Run: ${bootstrap.active_run_id}`)).toBeNull()
    expect(screen.queryByText('parent-analysis')).toBeNull()
    await act(async () =>
      socket.receive(
        envelope('engine.status', 7, { message: 'Evento del padre' }),
      ),
    )
    expect(screen.queryByText('Evento del padre')).toBeNull()
    await act(async () =>
      screen.getByRole('button', { name: 'Pausar entradas (MOCK)' }).click(),
    )
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
      action: 'paper.pause',
      run_id: 'child-run',
      expected_state_version: 1,
    })
    await act(async () => socket.close())
    await waitFor(() => expect(TestWebSocket.instances).toHaveLength(2), {
      timeout: 3_000,
    })
    const reconnect = TestWebSocket.instances[1]!
    await act(async () => reconnect.open())
    expect(JSON.parse(reconnect.sent[0]!)).toMatchObject({
      type: 'resume',
      run_id: 'child-run',
      last_seq: 5,
    })
  })

  it('renders the entries-paused analysis reason in Spanish and reports a command that was not applied', async () => {
    vi.stubGlobal('WebSocket', TestWebSocket)
    render(<FuturesTerminal bootstrap={bootstrap} />)
    const socket = TestWebSocket.instances[0]!
    await act(async () => socket.open())
    await act(async () =>
      socket.receive(
        envelope('snapshot', 0, {
          watermark: 0,
          state: {
            state_version: 2,
            analyses: [
              {
                analysis_id: 'paused-analysis',
                action: 'WAIT',
                reason_codes: ['entries_paused'],
                decision_time_ms: 21_605_000,
              },
            ],
            orders: [],
            fills: [],
          },
        }),
      ),
    )
    expect(
      screen.getAllByText(/Entradas pausadas: el motor no abre nuevas/).length,
    ).toBeGreaterThan(0)
    expect(screen.queryByText('entries_paused')).toBeNull()
    await act(async () =>
      socket.receive(
        envelope('command.result', 1, {
          command_id: 'c1',
          result: { result: { status: 'superseded' } },
        }),
      ),
    )
    expect(screen.getByText(/Comando no aplicado: superseded/)).toBeTruthy()
  })

  it('renders and selects real same-candle chart markers using durable analysis and ledger times', async () => {
    vi.stubGlobal('WebSocket', TestWebSocket)
    render(<FuturesTerminal bootstrap={bootstrap} />)
    const socket = TestWebSocket.instances[0]!
    await act(async () => socket.open())
    const decisionTimes = [
      21_600_000, 21_605_000, 21_605_100, 21_605_200, 21_605_300,
    ]
    const wallClockTimes = [
      1_791_197_302_785, 1_791_197_306_352, 1_791_197_309_932,
      1_791_197_313_541, 1_791_197_317_177,
    ]
    const analyses = decisionTimes.map((decisionTime, index) => ({
      analysis_id: `analysis-${index + 1}`,
      action: index === 1 ? 'LONG' : 'WAIT',
      reason_codes:
        index === 0
          ? ['no_directional_proposal']
          : index === 1
            ? ['c27_long_breakout']
            : [index === 4 ? 'position_closed_this_cycle' : 'position_owned'],
      selector:
        index > 1
          ? { action: 'LONG', reason_code: 'c27_long_breakout' }
          : undefined,
      decision_time_ms: decisionTime,
      runtime_version: 'futures-runtime.v1',
    }))
    await act(async () =>
      socket.receive(
        envelope('snapshot', 0, {
          watermark: 0,
          market: {
            schema_version: 'mock-terminal-market.v1',
            as_of_ms: decisionTimes[0],
            interval_ms: 60_000,
            candles: [
              {
                time_ms: decisionTimes[0]! - 60_000,
                open: '100000',
                high: '100050',
                low: '99950',
                close: '100000',
                volume_btc: '1',
                closed: true,
              },
            ],
          },
          state: { analyses: [], orders: [], fills: [] },
        }),
      ),
    )

    for (const [index, analysis] of analyses.entries())
      await act(async () =>
        socket.receive(
          envelope(
            'analysis.completed',
            index + 1,
            { analysis },
            wallClockTimes[index]!,
          ),
        ),
      )
    await act(async () => {
      socket.receive(
        envelope(
          'order.updated',
          6,
          {
            order: {
              order_id: 'entry-order',
              decision_at_ms: decisionTimes[1],
              order_type: 'market_ioc',
              side: 'buy',
              state: 'cancelled',
              quantity_btc: '0.0099',
            },
          },
          wallClockTimes[1],
        ),
      )
      socket.receive(
        envelope(
          'order.updated',
          7,
          {
            order: {
              order_id: 'close-order',
              decision_at_ms: decisionTimes[3],
              order_type: 'reduce_only',
              side: 'sell',
              state: 'filled',
              quantity_btc: '0.005',
              reason_code: 'protective_stop',
            },
          },
          wallClockTimes[3],
        ),
      )
      socket.receive(
        envelope(
          'order.updated',
          8,
          {
            order: {
              order_id: 'wall-clock-only-order',
              decision_at_ms: wallClockTimes[2],
              type: 'order_accepted',
              side: 'buy',
              state: 'filled',
              quantity_btc: '0.001',
            },
          },
          wallClockTimes[2],
        ),
      )
      socket.receive(
        envelope(
          'fill.created',
          9,
          {
            fill: {
              fill_id: 'entry-fill',
              order_id: 'entry-order',
              side: 'long',
              quantity_btc: '0.005',
              price_usd_per_btc: '100001',
              event_time_ms: decisionTimes[2],
            },
          },
          wallClockTimes[2],
        ),
      )
      socket.receive(
        envelope(
          'fill.created',
          10,
          {
            fill: {
              fill_id: 'close-fill',
              order_id: 'close-order',
              side: 'long',
              quantity_btc: '0.005',
              price_usd_per_btc: '99943',
              event_time_ms: decisionTimes[4],
            },
          },
          wallClockTimes[4],
        ),
      )
    })

    expect(
      screen
        .getByTestId('approved-chart-renderer')
        .getAttribute('data-marker-count'),
    ).toBe('5')
    const visibleMarkers = chartHarness.markerSets.at(-1)!
    expect(visibleMarkers).toHaveLength(5)
    expect(visibleMarkers.map((marker) => marker.id)).toEqual(
      analyses.map((analysis) => analysis.analysis_id),
    )
    expect(new Set(visibleMarkers.map((marker) => marker.time)).size).toBe(1)
    expect(visibleMarkers.map((marker) => marker.time)).toEqual([
      21_540, 21_540, 21_540, 21_540, 21_540,
    ])
    expect(visibleMarkers.map((marker) => marker.shape)).toEqual([
      'square',
      'arrowUp',
      'square',
      'square',
      'square',
    ])
    expect(
      screen.getAllByRole('button', {
        name: /^Seleccionar análisis analysis-/,
      }),
    ).toHaveLength(2)
    expect(screen.getByText(/WAIT ×3/)).toBeTruthy()

    for (const [index, analysis] of analyses.entries()) {
      await act(async () =>
        chartHarness.clickHandlers.at(-1)?.({
          hoveredInfo: { objectId: analysis.analysis_id },
        }),
      )
      const selected = within(
        screen.getByRole('region', { name: 'Análisis seleccionado' }),
      )
      expect(selected.getByText(analysis.analysis_id)).toBeTruthy()
      expect(
        selected.getByText(
          `${new Date(decisionTimes[index]!).toLocaleString('es-ES', { timeZone: 'UTC' })} UTC`,
        ),
      ).toBeTruthy()
      if (index === 1) {
        expect(selected.getByText('entry-order')).toBeTruthy()
        expect(selected.getByText(/market_ioc\s*·\s*buy/)).toBeTruthy()
        expect(selected.getByText(/0\.005 BTC @/)).toBeTruthy()
        expect(selected.queryByText('wall-clock-only-order')).toBeNull()
      } else if (index === 3) {
        expect(selected.getByText('close-order')).toBeTruthy()
        expect(selected.getByText('protective_stop')).toBeTruthy()
        expect(selected.getByText(/close-fill/)).toBeTruthy()
      } else {
        expect(selected.getByText('Sin efecto')).toBeTruthy()
        expect(selected.queryByText('entry-order')).toBeNull()
        expect(selected.queryByText('close-order')).toBeNull()
        if (index === 0)
          expect(
            selected.getByText(
              'No hay una propuesta direccional disponible; el motor espera.',
            ),
          ).toBeTruthy()
        if (index === 2 || index === 3)
          expect(
            selected.getByText(
              'La posición sigue bajo gestión de su estrategia',
            ),
          ).toBeTruthy()
        if (index === 4)
          expect(
            selected.getByText('La posición se cerró durante este ciclo'),
          ).toBeTruthy()
      }
    }
  })

  it('resolves same-bucket chart clicks to every marker in that candle', async () => {
    vi.stubGlobal('WebSocket', TestWebSocket)
    render(<FuturesTerminal bootstrap={bootstrap} />)
    const socket = TestWebSocket.instances[0]!
    await act(async () => socket.open())
    const decisionTimes = [
      21_600_000, 21_605_000, 21_605_100, 21_605_200, 21_605_300,
    ]
    const analyses = decisionTimes.map((decisionTime, index) => ({
      analysis_id: `analysis-${index + 1}`,
      action: index === 1 ? 'LONG' : 'WAIT',
      reason_codes:
        index === 1 ? ['c27_long_breakout'] : ['no_directional_proposal'],
      decision_time_ms: decisionTime,
      runtime_version: 'futures-runtime.v1',
    }))
    await act(async () =>
      socket.receive(
        envelope('snapshot', 0, {
          watermark: 0,
          market: {
            schema_version: 'mock-terminal-market.v1',
            as_of_ms: decisionTimes[0],
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
          state: { analyses, orders: [], fills: [] },
        }),
      ),
    )

    expect(chartHarness.markerSets.at(-1)).toMatchObject(
      analyses.map((analysis) => ({ id: analysis.analysis_id, time: 21_540 })),
    )
    expect(selectedAnalysisId()).toBe('analysis-5')

    const reached: (string | undefined)[] = []
    for (let click = 0; click < 5; click += 1) {
      await act(async () =>
        chartHarness.clickHandlers.at(-1)?.({ time: 21_540 }),
      )
      reached.push(selectedAnalysisId())
    }
    expect(reached).toEqual([
      'analysis-1',
      'analysis-2',
      'analysis-3',
      'analysis-4',
      'analysis-5',
    ])

    await act(async () => chartHarness.clickHandlers.at(-1)?.({ time: 21_600 }))
    expect(selectedAnalysisId()).toBe('analysis-5')
    await act(async () => chartHarness.clickHandlers.at(-1)?.({ time: 21_480 }))
    expect(selectedAnalysisId()).toBe('analysis-5')

    await act(async () =>
      screen
        .getByRole('button', { name: 'Seleccionar análisis analysis-1' })
        .click(),
    )
    expect(selectedAnalysisId()).toBe('analysis-1')
    await act(async () => chartHarness.clickHandlers.at(-1)?.({ time: 21_540 }))
    expect(selectedAnalysisId()).toBe('analysis-2')
  })

  it('snaps prehistory markers to the first candle and shows durable order_type', async () => {
    vi.stubGlobal('WebSocket', TestWebSocket)
    render(<FuturesTerminal bootstrap={bootstrap} />)
    const socket = TestWebSocket.instances[0]!
    await act(async () => socket.open())
    await act(async () =>
      socket.receive(
        envelope('snapshot', 0, {
          watermark: 0,
          state: {
            analyses: [
              {
                analysis_id: 'entry-analysis',
                action: 'LONG',
                reason_codes: ['c27_long_breakout'],
                decision_time_ms: 21_000_000,
              },
            ],
            orders: [
              {
                order_id: 'entry-order',
                decision_at_ms: 21_000_000,
                order_type: 'market_ioc',
                side: 'buy',
                state: 'cancelled',
                quantity_btc: '0.0099',
              },
            ],
            fills: [],
          },
        }),
      ),
    )
    expect(chartHarness.markerSets.at(-1)).toMatchObject([
      { id: 'entry-analysis', time: 21_540 },
    ])
    const selected = within(
      screen.getByRole('region', { name: 'Análisis seleccionado' }),
    )
    expect(selected.getByText('1/1/1970, 5:50:00 UTC')).toBeTruthy()
    expect(selected.getByText(/market_ioc\s*·\s*buy/)).toBeTruthy()
  })
})

describe('FuturesTerminal on the live gateway with paper execution', () => {
  const T0 = 1_800_000_000_000
  const liveBootstrap = (status = 'running'): TerminalBootstrap => ({
    schema_version: 1,
    mode: 'paper_live',
    source: 'kraken-public-live-stream.v1',
    active_run_id: 'live-market-view',
    market: { status: 'live', last_received_at: T0 + 125, funding: 'unknown' },
    engine: {
      status,
      reason: 'paper_execution_active',
      commands: 'unavailable',
    },
    terminal_market: {
      schema_version: 'futures-terminal-market.v1',
      as_of_ms: T0,
      interval_ms: 60_000,
      candles: [-3, -2, -1].map((offset) => ({
        time_ms: T0 + offset * 60_000,
        open: '100000',
        high: '100050',
        low: '99950',
        close: '100010',
        volume_btc: '0.5',
        closed: true,
      })),
    },
  })
  const live = (seq: number, type: string, data: Record<string, unknown>) =>
    envelope(type, seq, data, T0 + seq, 'live-market-view')
  const analysis = (index: number, action: string) => ({
    analysis_id: `verdict-hash-${index}`,
    decision_time_ms: T0 - (3 - index) * 60_000 + 3_000,
    action,
    selector: {
      action,
      strategy_id: action === 'WAIT' ? null : 'c25-pullback-perp-v1',
      reason_code: action === 'WAIT' ? 'no_proposal' : 'c25_long',
    },
    selected_strategy_id: action === 'WAIT' ? null : 'c25-pullback-perp-v1',
    runtime_version: 'futures-verdict.v1',
    proposals: [],
  })
  const state = {
    run_id: 'live-market-view',
    state_version: 0,
    engine: {
      status: 'running',
      reason: 'paper_execution_active',
      commands: 'unavailable',
    },
    account: {
      cash_usd: '9999.50494555',
      equity_usd: '10000.49',
      realized_gross_usd: '0',
      fees_usd: '0.49505445',
      funding_paid_usd: '0',
      funding_complete: true,
      net_usd: '-0.49505445',
    },
    position: {
      side: 'long',
      quantity_btc: '0.0099',
      entry_price_usd_per_btc: '100011',
    },
    orders: [
      {
        order_id: 'o1',
        side: 'buy',
        type: 'entry',
        state: 'filled',
        status: 'filled',
        quantity_btc: '0.0099',
      },
      {
        order_id: 'o0',
        side: 'buy',
        type: 'entry',
        state: 'rejected',
        status: 'rejected',
        reason_code: 'target_does_not_clear_cost_buffer',
      },
    ],
    fills: [
      {
        fill_id: 'fill:3',
        order_id: 'o1',
        side: 'buy',
        quantity_btc: '0.0099',
        price_usd_per_btc: '100011',
      },
    ],
    analyses: [analysis(1, 'WAIT'), analysis(2, 'LONG'), analysis(3, 'SHORT')],
    market: {
      feed: 'ticker',
      event_time: T0,
      received_at: T0 + 100,
      normalized: { type: 'ticker', last: '100123.45' },
    },
  }

  async function renderLive(snapshotState: Record<string, unknown> = state) {
    vi.stubGlobal('WebSocket', TerminalSocket)
    render(
      <FuturesTerminal
        bootstrap={liveBootstrap(
          String(record(snapshotState.engine).status ?? 'running'),
        )}
      />,
    )
    await waitFor(() => expect(TerminalSocket.latest).toBeDefined())
    TerminalSocket.latest!.publish(
      live(0, 'snapshot', { watermark: 0, state: snapshotState }),
    )
    await screen.findByText('Saldo USD')
  }

  afterEach(() => {
    cleanup()
    chartHarness.markerSets = []
    vi.unstubAllGlobals()
  })

  it('shows account, position, orders, fills and analyses instead of the engine-off notice', async () => {
    await renderLive()
    expect(screen.queryByText(/Motor de decisiones apagado/)).toBeNull()
    expect(screen.getByText('long · 0.0099 BTC')).toBeTruthy()
    expect(screen.getByText(/10\.000,49/)).toBeTruthy()
    expect(screen.getByText('Posiciones y operaciones')).toBeTruthy()
    expect(screen.getAllByText(/0\.0099 · o1/).length).toBeGreaterThan(0)
    expect(screen.getByText(/Ejecución buy/)).toBeTruthy()
    expect(screen.getByText('Decisiones del motor')).toBeTruthy()
    expect(screen.getByLabelText('Decisión seleccionada')).toBeTruthy()
    expect(screen.getByText(/Motor paper: en marcha/)).toBeTruthy()
    // The rejected order says why; the filled one is in Spanish.
    expect(
      screen.getByText(
        /Cantidad no disponible · o0 · target does not clear cost buffer/,
      ),
    ).toBeTruthy()
    expect(screen.getByText('Ejecutada')).toBeTruthy()
    expect(screen.getByText('Rechazada')).toBeTruthy()
  })

  it('draws verdict markers for entry verdicts only, none before the first candle or rebuilt from a backfill', async () => {
    await renderLive({
      ...state,
      analyses: [
        {
          ...analysis(0, 'LONG'),
          analysis_id: 'verdict-hash-old',
          decision_time_ms: T0 - 3_600_000,
        },
        {
          ...analysis(0, 'LONG'),
          analysis_id: 'verdict-hash-backfill',
          knowledge_lag_ms: 3_600_000,
        },
        ...state.analyses,
      ],
    })
    const markers = chartHarness.markerSets.at(-1)!
    // WAIT verdicts (one per minute) would only clutter the chart.
    expect(markers.map((marker) => marker.id)).toEqual([
      'verdict-hash-2',
      'verdict-hash-3',
    ])
    expect(markers.map((marker) => marker.shape)).toEqual([
      'arrowUp',
      'arrowDown',
    ])
  })

  it('keeps pause, resume and close visibly disabled with the PS-06 notice, and sends nothing', async () => {
    await renderLive()
    const socket = TerminalSocket.latest!
    const send = vi.spyOn(socket, 'send')
    for (const name of [
      'Pausar entradas',
      'Reanudar entradas',
      'Cerrar posición',
    ]) {
      const button = screen.getByRole('button', { name }) as HTMLButtonElement
      expect(button.disabled).toBe(true)
      button.click()
    }
    expect(
      screen.queryByRole('button', { name: 'Iniciar simulación' }),
    ).toBeNull()
    expect(
      screen.queryByRole('button', { name: 'Nueva cuenta/run' }),
    ).toBeNull()
    expect(screen.getByText(/llegarán en PS-06/)).toBeTruthy()
    expect(send).not.toHaveBeenCalled()
  })

  it('applies streamed verdicts, orders, fills and account updates in seq order', async () => {
    await renderLive({
      ...state,
      analyses: [],
      orders: [],
      fills: [],
      position: null,
    })
    const socket = TerminalSocket.latest!
    await act(async () => {
      socket.publish(
        live(1, 'analysis.completed', { analysis: analysis(4, 'LONG') }),
      )
      socket.publish(
        live(2, 'order.updated', {
          order: { order_id: 'o9', side: 'buy', state: 'open', status: 'open' },
        }),
      )
      socket.publish(
        live(3, 'order.updated', {
          order: {
            order_id: 'o9',
            side: 'buy',
            state: 'filled',
            status: 'filled',
            quantity_btc: '0.01',
          },
        }),
      )
      socket.publish(
        live(4, 'fill.created', {
          fill: {
            fill_id: 'fill:9',
            order_id: 'o9',
            side: 'buy',
            quantity_btc: '0.01',
            price_usd_per_btc: '100000',
          },
        }),
      )
      socket.publish(
        live(5, 'position.updated', {
          position: {
            side: 'long',
            quantity_btc: '0.01',
            entry_price_usd_per_btc: '100000',
          },
        }),
      )
    })
    expect(await screen.findByText('long · 0.01 BTC')).toBeTruthy()
    expect(screen.getAllByText(/0\.01 · o9/).length).toBe(1)
    expect(screen.getByText(/Ejecución buy/)).toBeTruthy()
    expect(screen.getByLabelText('Decisión seleccionada')).toBeTruthy()
    expect(screen.queryByText(/Se detectó un salto/)).toBeNull()
  })

  it.each([
    ['starting', /Motor paper: arrancando/],
    ['idle', /Motor paper: inactivo/],
    ['unavailable', /Motor paper: no disponible/],
  ])('reports the %s engine without calling it off', async (status, label) => {
    await renderLive({ ...state, engine: { ...state.engine, status } })
    expect(screen.getByText(label)).toBeTruthy()
    expect(screen.queryByText(/Motor de decisiones apagado/)).toBeNull()
  })

  it('explains in the analyses area and engine line that Python is missing', async () => {
    await renderLive({
      ...state,
      analyses: [],
      engine: {
        status: 'unavailable',
        reason: 'python_unavailable',
        commands: 'unavailable',
      },
    })
    expect(
      screen.getByText(
        /Servicio de veredicto y ejecución paper no disponibles: no se encontró Python 3\.9\+ \(configurá BALANCITA_PYTHON\)/,
      ),
    ).toBeTruthy()
    expect(screen.getByText(/Motor paper: no disponible/)).toBeTruthy()
    expect(screen.queryByText('Aún no hay análisis registrados.')).toBeNull()
  })

  it('explains that Python was found but its SQLite is too old', async () => {
    await renderLive({
      ...state,
      analyses: [],
      engine: {
        status: 'unavailable',
        reason: 'python_sqlite_too_old',
        commands: 'unavailable',
      },
    })
    expect(
      screen.getByText(
        /Python encontrado pero su SQLite es anterior a 3\.37 \(necesario para tablas STRICT\): instalá Python desde python\.org o Homebrew, o configurá BALANCITA_PYTHON\./,
      ),
    ).toBeTruthy()
  })

  it('waits for the first verdict while the engine starts with no analyses', async () => {
    await renderLive({
      ...state,
      analyses: [],
      engine: {
        status: 'starting',
        reason: 'account_db_not_ready',
        commands: 'unavailable',
      },
    })
    expect(screen.getByText(/Esperando el primer veredicto/)).toBeTruthy()
    expect(screen.queryByText('Aún no hay análisis registrados.')).toBeNull()
  })

  it('keeps the plain empty message for a running engine without analyses', async () => {
    await renderLive({ ...state, analyses: [] })
    expect(screen.getByText('Aún no hay análisis registrados.')).toBeTruthy()
    expect(screen.queryByText(/Esperando el primer veredicto/)).toBeNull()
  })

  it('follows an engine.status event from starting to running', async () => {
    await renderLive({
      ...state,
      engine: { ...state.engine, status: 'starting' },
    })
    await act(async () => {
      TerminalSocket.latest!.publish(
        live(1, 'engine.status', {
          status: 'running',
          reason: 'paper_execution_active',
          commands: 'unavailable',
        }),
      )
    })
    expect(await screen.findByText(/Motor paper: en marcha/)).toBeTruthy()
  })
})

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {}
}

function selectedAnalysisId(): string | undefined {
  const panel = screen.getByRole('region', { name: 'Análisis seleccionado' })
  return panel.querySelectorAll('dd')[0]?.textContent ?? undefined
}

function envelope(
  type: string,
  seq: number,
  data: Record<string, unknown>,
  eventTime = 21_600_000 + seq,
  runId = bootstrap.active_run_id,
): TerminalEnvelope {
  return {
    schema_version: 1,
    event_id: `event-${runId}-${seq}-${type}`,
    stream_id: `stream-${runId}`,
    run_id: runId,
    seq,
    type,
    instrument_id: 'kraken-futures:PF_XBTUSD',
    event_time: eventTime,
    published_at: eventTime,
    data,
  }
}
