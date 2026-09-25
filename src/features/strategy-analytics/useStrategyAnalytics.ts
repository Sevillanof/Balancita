import { useEffect, useState } from 'react'
import type { PaperTradePosition, StrategySummaryMetric } from './types.ts'

export interface StrategyAnalyticsState {
  readonly strategies: readonly StrategySummaryMetric[]
  readonly positions: readonly PaperTradePosition[]
  readonly fastReplayBrier: Readonly<Record<string, number | null>>
  readonly loading: boolean
  readonly error: string | null
}

export function useStrategyAnalytics(status: 'all' | 'open' | 'closed') {
  const [state, setState] = useState<StrategyAnalyticsState>({
    strategies: [],
    positions: [],
    fastReplayBrier: {},
    loading: true,
    error: null,
  })

  useEffect(() => {
    let active = true
    let busy = false
    let controller: AbortController | null = null
    const poll = async () => {
      if (busy) return
      busy = true
      controller = new AbortController()
      try {
        const [summaryResponse, positionsResponse] = await Promise.all([
          fetch('/api/paper-trading/strategies-summary', {
            signal: controller.signal,
          }),
          fetch(`/api/paper-trading/positions?status=${status}&limit=50`, {
            signal: controller.signal,
          }),
        ])
        if (!summaryResponse.ok || !positionsResponse.ok)
          throw new Error('No se pudo cargar la auditoría de estrategias.')
        const [summaryPayload, positionsPayload]: [unknown, unknown] =
          await Promise.all([summaryResponse.json(), positionsResponse.json()])
        if (!Array.isArray(summaryPayload) || !Array.isArray(positionsPayload))
          throw new Error('La respuesta de auditoría no es válida.')
        if (active)
          setState((current) => ({
            ...current,
            strategies: summaryPayload as StrategySummaryMetric[],
            positions: positionsPayload as PaperTradePosition[],
            loading: false,
            error: null,
          }))
      } catch (cause) {
        if (
          active &&
          !(cause instanceof DOMException && cause.name === 'AbortError')
        )
          setState((current) => ({
            ...current,
            loading: false,
            error:
              cause instanceof Error
                ? cause.message
                : 'Error al cargar la auditoría.',
          }))
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

  return state
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
