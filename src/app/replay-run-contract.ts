export type Run = {
  id: string
  datasetHash?: string
  strategyId: string
  strategyOwner?: 'typescript-native'
  ledgerOwner?: 'python-ledger'
  sizingModel?: string
  initialCashEur?: number
  finalEquityEur?: number
  netPnlEur?: number
  window: { start_time: number; end_time: number }
  trades: readonly {
    side: 'buy' | 'sell'
    timestamp: number
    price: number
    quantity: number
    feeEur?: number
  }[]
  feeScenario?: {
    version?: string
    venue?: string
    commissionRate?: number
    slippageRate?: number
    sourceUrl?: string
    verifiedAt?: string
  } | null
  pythonLedger?: {
    ledger: {
      fills: readonly {
        side: string
        time: number
        price: number
        qty: number
        commission: number
      }[]
    } | null
    executionAudit: {
      fills: readonly {
        fillIndex: number
        fillSide: string
        timingStatus: string
        executionAtMs: number | null
      }[]
    }
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function dateInteger(value: unknown): value is number {
  return integer(value) && Number.isFinite(new Date(value).getTime())
}

function validPythonLedger(value: unknown): boolean {
  if (
    !record(value) ||
    !record(value.executionAudit) ||
    !Array.isArray(value.executionAudit.fills) ||
    !value.executionAudit.fills.every(
      (fill) =>
        record(fill) &&
        integer(fill.fillIndex) &&
        typeof fill.fillSide === 'string' &&
        typeof fill.timingStatus === 'string' &&
        (fill.executionAtMs === null || dateInteger(fill.executionAtMs)),
    )
  )
    return false
  if (value.ledger === null) return true
  return (
    record(value.ledger) &&
    Array.isArray(value.ledger.fills) &&
    value.ledger.fills.every(
      (fill) =>
        record(fill) &&
        dateInteger(fill.time) &&
        typeof fill.side === 'string' &&
        finite(fill.price) &&
        finite(fill.qty) &&
        finite(fill.commission),
    )
  )
}

export function isRun(value: unknown): value is Run {
  return (
    record(value) &&
    typeof value.id === 'string' &&
    typeof value.strategyId === 'string' &&
    record(value.window) &&
    dateInteger(value.window.start_time) &&
    dateInteger(value.window.end_time) &&
    value.window.end_time >= value.window.start_time &&
    Array.isArray(value.trades) &&
    value.trades.every(
      (trade) =>
        record(trade) &&
        (trade.side === 'buy' || trade.side === 'sell') &&
        integer(trade.timestamp) &&
        finite(trade.price) &&
        finite(trade.quantity) &&
        (trade.feeEur === undefined || finite(trade.feeEur)),
    ) &&
    (value.datasetHash === undefined ||
      typeof value.datasetHash === 'string') &&
    (value.strategyOwner === undefined ||
      value.strategyOwner === 'typescript-native') &&
    (value.ledgerOwner === undefined ||
      value.ledgerOwner === 'python-ledger') &&
    (value.ledgerOwner !== 'python-ledger' ||
      validPythonLedger(value.pythonLedger)) &&
    (value.initialCashEur === undefined || finite(value.initialCashEur)) &&
    (value.finalEquityEur === undefined || finite(value.finalEquityEur)) &&
    (value.netPnlEur === undefined || finite(value.netPnlEur))
  )
}
