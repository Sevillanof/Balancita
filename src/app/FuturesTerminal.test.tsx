import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import FuturesTerminal from './FuturesTerminal.tsx'
import type {
  TerminalBootstrap,
  TerminalEnvelope,
} from '../features/connected-trading/infrastructure/terminal-stream-client.ts'
import { parseTerminalEnvelope } from '../features/connected-trading/infrastructure/terminal-stream-client.ts'
import { reasonLabel } from './terminal-copy.ts'

// The default list of approved strategies is empty (the Terminal shows only
// Qwen); these tests exercise the verdict rendering itself.
vi.mock('./terminal-approved.ts', () => ({
  isApprovedAnalysis: () => true,
  approvedChartData: <T,>(input: T) => input,
}))
import healthHealthy from '../../docs/mission-control/b1/ejemplo-saludable.json'

type ChartClickParameter = {
  hoveredInfo?: { objectId?: string }
  hoveredObjectId?: string
  time?: number
}

const chartHarness = vi.hoisted(() => ({
  clickHandlers: [] as Array<(parameter: ChartClickParameter) => void>,
  markerSets: [] as Array<Record<string, unknown>[]>,
  priceLines: [] as Array<Record<string, unknown>>,
}))

vi.mock('lightweight-charts', () => {
  const priceScale = { applyOptions() {} }
  const series = {
    setData() {},
    update() {},
    priceToCoordinate: () => null,
    priceScale: () => priceScale,
    createPriceLine: (options: Record<string, unknown>) => {
      chartHarness.priceLines.push(options)
      return {}
    },
    removePriceLine() {},
    applyOptions() {},
  }
  const timeScale = {
    getVisibleLogicalRange: () => null,
    setVisibleLogicalRange() {},
    fitContent() {},
    scrollToRealTime() {},
    subscribeVisibleLogicalRangeChange() {},
    unsubscribeVisibleLogicalRangeChange() {},
    timeToCoordinate: () => null,
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
  mode: 'paper_live',
  source: 'kraken-public-live-stream.v1',
  active_run_id: 'live-market-view',
  engine: { status: 'off', commands: 'unavailable' },
  terminal_market: {
    schema_version: 'futures-terminal-market.v1',
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

/** The run and engine details live in the status chip's inspector. */
function openStatus() {
  fireEvent.click(screen.getByTestId('health-indicator'))
}

describe('FuturesTerminal presentation', () => {
  afterEach(() => {
    cleanup()
    TestWebSocket.instances = []
    chartHarness.clickHandlers = []
    chartHarness.markerSets = []
    chartHarness.priceLines = []
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
    openStatus()
    expect(
      screen.getByText(/Evento .* UTC · recibido .* UTC · hace \d+ s/),
    ).toBeTruthy()
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
    expect(screen.queryByText('Herramientas de simulación')).toBeNull()
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

  it('renders the entries-paused analysis reason in Spanish and reports a command that was not applied', async () => {
    vi.stubGlobal('WebSocket', TestWebSocket)
    render(
      <FuturesTerminal
        bootstrap={{
          ...bootstrap,
          engine: { status: 'running', commands: 'unavailable' },
        }}
      />,
    )
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
})

describe('FuturesTerminal on the live gateway with paper execution', () => {
  const T0 = 1_800_000_000_000
  // Minute offsets (from T0) of the candles the live gateway delivers.
  let candleOffsets = [-3, -2, -1, 0]
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
      candles: candleOffsets.map((offset) => ({
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
    candleOffsets = [-3, -2, -1, 0]
    chartHarness.priceLines = []
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
    openStatus()
    expect(screen.getByText(/Libro D \(histórico, solo lectura\)/)).toBeTruthy()
    // The retired book is history: its status never reads as a healthy signal.
    expect(
      screen
        .getByText(/Libro D \(histórico, solo lectura\)/)
        .getAttribute('data-tone'),
    ).toBe('nodata')
    // The rejected order says why; the filled one is in Spanish.
    expect(
      screen.getByText(
        /Cantidad no disponible · o0 · target does not clear cost buffer/,
      ),
    ).toBeTruthy()
    expect(screen.getByText('Ejecutada')).toBeTruthy()
    expect(screen.getByText('Rechazada')).toBeTruthy()
  })

  it('draws verdict markers (proposals as arrows, WAIT as a grey circle), none before the first candle or rebuilt from a backfill', async () => {
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
    // The chart paints its markers in an effect, after the account renders:
    // wait for exactly the expected set, not merely for some set to exist.
    await waitFor(() =>
      expect(
        chartHarness.markerSets.at(-1)?.map((marker) => marker.id),
      ).toEqual(['verdict-hash-1', 'verdict-hash-2', 'verdict-hash-3']),
    )
    const markers = chartHarness.markerSets.at(-1)!
    expect(markers.map((marker) => marker.shape)).toEqual([
      'circle',
      'arrowUp',
      'arrowDown',
    ])
    // A proposal is not an operation: the label says so.
    expect(
      markers.map((marker) => String(marker.text).replace(' ◀', '')),
    ).toEqual(['W', 'C25 LONG', 'C25 SHORT propuesta'])
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
    ['starting', /Libro D \(histórico, solo lectura\)/],
    ['idle', /Libro D \(histórico, solo lectura\)/],
    ['unavailable', /Libro D \(histórico\): no disponible/],
  ])('reports the %s engine without calling it off', async (status, label) => {
    await renderLive({ ...state, engine: { ...state.engine, status } })
    openStatus()
    expect(screen.getAllByText(label).length).toBeGreaterThan(0)
    expect(screen.queryByText(/Motor de decisiones apagado/)).toBeNull()
  })

  it.each(['running', 'starting', 'idle', 'unavailable'])(
    'never shows the retired book D as running or active (%s)',
    async (status) => {
      await renderLive({ ...state, engine: { ...state.engine, status } })
      openStatus()
      const chip = screen.getByText(/^Libro D \(histórico/)
      expect(chip.textContent).not.toMatch(
        /en marcha|ejecución paper activa|ejecución activa|arrancando|inactivo|Motor paper/,
      )
      expect(chip.getAttribute('data-tone')).toBe('nodata')
    },
  )

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
    openStatus()
    expect(
      screen.getAllByText(/Libro D \(histórico\): no disponible/).length,
    ).toBeGreaterThan(0)
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
    openStatus()
    expect(
      await screen.findByText(/Libro D \(histórico, solo lectura\)/),
    ).toBeTruthy()
  })

  describe('selection between chart, history and decisions (Fase 2.7)', () => {
    // The chart paints its markers in an effect after the first render: wait
    // for them (and for the click handler) before reading or clicking.
    const renderReady = async (
      snapshotState: Record<string, unknown> = state,
    ) => {
      await renderLive(snapshotState)
      await waitFor(() => {
        expect(chartHarness.clickHandlers.length).toBeGreaterThan(0)
        expect(chartHarness.markerSets.at(-1)?.length).toBeGreaterThan(0)
      })
    }
    // A click with no subscribed handler would be a silent no-op and the
    // default selection would then fail a later assertion: fail right here.
    const clickMarker = (id: string) =>
      act(async () => {
        const handler = chartHarness.clickHandlers.at(-1)
        if (!handler) throw new Error('the chart has no click handler yet')
        handler({ hoveredObjectId: id })
      })
    const pickRow = (id: string) =>
      act(async () =>
        screen
          .getByRole('button', { name: `Seleccionar análisis ${id}` })
          .click(),
      )
    const marker = (id: string) =>
      chartHarness.markerSets.at(-1)?.find((item) => item.id === id)
    const detail = () => within(screen.getByLabelText('Decisión seleccionada'))
    const notes = () =>
      screen.queryAllByTestId('decision-limit').map((n) => n.textContent)

    it('opens the detail of the decision picked on the chart and highlights its row and marker', async () => {
      await renderReady()
      // Default: the newest decision, a SHORT.
      expect(marker('verdict-hash-3')?.text).toMatch(/◀/)
      await clickMarker('verdict-hash-2')
      expect(detail().getByText('LONG')).toBeTruthy()
      expect(
        screen
          .getByRole('button', { name: 'Seleccionar análisis verdict-hash-2' })
          .getAttribute('aria-pressed'),
      ).toBe('true')
      expect(marker('verdict-hash-2')?.text).toMatch(/◀/)
      expect(marker('verdict-hash-3')?.text).not.toMatch(/◀/)
      expect(notes()).toEqual([])
    })

    it('highlights the right marker when a history row is picked', async () => {
      await renderReady()
      await clickMarker('verdict-hash-2')
      await pickRow('verdict-hash-3')
      expect(detail().getByText('SHORT')).toBeTruthy()
      expect(marker('verdict-hash-3')?.text).toMatch(/◀/)
      expect(marker('verdict-hash-2')?.text).not.toMatch(/◀/)
    })

    it('ignores a click on a marker that is not one of this product’s decisions', async () => {
      await renderReady()
      await clickMarker('verdict-hash-2')
      // A foreign id and an exit marker leave the current selection
      // untouched (no fallback to the newest).
      await clickMarker('verdict-of-another-product')
      await clickMarker('exit:order-1')
      expect(detail().getByText('LONG')).toBeTruthy()
      expect(marker('verdict-hash-2')?.text).toMatch(/◀/)
      expect(marker('verdict-hash-3')?.text).not.toMatch(/◀/)
    })

    describe('a picked EJEC. marker shows its own verifiable facts', () => {
      const fillOf = (id: number, extra = {}) => ({
        fill_id: `fill:${id}`,
        order_id: 'order-partial',
        side: 'buy',
        quantity_btc: '0.2',
        price_usd_per_btc: '100011',
        reduce_only: false,
        event_time_ms: T0 - 90_000 + 123,
        ...extra,
      })
      const withPartialFills = () => ({
        ...state,
        quantity_unit: 'BTC',
        orders: [
          {
            order_id: 'order-partial',
            side: 'buy',
            state: 'filled',
            reduce_only: false,
          },
        ],
        fills: [
          fillOf(7),
          fillOf(8, {
            quantity_btc: '0.3',
            price_usd_per_btc: undefined,
            event_time_ms: T0 - 70_000 + 456,
          }),
          fillOf(9, { side: 'sell', quantity_btc: '0.4' }),
        ],
      })
      const fillDetail = () => screen.queryByLabelText('Ejecución seleccionada')

      it('clicking the marker of a fill opens fill_id, order_id, UTC time, quantity, direction and source', async () => {
        await renderReady(withPartialFills())
        expect(fillDetail()).toBeNull()
        await clickMarker('fill:7')
        const facts = within(fillDetail()!)
        expect(facts.getByText('fill:7')).toBeTruthy()
        expect(facts.getByText('order-partial')).toBeTruthy()
        expect(facts.getByText('2027-01-15 07:58:30.123 UTC')).toBeTruthy()
        expect(facts.getByText('0.2 BTC')).toBeTruthy()
        expect(facts.getByText('LONG (compra)')).toBeTruthy()
        expect(facts.getByText('100011 USD')).toBeTruthy()
        expect(facts.getByText('Histórico · Gateway D')).toBeTruthy()
        expect(marker('fill:7')?.text).toMatch(/◀/)
        expect(marker('fill:8')?.text).not.toMatch(/◀/)
      })

      it('shows each partial fill of the same order on its own and clears the previous one', async () => {
        await renderReady(withPartialFills())
        await clickMarker('fill:7')
        await clickMarker('fill:8')
        const facts = within(fillDetail()!)
        expect(facts.getByText('fill:8')).toBeTruthy()
        expect(facts.queryByText('fill:7')).toBeNull()
        expect(facts.getByText('order-partial')).toBeTruthy()
        expect(facts.getByText('2027-01-15 07:58:50.456 UTC')).toBeTruthy()
        expect(facts.getByText('0.3 BTC')).toBeTruthy()
        // The fill carries no price: it says so instead of inventing one.
        expect(facts.getByText('No disponible')).toBeTruthy()
        await clickMarker('fill:9')
        const sell = within(fillDetail()!)
        expect(sell.getByText('SHORT (venta)')).toBeTruthy()
        expect(sell.getByText('0.4 BTC')).toBeTruthy()
      })

      it('is independent of the decisions: no row, detail or marker of a decision changes', async () => {
        await renderReady(withPartialFills())
        const pressed = () =>
          screen
            .getAllByRole('button', { name: /^Seleccionar análisis / })
            .map((button) => button.getAttribute('aria-pressed'))
        const before = pressed()
        const decisionBefore = detail().getByText('SHORT')
        expect(decisionBefore).toBeTruthy()
        await clickMarker('fill:7')
        expect(pressed()).toEqual(before)
        expect(detail().getByText('SHORT')).toBeTruthy()
        expect(fillDetail()!.textContent).not.toMatch(/verdict-hash/)
        expect(fillDetail()!.textContent).toMatch(/ninguna decisión/)
      })

      it('clears when another marker, a history row, the same marker or Cerrar is picked', async () => {
        await renderReady(withPartialFills())
        await clickMarker('fill:7')
        expect(fillDetail()).not.toBeNull()
        await clickMarker('verdict-hash-2')
        expect(fillDetail()).toBeNull()
        expect(detail().getByText('LONG')).toBeTruthy()
        await clickMarker('fill:7')
        await pickRow('verdict-hash-3')
        expect(fillDetail()).toBeNull()
        await clickMarker('fill:7')
        await clickMarker('fill:7')
        expect(fillDetail()).toBeNull()
        await clickMarker('fill:8')
        await act(async () =>
          within(fillDetail()!).getByRole('button', { name: 'Cerrar' }).click(),
        )
        expect(fillDetail()).toBeNull()
        expect(marker('fill:8')?.text).not.toMatch(/◀/)
      })

      it('leaves exit and unknown markers as they were', async () => {
        await renderReady(withPartialFills())
        await clickMarker('fill:7')
        await clickMarker('exit:order-1')
        await clickMarker('not-a-marker')
        expect(within(fillDetail()!).getByText('fill:7')).toBeTruthy()
      })
    })

    describe('scroll of the selected row', () => {
      afterEach(() => {
        vi.restoreAllMocks()
        delete (Element.prototype as Partial<Element>).scrollIntoView
      })
      const rect = (top: number, bottom: number) =>
        ({
          top,
          bottom,
          left: 0,
          right: 0,
          width: 0,
          height: bottom - top,
        }) as DOMRect
      const spies = () => {
        const pageScroll = vi.fn()
        Element.prototype.scrollIntoView = pageScroll
        const list = document.querySelector<HTMLElement>(
          '.connected-terminal__decision-list',
        )!
        return { pageScroll, list }
      }

      it('does not scroll anything when the Terminal loads', async () => {
        const pageScroll = vi.fn()
        Element.prototype.scrollIntoView = pageScroll
        const windowScroll = vi
          .spyOn(window, 'scrollTo')
          .mockImplementation(() => {})
        await renderReady()
        const list = document.querySelector<HTMLElement>(
          '.connected-terminal__decision-list',
        )!
        expect(list.scrollTop).toBe(0)
        expect(pageScroll).not.toHaveBeenCalled()
        expect(windowScroll).not.toHaveBeenCalled()
      })

      it('moves only the list’s own scroll, never the page', async () => {
        await renderReady()
        const { pageScroll, list } = spies()
        const windowScroll = vi
          .spyOn(window, 'scrollTo')
          .mockImplementation(() => {})
        vi.spyOn(list, 'getBoundingClientRect').mockReturnValue(rect(100, 300))
        // Row below the visible part of the list, then above it.
        const row = () =>
          screen.getByRole('button', {
            name: 'Seleccionar análisis verdict-hash-2',
          })
        vi.spyOn(
          HTMLElement.prototype,
          'getBoundingClientRect',
        ).mockImplementation(function (this: HTMLElement) {
          return this === list ? rect(100, 300) : rect(340, 380)
        })
        await clickMarker('verdict-hash-2')
        expect(row().getAttribute('aria-pressed')).toBe('true')
        expect(list.scrollTop).toBe(80)
        vi.spyOn(
          HTMLElement.prototype,
          'getBoundingClientRect',
        ).mockImplementation(function (this: HTMLElement) {
          return this === list ? rect(100, 300) : rect(60, 100)
        })
        await clickMarker('verdict-hash-3')
        expect(list.scrollTop).toBe(40)
        expect(pageScroll).not.toHaveBeenCalled()
        expect(windowScroll).not.toHaveBeenCalled()
      })
    })

    it('marks a WAIT decision too, and says nothing for any of them', async () => {
      await renderReady()
      await pickRow('verdict-hash-1')
      expect(marker('verdict-hash-1')?.text).toMatch(/WAIT ◀/)
      expect(notes()).toEqual([])
      await pickRow('verdict-hash-2')
      expect(notes()).toEqual([])
    })

    it('says why rebuilt and out-of-period decisions have no marker', async () => {
      await renderReady({
        ...state,
        analyses: [
          {
            ...analysis(2, 'LONG'),
            analysis_id: 'verdict-old',
            decision_time_ms: T0 - 3_600_000,
          },
          {
            ...analysis(2, 'LONG'),
            analysis_id: 'verdict-backfill',
            knowledge_lag_ms: 3_600_000,
          },
          analysis(3, 'SHORT'),
        ],
      })
      await pickRow('verdict-old')
      expect(marker('verdict-old')).toBeUndefined()
      expect(notes()).toEqual([
        'Esta decisión no tiene marcador en el gráfico: ocurrió antes de las velas visibles.',
      ])
      await pickRow('verdict-backfill')
      expect(marker('verdict-backfill')).toBeUndefined()
      expect(notes()[0]).toMatch(/se reconstruyó a partir de un backfill/)
    })

    it('never pins a decision to an earlier candle when its minute has none (hole)', async () => {
      candleOffsets = [-4, -3, -1, 0]
      await renderReady({
        ...state,
        analyses: [
          analysis(1, 'LONG'),
          analysis(2, 'LONG'),
          analysis(3, 'SHORT'),
        ],
      })
      // analysis(1) falls in the missing minute: no marker on candle -3.
      expect(marker('verdict-hash-1')).toBeUndefined()
      expect(marker('verdict-hash-2')).toBeDefined()
      expect(marker('verdict-hash-3')).toBeDefined()
      // It stays in the history and says why it is not on the chart.
      await pickRow('verdict-hash-1')
      expect(notes()).toEqual([
        'Esta decisión no tiene marcador en el gráfico: no hay vela de su minuto en el gráfico (hueco en las velas); sigue en el historial.',
      ])
    })

    it('does not glue a decision after the last candle to it', async () => {
      candleOffsets = [-3, -2, -1]
      await renderReady({
        ...state,
        analyses: [analysis(2, 'LONG'), analysis(3, 'SHORT')],
      })
      expect(marker('verdict-hash-2')).toBeDefined()
      expect(marker('verdict-hash-3')).toBeUndefined()
      await pickRow('verdict-hash-3')
      expect(notes()).toEqual([
        'Esta decisión no tiene marcador en el gráfico: ocurrió después de la última vela disponible.',
      ])
    })

    it('uses the verdict bucket, not the later decision time, to find its candle', async () => {
      // Decided 3 s into minute 0, but about the closed bucket of minute -1.
      await renderReady({
        ...state,
        analyses: [
          {
            ...analysis(3, 'LONG'),
            bucket_start_ms: T0 - 60_000,
          },
        ],
      })
      expect(marker('verdict-hash-3')).toBeDefined()
      expect(
        chartHarness.markerSets.at(-1)?.find((m) => m.id === 'verdict-hash-3')
          ?.time,
      ).toBe((T0 - 60_000) / 1000)
    })

    it('opens a decision older than the 100 listed and says it is not in the list', async () => {
      const many = Array.from({ length: 101 }, (_, index) => ({
        ...analysis(2, 'LONG'),
        analysis_id: `verdict-${index}`,
        decision_time_ms: T0 - 120_000 + index * 100,
      }))
      await renderReady({ ...state, analyses: many })
      await clickMarker('verdict-0')
      expect(detail().getByText('LONG')).toBeTruthy()
      expect(marker('verdict-0')?.text).toMatch(/◀/)
      expect(notes()).toEqual([
        'Esta decisión no aparece en la lista: solo se muestran las últimas 100.',
      ])
    })
  })

  describe('provenance and separation (Fase 2.4)', () => {
    const history = () =>
      within(screen.getByRole('group', { name: 'Historial del gateway' }))
    const current = () =>
      within(screen.getByRole('region', { name: 'Posición actual' }))

    it('shows the current position as «No disponible» and keeps D-book data only inside the labelled history', async () => {
      await renderLive()
      expect(current().getByText('Posición actual: No disponible')).toBeTruthy()
      // The D-book position, account and orders live in the history section.
      expect(history().getByText('Histórico')).toBeTruthy()
      expect(history().getByText('long · 0.0099 BTC')).toBeTruthy()
      expect(history().getByText('Saldo USD')).toBeTruthy()
      expect(history().getByText('Posiciones y operaciones')).toBeTruthy()
      // ...and never inside the current-position block.
      expect(current().queryByText(/long/)).toBeNull()
      expect(current().queryByText('Saldo USD')).toBeNull()
    })

    it('does not confuse «No disponible» with «Sin posición abierta»', async () => {
      await renderLive({ ...state, position: null })
      expect(current().getByText('Posición actual: No disponible')).toBeTruthy()
      expect(current().queryByText(/^Sin posición abierta/)).toBeNull()
      // The empty D book is stated as such, inside the history only.
      expect(
        history().getAllByText(/Sin posición abierta en el libro D/).length,
      ).toBeGreaterThan(0)
      expect(screen.queryByText('Sin posición abierta')).toBeNull()
      expect(screen.queryByText('Sin posición abierta.')).toBeNull()
    })

    it('states origin and run, and never invents the times or the experiment', async () => {
      await renderLive()
      const provenance = within(
        screen.getByRole('group', { name: 'Historial del gateway' }),
      ).getByLabelText('Procedencia de los datos')
      const rows = Object.fromEntries(
        [...provenance.querySelectorAll('div')].map((row) => [
          row.querySelector('dt')!.textContent,
          row.querySelector('dd')!.textContent,
        ]),
      )
      expect(rows).toEqual({
        Origen: 'Gateway · libro D retirado (lectura)',
        Experimento: 'No disponible',
        Run: 'live-market-view',
        'Hora del evento': 'No disponible',
        'Última actualización recibida': 'No disponible',
      })
    })

    it('ignores account, position, order and verdict events of another run', async () => {
      await renderLive()
      const socket = TerminalSocket.latest!
      const foreign = (seq: number, type: string, data: object) =>
        envelope(
          type,
          seq,
          data as Record<string, unknown>,
          T0 + seq,
          'other-run',
        )
      await act(async () => {
        socket.publish(
          foreign(1, 'account.updated', {
            account: { cash_usd: '1', equity_usd: '2', fees_usd: '3' },
          }),
        )
        socket.publish(
          foreign(2, 'position.updated', {
            position: { side: 'short', quantity_btc: '9' },
          }),
        )
        socket.publish(
          foreign(3, 'order.updated', {
            order: { order_id: 'foreign-order', side: 'sell' },
          }),
        )
        socket.publish(
          foreign(4, 'analysis.completed', { analysis: analysis(9, 'SHORT') }),
        )
      })
      expect(history().getByText('long · 0.0099 BTC')).toBeTruthy()
      expect(history().queryByText(/short/)).toBeNull()
      expect(history().queryByText(/foreign-order/)).toBeNull()
      expect(screen.queryByText(/verdict-hash-9/)).toBeNull()
      expect(screen.getByText(/10\.000,49/)).toBeTruthy()
    })

    it('marks each decision with its action so the list can colour it', async () => {
      await renderLive()
      const list = screen.getByRole('region', { name: 'Decisiones del motor' })
      for (const action of ['LONG', 'SHORT'])
        expect(
          within(list)
            .getAllByText(action)
            .some((node) => node.getAttribute('data-action') === action),
        ).toBe(true)
    })

    it('puts the tools in a secondary row below the chart, naming the run they act on', async () => {
      await renderLive()
      const secondary = screen.getByTestId('terminal-secondary')
      const layout = screen.getByTestId('approved-terminal-layout')
      expect(
        layout.compareDocumentPosition(secondary) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy()
      const tools = within(
        within(secondary).getByRole('region', {
          name: 'Herramientas de simulación',
        }),
      )
      expect(tools.getByText('live-market-view')).toBeTruthy()
      expect(
        tools.getByText(/no controlan los experimentos forward/),
      ).toBeTruthy()
      // The current-position block comes before the tools.
      const position = within(secondary).getByRole('region', {
        name: 'Posición actual',
      })
      expect(
        position.compareDocumentPosition(
          within(secondary).getByRole('region', {
            name: 'Herramientas de simulación',
          }),
        ) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy()
    })

    it('collapses the history at first and keeps its provenance once expanded', async () => {
      await renderLive()
      const details = screen.getByRole('group', {
        name: 'Historial del gateway',
      }) as HTMLDetailsElement
      expect(details.open).toBe(false)
      details.open = true
      expect(history().getByText('Histórico')).toBeTruthy()
      expect(
        history().getByText('Gateway · libro D retirado (lectura)'),
      ).toBeTruthy()
    })

    describe('chart', () => {
      const exit = (id: string, closedAt: number) => ({
        order_id: id,
        side: 'sell',
        type: 'exit',
        state: 'filled',
        status: 'filled',
        reduce_only: true,
        reason_code: 'protective_stop',
        closed_at_ms: closedAt,
      })
      const mixed = {
        ...state,
        position: { side: 'long', entry_price_usd_per_btc: '1111' },
        positions: [
          {
            side: 'long',
            product_id: 'PF_XBTUSD',
            entry_price_usd_per_btc: '100011',
            stop: '99000',
            target: '102000',
          },
          {
            side: 'short',
            product_id: 'PF_ETHUSD',
            entry_price_usd_per_btc: '3500',
            stop: '3600',
            target: '3300',
          },
        ],
        orders: [
          exit('in-period', T0 - 60_000),
          exit('before-period', T0 - 3_600_000),
          exit('after-period', T0 + 3_600_000),
        ],
      }
      const titles = () => chartHarness.priceLines.map((l) => l.title)
      const prices = () =>
        [...new Set(chartHarness.priceLines.map((l) => l.price))].filter(
          (price) => price !== undefined,
        )
      const exitMarkerIds = () =>
        (chartHarness.markerSets.at(-1) ?? [])
          .map((marker) => String(marker.id))
          .filter((id) => id.startsWith('exit:'))

      async function renderProduct(product?: string) {
        vi.stubGlobal('WebSocket', TerminalSocket)
        render(
          <FuturesTerminal bootstrap={liveBootstrap()} product={product} />,
        )
        await waitFor(() => expect(TerminalSocket.latest).toBeDefined())
        TerminalSocket.latest!.publish(
          live(0, 'snapshot', { watermark: 0, state: mixed }),
        )
        await screen.findByText('Saldo USD')
        // The chart paints lines and markers in effects after the render.
        await waitFor(() => {
          expect(chartHarness.priceLines.length).toBeGreaterThan(0)
          expect(chartHarness.markerSets.length).toBeGreaterThan(0)
        })
      }

      afterEach(() => {
        chartHarness.priceLines = []
      })

      it('draws only the lines of the selected product, ETH', async () => {
        await renderProduct('PF_ETHUSD')
        expect(prices()).toContain(3500)
        expect(prices()).not.toContain(100011)
        expect(prices()).not.toContain(1111)
      })

      it('draws only the lines of the selected product, BTC by default', async () => {
        await renderProduct()
        expect(prices()).toContain(100011)
        expect(prices()).not.toContain(3500)
      })

      it('labels every historical line and exit as «Histórico · Gateway D»', async () => {
        await renderProduct()
        const own = chartHarness.priceLines.filter((l) => l.title !== 'MARK')
        expect(own.length).toBeGreaterThan(0)
        for (const line of own)
          expect(String(line.title)).toMatch(/^Histórico · Gateway D · /)
        const markers = chartHarness.markerSets.flat()
        const exits = markers.filter((m) => String(m.id).startsWith('exit:'))
        expect(exits.length).toBeGreaterThan(0)
        for (const marker of exits)
          expect(String(marker.text ?? marker.label)).toMatch(
            /^Histórico · Gateway D · /,
          )
        expect(titles()).not.toContain('ENTRADA LARGO')
      })

      it('draws only exits inside the visible period', async () => {
        await renderProduct()
        expect(exitMarkerIds()).toEqual(['exit:in-period'])
      })
    })

    it('subscribes to the product shown, so no other product reaches the panels', async () => {
      const urls: string[] = []
      class UrlSocket extends TerminalSocket {
        constructor(url: string) {
          super()
          urls.push(url)
        }
      }
      vi.stubGlobal('WebSocket', UrlSocket)
      render(
        <FuturesTerminal bootstrap={liveBootstrap()} product="PF_ETHUSD" />,
      )
      await waitFor(() => expect(TerminalSocket.latest).toBeDefined())
      expect(urls).toHaveLength(1)
      expect(urls[0]).toContain('PF_ETHUSD')
      expect(urls[0]).not.toContain('PF_XBTUSD')
    })
  })

  describe('executed operations (EJEC.) come from the durable fills', () => {
    const fill = (id: number, order: string, extra = {}) => ({
      fill_id: `fill:${id}`,
      order_id: order,
      side: 'buy',
      quantity_btc: '0.2',
      price_usd_per_btc: '100011',
      reduce_only: false,
      event_time_ms: T0 - 90_000,
      ...extra,
    })
    const withFills = (fills: unknown[], orders: unknown[]) => ({
      ...state,
      quantity_unit: 'BTC',
      orders,
      fills,
    })
    const ejecIds = () =>
      (chartHarness.markerSets.at(-1) ?? [])
        .filter((m) => String(m.id).startsWith('fill:'))
        .map((m) => ({ id: m.id, text: String(m.text) }))

    it('draws one marker per fill, partial fills included, with the original ids and quantities', async () => {
      await renderLive(
        withFills(
          [
            fill(7, 'o1', { quantity_btc: '0.2', event_time_ms: T0 - 90_000 }),
            fill(8, 'o1', { quantity_btc: '0.3', event_time_ms: T0 - 70_000 }),
            fill(9, 'o1', { side: 'sell', reduce_only: true }),
          ],
          [
            {
              order_id: 'o1',
              side: 'buy',
              state: 'filled',
              reduce_only: false,
              strategy_id: 'c25-pullback-perp-v1',
            },
          ],
        ),
      )
      await waitFor(() =>
        expect(ejecIds().map((m) => m.id)).toEqual(['fill:7', 'fill:8']),
      )
      expect(ejecIds().map((m) => m.text)).toEqual([
        'Histórico · Gateway D · C25 EJ L',
        'Histórico · Gateway D · C25 EJ L',
      ])
    })

    it('does not draw a fill over another candle when its minute has none', async () => {
      candleOffsets = [-4, -3, -1, 0]
      await renderLive(
        withFills(
          [
            fill(7, 'o1', { quantity_btc: '0.2', event_time_ms: T0 - 90_000 }),
            fill(8, 'o1', { quantity_btc: '0.3', event_time_ms: T0 - 30_000 }),
            fill(9, 'o1', { quantity_btc: '0.1', event_time_ms: T0 - 20_000 }),
          ],
          [{ order_id: 'o1', side: 'buy', state: 'filled' }],
        ),
      )
      // fill:7 falls in the missing minute (-2); the two partial fills of the
      // candle that exists are still drawn, each with its own id.
      await waitFor(() =>
        expect(ejecIds().map((m) => m.id)).toEqual(['fill:8', 'fill:9']),
      )
    })

    it('does not invent a marker from a filled order that has no fill', async () => {
      await renderLive(
        withFills(
          [],
          [
            {
              order_id: 'o-orphan',
              side: 'buy',
              state: 'filled',
              status: 'filled',
              reduce_only: false,
              closed_at_ms: T0 - 90_000,
            },
          ],
        ),
      )
      await waitFor(() =>
        expect(chartHarness.markerSets.at(-1)?.length).toBeGreaterThan(0),
      )
      expect(ejecIds()).toEqual([])
    })

    it('names proposals, WAIT, EJEC. and exits in the visible legend', async () => {
      await renderLive()
      const legend = document.querySelector('.terminal-chart__legend')!
      expect(legend.textContent).toMatch(/propuesta LONG\/SHORT/)
      expect(legend.textContent).toMatch(/W = WAIT/)
      expect(legend.textContent).toMatch(/EJEC\. ejecución paper/)
      expect(legend.textContent).toMatch(/salida/)
      expect(legend.textContent).not.toMatch(/entrada larga|entrada corta/)
    })
  })

  describe('AHORA is current only with the socket, a valid gateway clock and B1', () => {
    const BUCKET = T0 - 60_000
    // The clock the browser and the gateway share in these tests.
    const AT = T0 + 10_000
    const healthBody = (bucket: number, generatedAtMs = AT - 5_000) => {
      const body = JSON.parse(JSON.stringify(healthHealthy))
      body.generated_at_ms = generatedAtMs
      const item = body.components
        .find((c: { id: string }) => c.id === 'decisions')
        .items.find((i: { product_id: string }) => i.product_id === 'PF_XBTUSD')
      item.bucket_start_ms = bucket
      return body
    }
    const ahoraState = {
      ...state,
      analyses: [
        {
          ...analysis(3, 'SHORT'),
          decision_time_ms: AT - 20_000,
          bucket_start_ms: BUCKET,
        },
      ],
    }
    let healthCalls = 0
    let healthBucket = BUCKET
    const stubFetch = () => {
      healthCalls = 0
      healthBucket = BUCKET
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string) => {
          const json = (body: unknown) =>
            new Response(JSON.stringify(body), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            })
          if (String(input).includes('/observability/health')) {
            healthCalls += 1
            return json(healthBody(healthBucket))
          }
          return new Response('{}', { status: 404 })
        }),
      )
    }
    const open = async (publishedAt = AT) => {
      vi.stubGlobal('WebSocket', TerminalSocket)
      render(
        <FuturesTerminal bootstrap={liveBootstrap()} product="PF_XBTUSD" />,
      )
      await waitFor(() => expect(TerminalSocket.latest).toBeDefined())
      TerminalSocket.latest!.publish(
        envelope(
          'snapshot',
          0,
          { watermark: 0, state: ahoraState },
          publishedAt,
          'live-market-view',
        ),
      )
      await screen.findByText('Saldo USD')
    }
    const label = () => screen.getByTestId('last-decision')

    beforeEach(() => {
      // Only the clock is faked: the sockets, timers and fetch stay real.
      vi.useFakeTimers({ toFake: ['Date'], now: AT })
      stubFetch()
      TerminalSocket.latest = undefined
    })
    afterEach(() => vi.useRealTimers())

    it('is current when connected, the clock is valid and B1 reads the same bucket', async () => {
      await open()
      expect(await screen.findByTestId('now-action')).toHaveTextContent('SHORT')
      expect(label()).not.toHaveTextContent('Sin confirmar')
    })

    it('falls back to «Sin confirmar» on disconnection and evaluates again from scratch on recovery', async () => {
      await open()
      await screen.findByTestId('now-action')
      const readsBefore = healthCalls
      const first = TerminalSocket.latest!
      act(() => first.onclose?.())
      await waitFor(() => expect(label()).toHaveTextContent('Sin confirmar'))
      expect(screen.queryByTestId('now-action')).toBeNull()
      expect(screen.getByTestId('now-blockers')).toHaveTextContent(
        'sin conexión WebSocket',
      )
      // The stream reconnects by itself: until it delivers a message of the
      // new connection there is no valid gateway clock, hence no «actual».
      await waitFor(() => expect(TerminalSocket.latest).not.toBe(first))
      expect(screen.queryByTestId('now-action')).toBeNull()
      await act(async () => {
        TerminalSocket.latest!.publish(
          envelope(
            'snapshot',
            0,
            { watermark: 0, state: ahoraState },
            AT,
            'live-market-view',
          ),
        )
      })
      // B1 was read again for the new connection, not reused.
      await waitFor(() => expect(healthCalls).toBeGreaterThan(readsBefore))
      expect(await screen.findByTestId('now-action')).toHaveTextContent('SHORT')
    })

    it('goes back to «Sin confirmar» when the gateway goes silent and its clock gets old', async () => {
      await open()
      await screen.findByTestId('now-action')
      // A minute and a half of silence: no heartbeat, B1 not refreshed.
      vi.setSystemTime(AT + 90_000)
      await waitFor(() => expect(label()).toHaveTextContent('Sin confirmar'), {
        timeout: 4_000,
      })
      expect(screen.getByTestId('now-blockers')).toHaveTextContent(
        'reloj del gateway',
      )
    })

    it('does not trust a gateway clock stamped in the future', async () => {
      await open(AT + 600_000)
      await waitFor(() => expect(healthCalls).toBeGreaterThan(0))
      await waitFor(() => expect(label()).toHaveTextContent('Sin confirmar'))
      expect(screen.queryByTestId('now-action')).toBeNull()
    })

    it('stays unconfirmed when B1 reads another bucket', async () => {
      healthBucket = BUCKET - 60_000
      await open()
      await waitFor(() => expect(healthCalls).toBeGreaterThan(0))
      await waitFor(() => expect(label()).toHaveTextContent('Sin confirmar'))
      expect(screen.getByTestId('now-blockers')).toHaveTextContent(
        'B1 no confirma',
      )
    })
  })
})

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {}
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
