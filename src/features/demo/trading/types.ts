export type DemoDirection = 'long' | 'short'
export type DemoDecisionKind = 'entry' | 'exit' | 'discard'

export type DemoCandle = {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export type DemoDecision = {
  id: string
  time: number
  kind: DemoDecisionKind
  direction?: DemoDirection
  price: number
  reason: string
  executionId?: string
  positionId?: string
}

export type DemoPosition = {
  id: string
  direction: DemoDirection
  sizeBtc: number
  entryEur: number
  entryTime: number
  entryFeeEur: number
  stopEur: number
  targetEur: number
}

export type DemoTrade = {
  id: string
  positionId: string
  direction: DemoDirection
  sizeBtc: number
  entryEur: number
  exitEur: number
  entryFeeEur: number
  exitFeeEur: number
  realizedPnlEur: number
  entryTime: number
  exitTime: number
  stopEur: number
  targetEur: number
}

export type DemoSnapshot = {
  candles: readonly DemoCandle[]
  decisions: readonly DemoDecision[]
  positions: readonly DemoPosition[]
  trades: readonly DemoTrade[]
  lastUpdate: number
}
