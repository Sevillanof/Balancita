import { useEffect, useState } from 'react'
import type { PaperTradePosition, StrategySummaryMetric } from './types.ts'

export interface StrategyAnalyticsState {
  readonly strategies: readonly StrategySummaryMetric[]
  readonly positions: readonly PaperTradePosition[]
  readonly fastReplayBrier: Readonly<Record<string, number | null>>
  readonly loading: boolean
  readonly error: string | null
  readonly errorStatus: 'all' | 'open' | 'closed' | null
  readonly lastSuccessfulPollAt: string | null
  readonly streamState: string | null
  readonly lastProcessedEventTime: string | null
  readonly positionsStatus: 'all' | 'open' | 'closed' | null
}

export function useStrategyAnalytics(status: 'all' | 'open' | 'closed') {
  const [state, setState] = useState<StrategyAnalyticsState>({
    strategies: [],
    positions: [],
    fastReplayBrier: {},
    loading: true,
    error: null,
    errorStatus: null,
    lastSuccessfulPollAt: null,
    streamState: null,
    lastProcessedEventTime: null,
    positionsStatus: null,
  })

  useEffect(() => {
    let active = true
    let busy = false
    let controller: AbortController | null = null
    const poll = async () => {
      if (busy) return
      busy = true
      const batchController = new AbortController()
      controller = batchController
      let failed = false
      const reportFailure = (message: string) => {
        if (failed) return
        failed = true
        batchController.abort()
        if (active)
          setState((current) => ({
            ...current,
            loading: false,
            error: message,
            errorStatus: status,
          }))
      }
      try {
        const request = async (url: string): Promise<Response> => {
          try {
            const response = await fetch(url, {
              signal: batchController.signal,
            })
            if (!response.ok) {
              reportFailure('No se pudo cargar la auditoría de estrategias.')
              throw new Error('No se pudo cargar la auditoría de estrategias.')
            }
            return response
          } catch (cause) {
            if (!(cause instanceof DOMException && cause.name === 'AbortError'))
              reportFailure(
                cause instanceof Error
                  ? cause.message
                  : 'Error al cargar la auditoría.',
              )
            throw cause
          }
        }
        const responses = await Promise.allSettled([
          request('/api/paper-trading/strategies-summary'),
          request(`/api/paper-trading/positions?status=${status}&limit=50`),
          request('/api/paper-trading/status'),
        ])
        if (
          !active ||
          failed ||
          responses.some((result) => result.status === 'rejected')
        )
          return
        const [summaryResponse, positionsResponse, statusResponse] =
          responses.map(
            (result) => (result as PromiseFulfilledResult<Response>).value,
          )
        const readJson = async (response: Response): Promise<unknown> => {
          try {
            return await response.json()
          } catch (cause) {
            if (!(cause instanceof DOMException && cause.name === 'AbortError'))
              reportFailure(
                cause instanceof Error
                  ? cause.message
                  : 'La respuesta de auditoría no es válida.',
              )
            throw cause
          }
        }
        const payloads = await Promise.allSettled([
          readJson(summaryResponse!),
          readJson(positionsResponse!),
          readJson(statusResponse!),
        ])
        if (
          !active ||
          failed ||
          payloads.some((result) => result.status === 'rejected')
        )
          return
        const [summaryPayload, positionsPayload, statusPayload] = payloads.map(
          (result) => (result as PromiseFulfilledResult<unknown>).value,
        ) as [unknown, unknown, unknown]
        const metadata = validStatus(statusPayload)
        if (
          !Array.isArray(summaryPayload) ||
          !Array.isArray(positionsPayload) ||
          metadata === null
        )
          throw new Error('La respuesta de auditoría no es válida.')
        const receivedAt = new Date().toISOString()
        if (active && !failed)
          setState((current) => ({
            ...current,
            strategies: summaryPayload as StrategySummaryMetric[],
            positions: positionsPayload as PaperTradePosition[],
            positionsStatus: status,
            lastSuccessfulPollAt: receivedAt,
            streamState: metadata.streamState,
            lastProcessedEventTime: metadata.lastProcessedEventTime,
            loading: false,
            error: null,
            errorStatus: null,
          }))
      } catch (cause) {
        if (
          active &&
          !failed &&
          !(cause instanceof DOMException && cause.name === 'AbortError')
        ) {
          reportFailure(
            cause instanceof Error
              ? cause.message
              : 'Error al cargar la auditoría.',
          )
        }
      } finally {
        busy = false
      }
    }
    void poll()
    const timer = window.setInterval(() => void poll(), 5000)
    return () => {
      active = false
      window.clearInterval(timer)
      controller?.abort()
    }
  }, [status])

  useEffect(() => {
    let active = true
    const controller = new AbortController()
    void fetch('/api/replay/fast-run/history?limit=50', {
      signal: controller.signal,
    })
      .then(async (response) => (response.ok ? response.json() : { runs: [] }))
      .then((payload: unknown) => {
        if (!active || !isRecord(payload) || !Array.isArray(payload.runs))
          return
        const fastReplayBrier: Record<string, number | null> = {}
        const replayRuns = payload.runs
          .filter(
            (value): value is Record<string, unknown> =>
              isRecord(value) &&
              typeof value.strategyId === 'string' &&
              (value.brierScoreMulticlass === null ||
                (typeof value.brierScoreMulticlass === 'number' &&
                  Number.isFinite(value.brierScoreMulticlass))),
          )
          .sort(
            (left, right) =>
              (Number(right.createdAt) || 0) - (Number(left.createdAt) || 0),
          )
        for (const value of replayRuns) {
          if (!Object.hasOwn(fastReplayBrier, value.strategyId as string))
            fastReplayBrier[value.strategyId as string] =
              value.brierScoreMulticlass as number | null
        }
        setState((current) => ({ ...current, fastReplayBrier }))
      })
      .catch(() => undefined)
    return () => {
      active = false
      controller.abort()
    }
  }, [])

  return {
    ...state,
    loading:
      state.loading ||
      (state.positionsStatus !== status && state.errorStatus !== status),
    error: state.errorStatus === status ? state.error : null,
    positions: state.positionsStatus === status ? state.positions : [],
  }
}

function validStatus(
  value: unknown,
): { streamState: string; lastProcessedEventTime: string | null } | null {
  if (
    !isRecord(value) ||
    typeof value.stream_state !== 'string' ||
    value.stream_state.trim() === ''
  )
    return null
  const timestamp = value.last_processed_event_time
  if (timestamp === null)
    return { streamState: value.stream_state, lastProcessedEventTime: null }
  const date =
    typeof timestamp === 'number' && Number.isFinite(timestamp)
      ? new Date(timestamp)
      : typeof timestamp === 'string' && timestamp.trim() !== ''
        ? new Date(timestamp)
        : null
  return date !== null && Number.isFinite(date.getTime())
    ? {
        streamState: value.stream_state,
        lastProcessedEventTime: date.toISOString(),
      }
    : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
