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
  }
  const timeScale = {
    getVisibleLogicalRange: () => null,
    setVisibleLogicalRange() {},
    fitContent() {},
    scrollToRealTime() {},
  }
  const chart = {
    addSeries: () => series,
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
    chartHarness.clickHandlers = []
    chartHarness.markerSets = []
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
    ).toHaveLength(5)

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
        .getByRole('button', { name: 'Seleccionar análisis analysis-3' })
        .click(),
    )
    expect(selectedAnalysisId()).toBe('analysis-3')
    await act(async () => chartHarness.clickHandlers.at(-1)?.({ time: 21_540 }))
    expect(selectedAnalysisId()).toBe('analysis-4')
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

function selectedAnalysisId(): string | undefined {
  const panel = screen.getByRole('region', { name: 'Análisis seleccionado' })
  return panel.querySelectorAll('dd')[0]?.textContent ?? undefined
}

function envelope(
  type: string,
  seq: number,
  data: Record<string, unknown>,
  eventTime = 21_600_000 + seq,
): TerminalEnvelope {
  return {
    schema_version: 1,
    event_id: `event-${seq}-${type}`,
    stream_id: 'local-stream',
    run_id: bootstrap.active_run_id,
    seq,
    type,
    instrument_id: 'kraken-futures:PF_XBTUSD',
    event_time: eventTime,
    published_at: eventTime,
    data,
  }
}
