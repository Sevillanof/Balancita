import { lstatSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, resolve, sep } from 'node:path'
import {
  decodeProviderJson,
  FUTURES_PRODUCT,
  FUTURES_WS_URL,
  KrakenFuturesMarketCollector,
  type FuturesSocket,
  parseBookMessage,
  parseTickerMessage,
  parseTradeMessage,
  PAPER_MARKET_QUALITY_POLICY,
  validateInstrumentCatalog,
} from './futures-market.ts'
import { FuturesCandleBuilder } from './futures-candles.ts'
import { FuturesMarketStore } from './futures-market-store.ts'

const usage =
  'Usage: node --experimental-strip-types server/src/features/kraken-futures/capture-market.ts --mode mock|paper_live --db-path <new-temp-file> [--seconds 15] [--export <new-file>]'
const MOCK_TIME = 1_790_950_000_000

function args(argv: string[]): Map<string, string> {
  const result = new Map<string, string>()
  const allowed = new Set(['--mode', '--db-path', '--seconds', '--export'])
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (
      !key?.startsWith('--') ||
      !allowed.has(key) ||
      !value ||
      value.startsWith('--') ||
      result.has(key)
    )
      throw new Error(usage)
    result.set(key, value)
  }
  return result
}

function isolatedPath(value: string, label: string): string {
  const path = resolve(value)
  if (
    !path.startsWith(`${resolve(tmpdir())}${sep}`) ||
    !basename(path).startsWith('balancita-futures-market-')
  )
    throw new Error(
      `${label} must be a new file under the operating-system temporary directory with basename balancita-futures-market-*.`,
    )
  try {
    lstatSync(path)
    throw new Error(
      `${label} already exists; refusing to open or overwrite it.`,
    )
  } catch (error) {
    if (error instanceof Error && error.message.includes('already exists'))
      throw error
  }
  return path
}

async function fetchCatalog(): Promise<{
  rawJson: string
  spec: ReturnType<typeof validateInstrumentCatalog>
}> {
  const response = await fetch(
    'https://futures.kraken.com/derivatives/api/v3/instruments',
    {
      signal: AbortSignal.timeout(10_000),
      headers: {
        accept: 'application/json',
        'user-agent': 'Balancita public futures market capture',
      },
    },
  )
  if (!response.ok)
    throw new Error(
      `Public instrument catalog returned HTTP ${response.status}.`,
    )
  if (!response.body)
    throw new Error('Public instrument catalog has no response body.')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    totalBytes += value.byteLength
    if (totalBytes > 5_000_000) {
      await reader.cancel()
      throw new RangeError(
        'Public instrument catalog exceeds the 5 MB response bound.',
      )
    }
    chunks.push(value)
  }
  const text = Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
  ).toString('utf8')
  const decoded = decodeProviderJson(text, 5_000_000)
  const spec = validateInstrumentCatalog(decoded, {
    source: 'live',
    retrievedAt: Date.now(),
  })
  return { rawJson: text, spec }
}

function fixtureCatalog(): unknown {
  return {
    instruments: [
      {
        symbol: FUTURES_PRODUCT,
        type: 'flexible_futures',
        pair: 'BTC:USD',
        base: 'BTC',
        quote: 'USD',
        contractSize: '1',
        contractValueTradePrecision: '4',
        tickSize: '1',
        tradeable: true,
        isExpired: false,
      },
    ],
  }
}

function runMock(
  store: FuturesMarketStore,
  candles: FuturesCandleBuilder,
): void {
  const receivedAt = MOCK_TIME
  const context = { receivedAt, persistedAt: receivedAt, epoch: 1 }
  const book = parseBookMessage(
    decodeProviderJson(
      JSON.stringify({
        feed: 'book_snapshot',
        product_id: FUTURES_PRODUCT,
        seq: 1,
        timestamp: receivedAt - 1,
        bids: [{ price: '90000', qty: '0.5' }],
        asks: [{ price: '90001', qty: '0.5' }],
      }),
    ),
    context,
  )
  const ticker = parseTickerMessage(
    decodeProviderJson(
      JSON.stringify({
        feed: 'ticker',
        product_id: FUTURES_PRODUCT,
        seq: 1,
        time: receivedAt - 1,
        bid: '90000',
        ask: '90001',
        last: '90000.5',
        markPrice: '90000',
        index: '89999',
        suspended: false,
      }),
    ),
    context,
  )
  const trade = parseTradeMessage(
    decodeProviderJson(
      JSON.stringify({
        feed: 'trade',
        product_id: FUTURES_PRODUCT,
        uid: 'fixture-trade-1',
        side: 'buy',
        type: 'fill',
        seq: 1,
        time: receivedAt - 1,
        qty: '0.0001',
        price: '90000.5',
      }),
    ),
    context,
  )
  store.append(book)
  store.append(ticker)
  if (store.append(trade) === 'inserted') candles.addTrade(trade, receivedAt)
  candles.advanceClock(receivedAt + 60_000)
}

async function runLive(
  store: FuturesMarketStore,
  candles: FuturesCandleBuilder,
  seconds: number,
): Promise<void> {
  store.saveQualityPolicy(PAPER_MARKET_QUALITY_POLICY, Date.now())
  if (typeof WebSocket === 'undefined')
    throw new Error(
      'This Node runtime does not expose WebSocket; live capture unavailable.',
    )
  const collector = new KrakenFuturesMarketCollector({
    clock: Date.now,
    random: Math.random,
    makeSocket: (url) => new WebSocket(url) as unknown as FuturesSocket,
    setTimeout,
    clearTimeout,
    persist: (event) => store.append(event),
    persistGap: (gap) => store.appendGap(gap),
    onTrade: (trade) => candles.addTrade(trade, Date.now()),
    onState: (state, reason) =>
      process.stderr.write(
        `${new Date().toISOString()} ${state}${reason ? ` ${reason}` : ''}\n`,
      ),
  })
  collector.start()
  let liveMetrics: unknown
  try {
    await new Promise<void>((resolvePromise) =>
      setTimeout(resolvePromise, seconds * 1000),
    )
    liveMetrics = {
      status: collector.status,
      metrics: collector.metrics,
      book: collector.book,
      qualityPolicy: PAPER_MARKET_QUALITY_POLICY.version,
      sourceGuarantee: 'undocumented',
      fundingStatus: 'unknown_or_provider_unresolved',
    }
  } finally {
    collector.stop()
  }
  candles.advanceClock(Date.now())
  process.stderr.write(
    `collector_metrics phase=pre_stop ${JSON.stringify(liveMetrics)}\n`,
  )
  process.stderr.write(
    `collector_metrics phase=post_stop ${JSON.stringify({ status: collector.status, metrics: collector.metrics, book: collector.book })}\n`,
  )
}

async function main(): Promise<void> {
  if (process.env.EXECUTION_MODE !== undefined)
    throw new Error('EXECUTION_MODE is unsupported by the market capture CLI.')
  const options = args(process.argv.slice(2))
  const mode = options.get('--mode')
  const rawDbPath = options.get('--db-path')
  const seconds = Number(options.get('--seconds') ?? '15')
  if (
    (mode !== 'mock' && mode !== 'paper_live') ||
    !rawDbPath ||
    !Number.isSafeInteger(seconds) ||
    seconds < 1 ||
    seconds > 30
  )
    throw new Error(usage)
  const dbPath = isolatedPath(rawDbPath, 'Database path')
  const exportPath = options.has('--export')
    ? isolatedPath(options.get('--export')!, 'Export path')
    : undefined
  let store = new FuturesMarketStore(dbPath)
  try {
    if (mode === 'mock') {
      const catalog = fixtureCatalog()
      const spec = validateInstrumentCatalog(catalog, {
        source: 'fixture',
        retrievedAt: MOCK_TIME,
      })
      store.saveInstrument(spec, catalog)
      const candles = new FuturesCandleBuilder(store)
      runMock(store, candles)
      process.stderr.write(
        `source=mock product=${FUTURES_PRODUCT} entry_eligibility=${spec.entryEligibility}\n`,
      )
    } else {
      const { rawJson, spec } = await fetchCatalog()
      store.saveInstrument(spec, rawJson)
      process.stderr.write(
        `source=paper_live url=${FUTURES_WS_URL} product=${FUTURES_PRODUCT} entry_eligibility=${spec.entryEligibility} metadata_hash=${spec.metadataHash}\n`,
      )
      if (spec.entryEligibility !== 'eligible')
        throw new Error(
          'Paper-live capture is blocked because instrument metadata is not eligible.',
        )
      const candles = new FuturesCandleBuilder(store)
      await runLive(store, candles, seconds)
    }
    store.close()
    store = new FuturesMarketStore(dbPath)
    process.stderr.write(
      `reopened_events=${store.eventCount()} candle_revisions=${store.candleRevisions().length}\n`,
    )
    const jsonl = store.exportJsonl()
    if (exportPath) writeFileSync(exportPath, jsonl, { flag: 'wx' })
    process.stdout.write(jsonl)
  } finally {
    store.close()
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  )
  process.exitCode = 1
})
