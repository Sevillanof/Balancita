import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { FuturesMarketStore } from './futures-market-store.ts'
import { archiveQuotes } from './quote-archive.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

let seq = 0
function ticker(
  productId: string,
  receivedAt: number,
  bid = '100',
  ask = '101',
) {
  seq += 1
  return {
    type: 'ticker' as const,
    productId,
    epoch: 1_000_000,
    seq: seq,
    eventTime: receivedAt,
    receivedAt,
    persistedAt: receivedAt,
    last: '100.5',
    bid,
    ask,
    mark: '100.5',
    suspended: false,
    funding: { status: 'unknown' as const },
    raw: { source: 'rest', bid_size: '3', ask_size: '4' },
  }
}

function setup(times: number[], product = 'PF_ETHUSD') {
  const dir = mkdtempSync(join(tmpdir(), 'balancita-quotes-'))
  dirs.push(dir)
  const market = join(dir, 'market.sqlite')
  const store = new FuturesMarketStore(market)
  for (const t of times) store.append(ticker(product, t))
  store.close()
  return { market, quotes: join(dir, 'quotes.sqlite') }
}
const NOW = 100 * 86_400_000
const opts = { minFreeBytes: 0, now: NOW, maxDays: 1000 }

describe('archiveQuotes', () => {
  it('thins to one quote per interval, keeps sizes, and is idempotent', () => {
    const { market, quotes } = setup([1_000, 2_000, 11_000, 12_000, 21_000])
    const first = archiveQuotes({
      marketDb: market,
      quotesDb: quotes,
      minIntervalMs: 10_000,
      ...opts,
    })
    expect(first.stored).toBe(3)
    expect(
      archiveQuotes({
        marketDb: market,
        quotesDb: quotes,
        minIntervalMs: 10_000,
        ...opts,
      }).stored,
    ).toBe(0)
    const db = new DatabaseSync(quotes)
    const row = db
      .prepare(
        'SELECT bid, ask, bid_size, ask_size, source FROM quote_snapshot LIMIT 1',
      )
      .get() as Record<string, string>
    expect(row).toMatchObject({
      bid: '100',
      ask: '101',
      bid_size: '3',
      ask_size: '4',
      source: 'rest',
    })
    db.close()
  })

  it('logs a gap when a product goes silent and never writes to the market database', () => {
    const { market, quotes } = setup([1_000, 500_000])
    const result = archiveQuotes({
      marketDb: market,
      quotesDb: quotes,
      minIntervalMs: 1_000,
      gapMs: 60_000,
      ...opts,
    })
    expect(result.gaps).toBe(1)
    const db = new DatabaseSync(quotes)
    expect(
      db.prepare('SELECT from_ms, to_ms FROM quote_archive_gap').get(),
    ).toMatchObject({ from_ms: 1_000, to_ms: 500_000 })
    db.close()
    const m = new DatabaseSync(market, { readOnly: true })
    expect(() => m.exec('DELETE FROM paper_futures_market_events')).toThrow()
    m.close()
  })

  it('drops quotes older than the age limit', () => {
    const { market, quotes } = setup([NOW - 3 * 86_400_000, NOW - 1_000])
    const result = archiveQuotes({
      marketDb: market,
      quotesDb: quotes,
      ...opts,
      maxDays: 1,
    })
    expect(result.trimmed).toBe(1)
    const db = new DatabaseSync(quotes)
    expect(
      (
        db.prepare('SELECT COUNT(*) AS n FROM quote_snapshot').get() as {
          n: number
        }
      ).n,
    ).toBe(1)
    db.close()
  })

  it('stops and logs the gap when the disk is nearly full', () => {
    const { market, quotes } = setup([1_000])
    const result = archiveQuotes({
      marketDb: market,
      quotesDb: quotes,
      now: NOW,
      minFreeBytes: Number.MAX_SAFE_INTEGER,
    })
    expect(result.stopped).toBe('low disk space')
    expect(result.stored).toBe(0)
  })
})
