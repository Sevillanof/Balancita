import { useEffect, useState } from 'react'
import {
  parseTerminalEnvelope,
  terminalWebSocketUrl,
  type TerminalBootstrap,
} from '../features/connected-trading/infrastructure/terminal-stream-client.ts'
import { applyTerminalEvents } from '../features/connected-trading/infrastructure/terminal-state.ts'
import { createTerminalBatcher } from '../features/connected-trading/infrastructure/terminal-batch.ts'
import { record } from '../shared/wire/decode.ts'
import type { GatewayClock } from '../features/observability/presentation/latest-decision.ts'

export type ViewState = Record<string, unknown>

/**
 * The terminal's WebSocket session: connection and resync. Extracted verbatim from FuturesTerminal (Mission Control Fase 2.2);
 * the protocol is pinned by FuturesTerminal.stream.test.tsx.
 */
export function useTerminalStream({
  bootstrap,
  apiBase,
  product,
}: {
  bootstrap: TerminalBootstrap
  apiBase: string
  product?: string
}) {
  const [state, setState] = useState<ViewState | null>(null)
  const [connected, setConnected] = useState(false)
  // The gateway's clock as its last snapshot/heartbeat of THIS connection
  // delivered it (`published_at`) with the browser time it arrived at. Null
  // until one arrives and again as soon as the socket drops: nothing carries
  // over from a previous connection and nothing claims the gateway's time.
  const [serverClock, setServerClock] = useState<GatewayClock | null>(null)
  // Browser time the current connection opened; null while disconnected.
  const [connectedAtMs, setConnectedAtMs] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selectedAnalysisId, setSelectedAnalysisId] = useState<string | null>(
    null,
  )
  const activeRunId = bootstrap.active_run_id

  useEffect(() => {
    let cancelled = false
    let socket: WebSocket | undefined
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let retryDelay = 500
    let lastSeq = 0
    let streamId: string | null = null
    const seen = new Set<string>()
    // One view update per second for price ticks instead of one per event.
    const batcher = createTerminalBatcher((events) =>
      setState((previous) => applyTerminalEvents(previous, events)),
    )
    const openSocket = () => {
      if (cancelled) return
      socket = new WebSocket(terminalWebSocketUrl(apiBase, product))
      socket.onopen = () => {
        setServerClock(null)
        setConnectedAtMs(Date.now())
        setConnected(true)
        retryDelay = 500
        socket?.send(
          JSON.stringify(
            lastSeq > 0 && streamId
              ? {
                  schema_version: 1,
                  type: 'resume',
                  run_id: activeRunId,
                  last_seq: lastSeq,
                }
              : {
                  schema_version: 1,
                  type: 'subscribe',
                  run_id: activeRunId,
                },
          ),
        )
      }
      socket.onmessage = (message) => {
        let raw: unknown
        try {
          raw = JSON.parse(String(message.data)) as unknown
        } catch {
          setError('El flujo devolvió un mensaje ilegible.')
          return
        }
        const event = parseTerminalEnvelope(raw)
        if (!event) {
          setError('El flujo devolvió un evento incompatible.')
          return
        }
        if (
          (event.type === 'snapshot' || event.type === 'heartbeat') &&
          event.run_id === activeRunId
        )
          setServerClock({
            publishedAtMs: event.published_at,
            receivedAtMs: Date.now(),
          })
        if (event.type === 'snapshot') {
          // The view never moves to another run.
          if (event.run_id !== activeRunId) return
          batcher.reset()
          const watermark = event.data.watermark as number
          streamId = event.stream_id
          lastSeq = watermark
          seen.clear()
          const market = record(event.data.market)
          const snapshotState = record(event.data.state)
          setState({
            ...snapshotState,
            market: {
              ...record(bootstrap.market),
              ...record(snapshotState.market),
            },
            terminal_market:
              market.schema_version === 'futures-terminal-market.v1'
                ? market
                : record(bootstrap.terminal_market).schema_version ===
                    'futures-terminal-market.v1'
                  ? bootstrap.terminal_market
                  : null,
          })
          setError(null)
          return
        }
        if (event.type === 'resync.required') {
          batcher.reset()
          lastSeq = 0
          streamId = null
          socket?.close()
          return
        }
        if (event.type === 'protocol.error') {
          setError(
            `Mensaje rechazado por el servidor: ${String(event.data.code ?? 'error')}`,
          )
          return
        }
        if (event.run_id !== activeRunId || seen.has(event.event_id)) return
        if (event.type === 'engine.status')
          setState((previous) => ({
            ...(previous ?? {}),
            engine: {
              ...record(previous?.engine),
              ...event.data,
            },
          }))
        if (event.seq <= lastSeq) return
        if (event.seq !== lastSeq + 1) {
          setError('Se detectó un salto en el flujo; resincronizando.')
          batcher.reset()
          lastSeq = 0
          streamId = null
          socket?.close()
          return
        }
        seen.add(event.event_id)
        if (seen.size > 2000) seen.clear()
        lastSeq = event.seq
        batcher.push(event)
      }
      socket.onclose = () => {
        setConnected(false)
        setConnectedAtMs(null)
        setServerClock(null)
        if (cancelled) return
        retryTimer = setTimeout(openSocket, retryDelay)
        retryDelay = Math.min(10_000, retryDelay * 2)
      }
      socket.onerror = () => socket?.close()
    }
    openSocket()
    return () => {
      cancelled = true
      batcher.dispose()
      if (retryTimer !== undefined) clearTimeout(retryTimer)
      socket?.close()
    }
  }, [bootstrap, apiBase, product, activeRunId])

  return {
    state,
    connected,
    serverClock,
    connectedAtMs,
    error,
    activeRunId,
    selectedAnalysisId,
    setSelectedAnalysisId,
  }
}
