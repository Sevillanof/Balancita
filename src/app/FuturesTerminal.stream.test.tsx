import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import FuturesTerminal from './FuturesTerminal.tsx'
import type {
  TerminalBootstrap,
  TerminalEnvelope,
} from '../features/connected-trading/infrastructure/terminal-stream-client.ts'

/*
 * Characterization of the terminal's WebSocket protocol handling (Mission
 * Control Fase 2.1). These tests pin the CURRENT behavior of the effect in
 * FuturesTerminal.tsx so that extracting it into a hook (2.2) can be checked
 * against them. They describe what the code does today; they do not prescribe
 * it. Reconnection timing runs on fake timers.
 */

// The chart is irrelevant to protocol handling and heavy to mock.
vi.mock('./TerminalMarketChart.tsx', () => ({ default: () => null }))

class FakeSocket {
  static readonly OPEN = 1
  static instances: FakeSocket[] = []
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: ((message: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  sent: string[] = []

  readonly url: string

  constructor(url: string) {
    this.url = url
    FakeSocket.instances.push(this)
  }

  send(message: string) {
    this.sent.push(message)
  }

  open() {
    this.readyState = FakeSocket.OPEN
    this.onopen?.()
  }

  receive(event: TerminalEnvelope) {
    this.onmessage?.({ data: JSON.stringify(event) })
  }

  /** Server or network drop; also what the terminal does to resync. */
  close() {
    if (this.readyState === 3) return
    this.readyState = 3
    this.onclose?.()
  }

  get lastSent(): Record<string, unknown> {
    return JSON.parse(this.sent.at(-1)!) as Record<string, unknown>
  }
}

const RUN = 'run-1'
const bootstrap: TerminalBootstrap = {
  schema_version: 1,
  mode: 'paper_live',
  source: 'kraken-public-live-stream.v1',
  active_run_id: RUN,
  engine: { status: 'running' },
}

function envelope(
  type: string,
  seq: number,
  data: Record<string, unknown> = {},
  runId = RUN,
  eventId = `event-${runId}-${seq}-${type}`,
): TerminalEnvelope {
  return {
    schema_version: 1,
    event_id: eventId,
    stream_id: `stream-${runId}`,
    run_id: runId,
    seq,
    type,
    instrument_id: 'kraken-futures:PF_XBTUSD',
    event_time: 1_000 + seq,
    published_at: 1_000 + seq,
    data,
  }
}

const snapshot = (watermark = 0, runId = RUN, orders: unknown[] = []) =>
  envelope(
    'snapshot',
    0,
    {
      watermark,
      state: { state_version: 1, analyses: [], orders, fills: [] },
    },
    runId,
  )

const order = (id: string) =>
  envelope('order.updated', 0, {
    order: {
      order_id: id,
      side: 'buy',
      state: 'filled',
      status: 'filled',
      quantity_btc: '0.01',
    },
  })

/** An order event carrying the given seq, so each one shows up in the view. */
const orderAt = (seq: number, id: string, eventId?: string) => ({
  ...order(id),
  seq,
  event_id: eventId ?? `event-${RUN}-${seq}-order.updated`,
})

const live = () => FakeSocket.instances.at(-1)!

async function mountConnected() {
  render(<FuturesTerminal bootstrap={bootstrap} />)
  const socket = live()
  await act(async () => socket.open())
  await act(async () => socket.receive(snapshot(0)))
  return socket
}

/** Advances fake time inside act so state updates from timers flush. */
async function advance(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms)
  })
}

/** The run and engine details live in the status chip's inspector. */
function openStatus() {
  fireEvent.click(screen.getByTestId('health-indicator'))
}

describe('FuturesTerminal WebSocket protocol (characterization)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeSocket)
  })

  afterEach(() => {
    cleanup()
    FakeSocket.instances = []
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('subscribes on a first connection and resumes from the last seq after a plain drop', async () => {
    const socket = await mountConnected()
    expect(JSON.parse(socket.sent[0]!)).toEqual({
      schema_version: 1,
      type: 'subscribe',
      run_id: RUN,
    })
    await act(async () => socket.receive(orderAt(1, 'o1')))
    await act(async () => socket.receive(orderAt(2, 'o2')))

    await act(async () => socket.close())
    await advance(500)
    expect(FakeSocket.instances).toHaveLength(2)
    await act(async () => live().open())
    expect(live().lastSent).toEqual({
      schema_version: 1,
      type: 'resume',
      run_id: RUN,
      last_seq: 2,
    })
  })

  it('on resync.required closes the socket and reconnects with a full subscribe, not a resume', async () => {
    const socket = await mountConnected()
    await act(async () => socket.receive(orderAt(1, 'o1')))
    expect(screen.getAllByText(/0\.01 · o1/).length).toBeGreaterThan(0)

    await act(async () => socket.receive(envelope('resync.required', 2)))
    expect(socket.readyState).toBe(3)

    await advance(500)
    expect(FakeSocket.instances).toHaveLength(2)
    await act(async () => live().open())
    expect(live().lastSent).toMatchObject({ type: 'subscribe', run_id: RUN })
    expect(live().lastSent).not.toHaveProperty('last_seq')

    // The new snapshot replaces the view and restarts the sequence.
    await act(async () => live().receive(snapshot(7)))
    await act(async () => live().receive(orderAt(8, 'o8')))
    expect(screen.getAllByText(/0\.01 · o8/).length).toBeGreaterThan(0)
  })

  it('on a gap in seq reports it, drops the event, and resynchronizes with a full subscribe', async () => {
    const socket = await mountConnected()
    await act(async () => socket.receive(orderAt(1, 'o1')))

    // seq 3 arrives with 2 missing.
    await act(async () => socket.receive(orderAt(3, 'o3')))
    expect(
      screen.getAllByRole('alert').map((alert) => alert.textContent),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          'Se detectó un salto en el flujo; resincronizando.',
        ),
      ]),
    )
    expect(socket.readyState).toBe(3)
    expect(screen.queryByText(/0\.01 · o3/)).toBeNull()

    await advance(500)
    await act(async () => live().open())
    expect(live().lastSent).toMatchObject({ type: 'subscribe' })
    expect(live().lastSent).not.toHaveProperty('last_seq')

    // A fresh snapshot clears the gap message.
    await act(async () => live().receive(snapshot(3)))
    expect(screen.queryByText(/Se detectó un salto/)).toBeNull()
  })

  it('ignores an event whose seq was already applied, even with a new event_id', async () => {
    const socket = await mountConnected()
    await act(async () => socket.receive(orderAt(1, 'o1')))
    await act(async () => socket.receive(orderAt(2, 'o2')))

    // Older seq, never-seen id: only the seq check can drop it.
    await act(async () =>
      socket.receive(orderAt(1, 'oStale', 'event-replayed-1')),
    )
    await act(async () =>
      socket.receive(orderAt(2, 'oStale2', 'event-replayed-2')),
    )

    expect(screen.queryByText(/oStale/)).toBeNull()
    expect(screen.queryByText(/Se detectó un salto/)).toBeNull()
    expect(socket.readyState).toBe(1)
    expect(FakeSocket.instances).toHaveLength(1)

    // The sequence did not move: seq 3 is still the next event.
    await act(async () => socket.receive(orderAt(3, 'o3')))
    expect(screen.getAllByText(/0\.01 · o3/).length).toBeGreaterThan(0)
  })

  it('ignores a repeated event_id even when its seq is the next expected one', async () => {
    const socket = await mountConnected()
    await act(async () => socket.receive(orderAt(1, 'o1')))
    await act(async () => socket.receive(orderAt(2, 'o2')))

    // seq 3 is exactly lastSeq + 1, so the seq check would accept it; only the
    // id of the already-applied seq 2 makes it be dropped.
    await act(async () =>
      socket.receive(orderAt(3, 'oSameId', `event-${RUN}-2-order.updated`)),
    )
    expect(screen.queryByText(/oSameId/)).toBeNull()
    expect(screen.queryByText(/Se detectó un salto/)).toBeNull()
    expect(socket.readyState).toBe(1)
    expect(FakeSocket.instances).toHaveLength(1)

    // Dropping it by id does not advance the sequence: a new id at seq 3
    // is accepted without a gap.
    await act(async () => socket.receive(orderAt(3, 'o3')))
    expect(screen.getAllByText(/0\.01 · o3/).length).toBeGreaterThan(0)
    expect(screen.queryByText(/Se detectó un salto/)).toBeNull()
  })

  it('does not move the sequence when an engine.status event carries a stale seq', async () => {
    const socket = await mountConnected()
    await act(async () => socket.receive(orderAt(1, 'o1')))
    await act(async () => socket.receive(orderAt(2, 'o2')))

    // seq 1 is already applied: the engine.status event is not a gap.
    await act(async () =>
      socket.receive(
        envelope(
          'engine.status',
          1,
          { message: 'Estado tardío' },
          RUN,
          'event-late-engine-status',
        ),
      ),
    )
    // It does not move the sequence: seq 3 is still the next event.
    await act(async () => socket.receive(orderAt(3, 'o3')))
    expect(screen.getAllByText(/0\.01 · o3/).length).toBeGreaterThan(0)
    expect(screen.queryByText(/Se detectó un salto/)).toBeNull()
  })

  it('ignores another run', async () => {
    const socket = await mountConnected()
    await act(async () => socket.receive(orderAt(1, 'o1')))

    // A snapshot of a different run is rejected: the view keeps run-1.
    await act(async () =>
      socket.receive(snapshot(5, 'run-2', [{ order_id: 'foreignOrder' }])),
    )
    openStatus()
    expect(screen.getByText(`Run: ${RUN}`)).toBeTruthy()
    expect(screen.queryByText(/foreignOrder/)).toBeNull()

    // Events tagged with another run are ignored too, and never trigger a gap.
    await act(async () =>
      socket.receive({ ...orderAt(2, 'oForeign'), run_id: 'run-2' }),
    )
    expect(screen.queryByText(/oForeign/)).toBeNull()
    expect(screen.queryByText(/Se detectó un salto/)).toBeNull()

    // The active run still advances normally.
    await act(async () => socket.receive(orderAt(2, 'o2')))
    expect(screen.getAllByText(/0\.01 · o2/).length).toBeGreaterThan(0)
  })

  it('reports protocol.error with its code', async () => {
    const socket = await mountConnected()
    await act(async () =>
      socket.receive(
        envelope('protocol.error', 1, { code: 'invalid_message' }),
      ),
    )
    expect(
      screen.getAllByRole('alert').map((alert) => alert.textContent),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          'Mensaje rechazado por el servidor: invalid_message',
        ),
      ]),
    )
  })

  it('reconnects with exponential backoff from 500 ms, capped at 10 s, and resets after opening', async () => {
    render(<FuturesTerminal bootstrap={bootstrap} />)
    expect(FakeSocket.instances).toHaveLength(1)

    // Never opens: each failed attempt doubles the wait.
    const waits = [500, 1_000, 2_000, 4_000, 8_000, 10_000, 10_000]
    for (const [index, wait] of waits.entries()) {
      await act(async () => live().close())
      expect(FakeSocket.instances).toHaveLength(index + 1)
      await advance(wait - 1)
      expect(FakeSocket.instances).toHaveLength(index + 1)
      await advance(1)
      expect(FakeSocket.instances).toHaveLength(index + 2)
    }

    // Opening resets the delay to 500 ms.
    await act(async () => live().open())
    await act(async () => live().close())
    await advance(499)
    const before = FakeSocket.instances.length
    await advance(1)
    expect(FakeSocket.instances).toHaveLength(before + 1)
  })

  it('closes the socket on unmount and cancels a pending reconnect', async () => {
    const { unmount } = render(<FuturesTerminal bootstrap={bootstrap} />)
    const socket = live()
    await act(async () => socket.open())
    await act(async () => socket.close())
    unmount()
    await advance(30_000)
    expect(FakeSocket.instances).toHaveLength(1)
    // A live socket is closed by cleanup.
    cleanup()
    render(<FuturesTerminal bootstrap={bootstrap} />)
    const second = live()
    await act(async () => second.open())
    cleanup()
    expect(second.readyState).toBe(3)
    await advance(30_000)
    expect(FakeSocket.instances).toHaveLength(2)
  })
})
