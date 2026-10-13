import { useEffect, useRef, useState } from 'react'
import {
  parseTerminalEnvelope,
  terminalWebSocketUrl,
  type TerminalBootstrap,
} from '../features/connected-trading/infrastructure/terminal-stream-client.ts'
import { applyTerminalEvents } from '../features/connected-trading/infrastructure/terminal-state.ts'
import { createTerminalBatcher } from '../features/connected-trading/infrastructure/terminal-batch.ts'
import { record } from '../shared/wire/decode.ts'

export type ViewState = Record<string, unknown>

/**
 * The terminal's WebSocket session: connection, resync, run switching and paper
 * commands. Extracted verbatim from FuturesTerminal (Mission Control Fase 2.2);
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
  const [error, setError] = useState<string | null>(null)
  const [commandPending, setCommandPending] = useState(false)
  const [commandStatus, setCommandStatus] = useState('')
  const [commandVersion, setCommandVersion] = useState(0)
  const [selectedAnalysisId, setSelectedAnalysisId] = useState<string | null>(
    null,
  )
  const socketRef = useRef<WebSocket | null>(null)
  const [activeRunId, setActiveRunId] = useState(bootstrap.active_run_id)
  const activeRunRef = useRef(bootstrap.active_run_id)
  const awaitingNewRunRef = useRef(false)

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
      socketRef.current = socket
      socket.onopen = () => {
        setConnected(true)
        retryDelay = 500
        socket?.send(
          JSON.stringify(
            lastSeq > 0 && streamId
              ? {
                  schema_version: 1,
                  type: 'resume',
                  run_id: activeRunRef.current,
                  last_seq: lastSeq,
                }
              : {
                  schema_version: 1,
                  type: 'subscribe',
                  run_id: activeRunRef.current,
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
        if (event.type === 'snapshot') {
          if (event.run_id !== activeRunRef.current) {
            // Only a requested new run may move the view to another run.
            if (!awaitingNewRunRef.current) return
            awaitingNewRunRef.current = false
            activeRunRef.current = event.run_id
            setActiveRunId(event.run_id)
            setSelectedAnalysisId(null)
          }
          batcher.reset()
          const originalRun = event.run_id === bootstrap.active_run_id
          const watermark = event.data.watermark as number
          streamId = event.stream_id
          lastSeq = watermark
          seen.clear()
          const market = record(event.data.market)
          const snapshotState = record(event.data.state)
          setState({
            ...snapshotState,
            market: {
              ...(originalRun ? record(bootstrap.market) : {}),
              ...record(snapshotState.market),
            },
            terminal_market:
              market.schema_version === 'mock-terminal-market.v1' ||
              market.schema_version === 'futures-terminal-market.v1'
                ? market
                : originalRun &&
                    [
                      'mock-terminal-market.v1',
                      'futures-terminal-market.v1',
                    ].includes(
                      String(record(bootstrap.terminal_market).schema_version),
                    )
                  ? bootstrap.terminal_market
                  : null,
          })
          setCommandVersion(Number(snapshotState.state_version ?? 0))
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
        if (event.type === 'command.ack')
          setCommandStatus(
            `Comando ${String(event.data.status ?? 'recibido')}; sin fill confirmado.`,
          )
        if (event.type === 'command.result') {
          setCommandPending(false)
          const result = record(record(event.data.result).result)
          if (
            record(event.data.result).status === 'failed' ||
            result.status === 'failed'
          )
            awaitingNewRunRef.current = false
          const outcome = String(result.status ?? 'registrado')
          setCommandStatus(
            outcome === 'failed' || outcome === 'superseded'
              ? `Comando no aplicado: ${outcome}. Vuelve a intentarlo.`
              : `Resultado durable recibido: ${outcome}.`,
          )
        }
        if (event.type === 'protocol.error') {
          awaitingNewRunRef.current = false
          setCommandPending(false)
          setError(
            `Comando rechazado por el servidor: ${String(event.data.code ?? 'error')}`,
          )
          return
        }
        if (event.run_id !== activeRunRef.current || seen.has(event.event_id))
          return
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
        if (event.type === 'analysis.completed')
          setCommandVersion((version) => version + 1)
        if (event.type === 'command.result') {
          const appliedVersion = record(
            record(event.data.result).result,
          ).applied_state_version
          if (Number.isSafeInteger(appliedVersion))
            setCommandVersion(Number(appliedVersion))
        }
        batcher.push(event)
      }
      socket.onclose = () => {
        setConnected(false)
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
      socketRef.current = null
    }
  }, [bootstrap, apiBase, product])

  const sendCommand = (action: string) => {
    const socket = socketRef.current
    if (!socket || socket.readyState !== WebSocket.OPEN || !bootstrap || !state)
      return
    setCommandPending(true)
    setCommandStatus('Enviando comando; aceptación no significa fill.')
    if (action === 'paper.new_run') awaitingNewRunRef.current = true
    socket.send(
      JSON.stringify({
        schema_version: 1,
        type: 'paper.command',
        run_id: activeRunRef.current,
        command_id: crypto.randomUUID(),
        expected_state_version: Number(commandVersion),
        action,
      }),
    )
    setCommandVersion((version) => version + 1)
  }

  return {
    state,
    connected,
    error,
    commandPending,
    commandStatus,
    commandVersion,
    activeRunId,
    selectedAnalysisId,
    setSelectedAnalysisId,
    sendCommand,
  }
}
