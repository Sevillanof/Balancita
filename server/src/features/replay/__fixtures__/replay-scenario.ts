import type { TimestampMs } from '../../../domain/contracts.ts'
import type { CandleInterval } from '../../market-data/intraday-candles.ts'
import { INTERVAL_MS } from '../../market-data/intraday-candles.ts'
import { freezeReplayDataset } from '../replay-dataset.ts'
import type { FrozenReplayDataset, ReplayTrade } from '../replay-contracts.ts'

/**
 * Deterministic, network-free replay scenario used by the KRA-4b run, clock,
 * isolation and reproducibility tests. Trades are generated candle by candle
 * with a monotonically rising price so technical features become ready after
 * the standard warm-up and forecasts never abstain once warm.
 */
export const REPLAY_T0 = 1_789_984_800_000
export const REPLAY_CLOCK = REPLAY_T0 + 999_000
export const MINUTE_MS = 60_000

export interface ScenarioOptions {
  readonly candles?: number
  readonly interval?: CandleInterval
  readonly importVersion?: string
  readonly startPrice?: number
  readonly priceStep?: number
}

export function makeScenarioDataset(
  options: ScenarioOptions = {},
): FrozenReplayDataset {
  const candleCount = options.candles ?? 90
  const interval = options.interval ?? '1m'
  const importVersion = options.importVersion ?? 'kraken-time-and-sales.v1'
  const intervalMs = INTERVAL_MS[interval]
  const startPrice = options.startPrice ?? 60_000
  const priceStep = options.priceStep ?? 12
  const trades: ReplayTrade[] = []
  for (let index = 0; index < candleCount; index += 1) {
    const bucketStart = REPLAY_T0 + index * intervalMs
    const base = startPrice + index * priceStep
    appendTrade(trades, index * 2, bucketStart + 10_000, base, 0.4)
    appendTrade(trades, index * 2 + 1, bucketStart + 40_000, base + 1, 0.6)
  }
  const asOfTimestamp = (REPLAY_T0 + candleCount * intervalMs) as TimestampMs
  return freezeReplayDataset({
    interval,
    importVersion,
    trades,
    gaps: [],
    conflicts: [],
    asOfTimestamp,
  })
}

function appendTrade(
  trades: ReplayTrade[],
  tradeId: number,
  eventTime: number,
  price: number,
  qty: number,
): void {
  trades.push({
    instrumentId: 'BTC-EUR',
    source: 'kraken',
    tradeId,
    eventTime: eventTime as TimestampMs,
    receivedTime: REPLAY_CLOCK as TimestampMs,
    price,
    qty,
    side: tradeId % 2 === 0 ? 'buy' : 'sell',
    orderType: 'limit',
    origin: 'archive',
  })
}
