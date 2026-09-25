import { useEffect, useState } from 'react'

export type PaperOrderEvent = {
  id: number
  action: 'BUY' | 'SELL'
  gatePassed: boolean
  executionTimestamp: number | null
  signalTimestamp: number
  amountEur: number
}
export type PaperStatus = {
  enabled: boolean
  running: boolean
  stream_state: string
  account: { balance_eur: number; total_equity_eur: number }
  execution_summary: { gate_rejections: number; executed_trades: number }
}
export type PaperTelemetry = {
  status: PaperStatus | null
  orders: readonly PaperOrderEvent[]
  error: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function validStatus(value: unknown): value is PaperStatus {
  if (
    !isRecord(value) ||
    !isRecord(value.account) ||
    !isRecord(value.execution_summary)
  )
    return false
  return (
    typeof value.stream_state === 'string' &&
    typeof value.enabled === 'boolean' &&
    typeof value.running === 'boolean' &&
    Number.isFinite(value.account.balance_eur) &&
    Number.isFinite(value.account.total_equity_eur) &&
    Number.isSafeInteger(value.execution_summary.gate_rejections) &&
    Number.isSafeInteger(value.execution_summary.executed_trades)
  )
}
function validOrders(value: unknown): value is { orders: PaperOrderEvent[] } {
  return (
    isRecord(value) &&
    Array.isArray(value.orders) &&
    value.orders.every(
      (item) =>
        isRecord(item) &&
        Number.isSafeInteger(item.id) &&
        (item.action === 'BUY' || item.action === 'SELL') &&
        typeof item.gatePassed === 'boolean' &&
        (item.executionTimestamp === null ||
          Number.isSafeInteger(item.executionTimestamp)) &&
        Number.isSafeInteger(item.signalTimestamp) &&
        Number.isFinite(item.amountEur),
    )
  )
}

export function usePaperTelemetry(): PaperTelemetry {
  const [telemetry, setTelemetry] = useState<PaperTelemetry>({
    status: null,
    orders: [],
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
        const [statusResponse, ordersResponse] = await Promise.all([
          fetch('/api/paper-trading/status', { signal: controller.signal }),
          fetch('/api/paper-trading/orders?limit=500', {
            signal: controller.signal,
          }),
        ])
        if (!statusResponse.ok || !ordersResponse.ok)
          throw new Error('No se pudo actualizar el estado de paper trading.')
        const [statusPayload, ordersPayload]: [unknown, unknown] =
          await Promise.all([statusResponse.json(), ordersResponse.json()])
        if (!validStatus(statusPayload) || !validOrders(ordersPayload))
          throw new Error('La respuesta de paper trading no es válida.')
        if (active)
          setTelemetry((current) => ({
            status: statusPayload,
            orders: sameOrders(current.orders, ordersPayload.orders)
              ? current.orders
              : ordersPayload.orders,
            error: null,
          }))
      } catch (error) {
        if (
          active &&
          !(error instanceof DOMException && error.name === 'AbortError')
        )
          setTelemetry((current) => ({
            ...current,
            error:
              error instanceof Error
                ? error.message
                : 'Error al actualizar paper trading.',
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

function sameOrders(
  left: readonly PaperOrderEvent[],
  right: readonly PaperOrderEvent[],
): boolean {
  return (
    left.length === right.length &&
    left.every((order, index) => {
      const next = right[index]
      return (
        next !== undefined &&
        order.id === next.id &&
        order.action === next.action &&
        order.gatePassed === next.gatePassed &&
        order.executionTimestamp === next.executionTimestamp &&
        order.signalTimestamp === next.signalTimestamp &&
        order.amountEur === next.amountEur
      )
    })
  )
}
