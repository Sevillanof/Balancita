import { createServer as createNetServer } from 'node:net'
import { FuturesMarketStore } from '../../server/src/features/kraken-futures/futures-market-store.ts'
import {
  PAPER_MARKET_QUALITY_POLICY,
  validateInstrumentCatalog,
} from '../../server/src/features/kraken-futures/futures-market.ts'

export function createRecordedSource(path: string): void {
  const store = new FuturesMarketStore(path)
  try {
    const catalog = {
      instruments: [
        {
          symbol: 'PF_XBTUSD',
          type: 'flexible_futures',
          pair: 'BTC:USD',
          base: 'BTC',
          quote: 'USD',
          contractSize: '1',
          tickSize: '1',
          contractValueTradePrecision: 4,
          tradeable: true,
          isExpired: false,
        },
      ],
    }
    store.saveInstrument(
      validateInstrumentCatalog(catalog, { source: 'fixture', retrievedAt: 1 }),
      catalog,
    )
    store.saveQualityPolicy(PAPER_MARKET_QUALITY_POLICY, 1)
    const receivedAt = 21_600_000
    for (let index = 0; index < 60; index += 1) {
      const bucketStart = receivedAt - (60 - index) * 60_000
      store.saveCandleRevision({
        id: `fixture-1m-${index}`,
        intervalMs: 60_000,
        bucketStart,
        revision: 1,
        knownAt: receivedAt,
        closeAt: bucketStart + 60_000,
        isClosed: true,
        coverage: 'complete',
        open: '100000',
        high: '100050',
        low: '99950',
        close: '100000',
        volumeBtc: '1',
        tradeCount: 1,
        sourceHash: `recorded-fixture-${index}`,
      })
    }
    store.append({
      type: 'book',
      productId: 'PF_XBTUSD',
      epoch: 1,
      seq: 1,
      eventTime: receivedAt,
      receivedAt,
      persistedAt: receivedAt,
      snapshot: true,
      contiguous: true,
      valid: true,
      bids: [{ price: '100000', quantity: '1' }],
      asks: [{ price: '100001', quantity: '1' }],
      rawJson: '{}',
    })
    store.append({
      type: 'ticker',
      productId: 'PF_XBTUSD',
      epoch: 1,
      seq: 2,
      eventTime: receivedAt,
      receivedAt,
      persistedAt: receivedAt,
      mark: '100000.5',
      last: '100000.5',
      rawJson: '{}',
    })
  } finally {
    store.close()
  }
}

export async function availablePort(): Promise<number> {
  const server = createNetServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('No loopback port assigned.')
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
  return address.port
}
