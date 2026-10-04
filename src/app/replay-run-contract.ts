export type Run = {
  id: string
  datasetHash?: string
  strategyId: string
  strategyOwner?: 'typescript-native'
  ledgerOwner?: 'python-ledger'
  sizingModel?: string
  nativeTradeTimestampUnit?: string
  nativeTradeTimestampMeaning?: string
  initialCashEur?: number
  finalEquityEur?: number
  netPnlEur?: number
  window: { start_time: number; end_time: number }
  trades: readonly {
    side: 'buy' | 'sell'
    timestamp: unknown
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
        executionAtMs: unknown
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
        typeof fill.timingStatus === 'string',
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

export function nativeTradeTimeMs(
  run: Pick<
    Run,
    'window' | 'nativeTradeTimestampUnit' | 'nativeTradeTimestampMeaning'
  >,
  timestamp: unknown,
): number | null {
  if (
    run.nativeTradeTimestampUnit !== 'unix-milliseconds' ||
    run.nativeTradeTimestampMeaning !== 'simulated-next-15m-candle-open' ||
    !dateInteger(timestamp) ||
    !dateInteger(run.window.start_time) ||
    !dateInteger(run.window.end_time) ||
    timestamp < run.window.start_time ||
    timestamp > run.window.end_time
  )
    return null
  return timestamp
}

export function pythonExecutionTimeMs(
  run: Pick<Run, 'window' | 'pythonLedger'>,
  fillIndex: unknown,
): number | null {
  const ledger = run.pythonLedger?.ledger
  const audits = run.pythonLedger?.executionAudit.fills
  if (
    ledger === null ||
    ledger === undefined ||
    audits === undefined ||
    !integer(fillIndex) ||
    fillIndex < 0 ||
    fillIndex >= ledger.fills.length
  )
    return null
  const fill = ledger.fills[fillIndex]
  const matchingAudits = audits.filter((audit) => audit.fillIndex === fillIndex)
  if (fill === undefined || matchingAudits.length !== 1) return null
  const audit = matchingAudits[0]!
  if (
    audit.timingStatus !== 'modeled_next_open' ||
    audit.fillSide !== fill.side ||
    (fill.side !== 'buy' && fill.side !== 'sell') ||
    !dateInteger(audit.executionAtMs) ||
    !dateInteger(run.window.start_time) ||
    !dateInteger(run.window.end_time) ||
    audit.executionAtMs < run.window.start_time ||
    audit.executionAtMs > run.window.end_time
  )
    return null
  return audit.executionAtMs
}
