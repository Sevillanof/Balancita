import { useEffect, useState } from 'react'

export type OhlcCollectorStatus = {
  running: boolean
  candleCount: number
  coverageHours: number
  gapCount: number
  maxTimestamp: string | null
}

type OhlcCollectorTelemetry = {
  status: OhlcCollectorStatus | null
  error: string | null
}

type OhlcCollectorStatusResponse = {
  running: boolean
  total_candles: number
  coverage_hours: number
  gaps_detected: number
  newest_candle_iso: string | null
}

function validStatus(value: unknown): value is OhlcCollectorStatusResponse {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.running === 'boolean' &&
    Number.isSafeInteger(candidate.total_candles) &&
    Number.isFinite(candidate.coverage_hours) &&
    Number.isSafeInteger(candidate.gaps_detected) &&
    (candidate.newest_candle_iso === null ||
      (typeof candidate.newest_candle_iso === 'string' &&
        Number.isFinite(Date.parse(candidate.newest_candle_iso))))
  )
}

export function useOhlcCollectorTelemetry(): OhlcCollectorTelemetry {
  const [telemetry, setTelemetry] = useState<OhlcCollectorTelemetry>({
    status: null,
    error: null,
  })
  useEffect(() => {
    let active = true
    let inFlight = false
    let controller: AbortController | null = null
    const poll = async () => {
      if (inFlight) return
      inFlight = true
      controller = new AbortController()
      try {
        const response = await fetch('/api/market/collector/status', {
          signal: controller.signal,
        })
        if (!response.ok)
          throw new Error('No se pudo consultar la ingesta OHLC.')
        const payload: unknown = await response.json()
        if (!validStatus(payload))
          throw new Error('La respuesta de ingesta OHLC no es válida.')
        if (active)
          setTelemetry({
            status: {
              running: payload.running,
              candleCount: payload.total_candles,
              coverageHours: payload.coverage_hours,
              gapCount: payload.gaps_detected,
              maxTimestamp: payload.newest_candle_iso,
            },
            error: null,
          })
      } catch (error) {
        if (
          active &&
          !(error instanceof DOMException && error.name === 'AbortError')
        )
          setTelemetry((current) => ({
            ...current,
            error:
              error instanceof Error ? error.message : 'Error de ingesta OHLC.',
          }))
      } finally {
        inFlight = false
      }
    }
    void poll()
    const timer = window.setInterval(() => void poll(), 5000)
    return () => {
      active = false
      window.clearInterval(timer)
      controller?.abort()
    }
  }, [])
  return telemetry
}
