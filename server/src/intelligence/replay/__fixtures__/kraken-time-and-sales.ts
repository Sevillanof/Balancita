/**
 * Kraken Time & Sales archive fixtures.
 *
 * The downloadable archive ships one CSV per pair with a header row and seven
 * columns: `timestamp, price, volume, type, order_type, misc, trade_id`, where
 * `type` is `b` (buy) / `s` (sell) and `order_type` is `l` (limit) / `m`
 * (market). `timestamp` is epoch seconds with sub-second precision and rows are
 * ordered by timestamp.
 *
 * The fixture intentionally contains a trade-id gap (102, 103 are missing) so
 * importer/catch-up behavior is exercised without any network access.
 */

export const KRAKEN_TIME_AND_SALES_HEADER =
  'timestamp,price,volume,type,order_type,misc,trade_id'

export const KRAKEN_TIME_AND_SALES_CSV = `${KRAKEN_TIME_AND_SALES_HEADER}
1789984801.000000,60000.00000,0.50000000,b,l,,100
1789984802.000000,60001.00000,0.25000000,s,m,,101
1789984861.000000,60010.00000,0.40000000,b,l,,104
1789984862.000000,60011.00000,0.30000000,s,m,,105
`

export const KRAKEN_TIME_AND_SALES_WITH_CONFLICT_CSV = `${KRAKEN_TIME_AND_SALES_HEADER}
1789984801.000000,60000.00000,0.50000000,b,l,,100
1789984802.000000,60001.00000,0.25000000,s,m,,101
1789984802.000000,69999.00000,0.25000000,s,m,,101
`

/**
 * Builds a Kraken REST `/0/public/Trades` response body from raw rows.
 * Each row follows the REST tuple shape:
 * `[price, volume, timeSeconds, type, orderType, misc, tradeId]`.
 */
export function krakenTradesResponse(
  rows: readonly (readonly (string | number)[])[],
  last = '1789984862000000000',
): string {
  return JSON.stringify({
    error: [],
    result: { XBTEUR: rows, last },
  })
}
