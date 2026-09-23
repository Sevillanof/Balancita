import type { TimestampMs } from '../../domain/contracts.ts'
import type { KrakenCatchUpClient } from '../market-data/kraken-market-collector.ts'
import { KRAKEN_REST_PAIR } from '../market-data/market-sources.ts'
import {
  type BackfillSource,
  type BackfillSourcePage,
  type ReplayTrade,
} from './replay-contracts.ts'

/**
 * Adapt the live Kraken REST catch-up client into a backfill source. Used only
 * to recover detected trade-id gaps from the public `/0/public/Trades`
 * endpoint; the client is fully injectable so tests never hit the network.
 */
export function createRestBackfillSource(options: {
  readonly client: KrakenCatchUpClient
  readonly clock: () => TimestampMs
}): BackfillSource {
  return {
    origin: 'rest',
    async fetchPage({ window, sinceTradeId }): Promise<BackfillSourcePage> {
      const result = await options.client.fetchTrades({
        pair: KRAKEN_REST_PAIR,
        since: window.startTime,
        until: window.endTime,
        fromTradeId: sinceTradeId ?? 0,
        toTradeId: Number.MAX_SAFE_INTEGER,
      })
      const receivedTime = options.clock()
      const trades: ReplayTrade[] = result.trades
        .filter(
          (trade) =>
            trade.eventTime >= window.startTime &&
            trade.eventTime < window.endTime,
        )
        .map((trade) => ({
          instrumentId: 'BTC-EUR',
          source: 'kraken',
          tradeId: trade.tradeId,
          eventTime: trade.eventTime,
          receivedTime,
          price: trade.price,
          qty: trade.qty,
          side: trade.side,
          ...(trade.orderType === undefined
            ? {}
            : { orderType: trade.orderType }),
          origin: 'rest',
        }))
      return { trades, hasMore: false }
    },
  }
}
