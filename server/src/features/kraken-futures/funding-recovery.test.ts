import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { FuturesMarketStore } from './futures-market-store.ts'
import { parseHistoricalFundingResponse } from './historical-funding.ts'
import { recoveryFrom } from './recovery-cursor.ts'

const HOUR = 3_600_000
// T0 plays the 14:00 hour; the Mac goes off at 14:30 (T0 + 30 min).
const T0 = Math.floor(1_790_000_000_000 / HOUR) * HOUR

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

const open = () => {
  const dir = mkdtempSync(join(tmpdir(), 'funding-recovery-'))
  dirs.push(dir)
  return new FuturesMarketStore(join(dir, 'market.sqlite'))
}

/** Kraken lists hours `from..to` (inclusive); the last one is the open one. */
const poll = (
  store: FuturesMarketStore,
  receivedAt: number,
  from: number,
  to: number,
  productId = 'PF_XBTUSD',
) => {
  const rates = []
  for (let k = from; k <= to; k += 1)
    rates.push({
      timestamp: new Date(T0 + k * HOUR).toISOString(),
      fundingRate: 0.1 + k / 1000,
      relativeFundingRate: 0.00001,
    })
  return store.recordFundingPoll({
    productId,
    purpose: 'startup',
    scheduledAt: receivedAt,
    startedAt: receivedAt,
    finishedAt: receivedAt,
    outcome: 'ok',
    response: parseHistoricalFundingResponse(
      JSON.stringify({
        result: 'success',
        serverTime: new Date(receivedAt).toISOString(),
        rates,
      }),
      receivedAt,
    ),
  })
}

const sightings = (store: FuturesMarketStore, productId = 'PF_XBTUSD') =>
  store.fundingSightings(productId, Number.MAX_SAFE_INTEGER)!.map((r) => ({
    start: r.startMs as number,
    end: r.endMs as number,
    at: r.receivedAt as number,
  }))

describe('funding recovery from the last recorded hour', () => {
  it('after 10 h off with shutdown mid-hour, every hour from 14:00 has a post-close sighting at the restart time', () => {
    const store = open()
    // Before the shutdown: poll at 14:00:30 sights up to hour -1, lists hour 0 open.
    poll(store, T0 + 30_000, -5, 0)
    const restart = T0 + 10 * HOUR + 35 * 60_000
    poll(store, restart, -5, 10)
    const rows = sightings(store)
    for (let k = 0; k < 10; k += 1) {
      const post = rows.filter(
        (r) => r.start === T0 + k * HOUR && r.at >= r.end,
      )
      expect(post.map((r) => r.at)).toEqual([restart])
    }
    // The hour that is open at the restart gets no sighting.
    expect(rows.some((r) => r.start === T0 + 10 * HOUR)).toBe(false)
    store.close()
  })

  it('does not repeat recovered hours on the next polls', () => {
    const store = open()
    poll(store, T0 + 30_000, -5, 0)
    poll(store, T0 + 10 * HOUR + 35 * 60_000, -5, 10)
    const before = sightings(store).length
    poll(store, T0 + 11 * HOUR + 30_000, -5, 11)
    // Only the usual two hour re-sighting window.
    expect(
      sightings(store)
        .slice(before)
        .map((r) => r.start)
        .sort(),
    ).toEqual([T0 + 9 * HOUR, T0 + 10 * HOUR])
    poll(store, T0 + 14 * HOUR + 30_000, -5, 14)
    expect(
      sightings(store).filter((r) => r.start === T0 + 3 * HOUR),
    ).toHaveLength(1)
    store.close()
  })

  it('records an old backlog once on a first run, capped to the lookback', () => {
    const store = open()
    const now = T0 + 40 * 24 * HOUR + 30_000
    // Kraken returns 40 days of history; the cap keeps the last 32 days.
    poll(store, now, 0, 40 * 24)
    const rows = sightings(store)
    expect(rows).toHaveLength(32 * 24 - 1)
    expect(rows.every((r) => r.at === now)).toBe(true)
    expect(Math.min(...rows.map((r) => r.start))).toBe(
      T0 + (40 * 24 - 32 * 24 + 1) * HOUR,
    )
    store.close()
  })

  it('recovers a disconnect without restart on the next successful poll', () => {
    const store = open()
    poll(store, T0 + 30_000, -3, 0)
    const back = T0 + 4 * HOUR + 10 * 60_000
    poll(store, back, -3, 4)
    expect(
      sightings(store)
        .filter((r) => r.at === back)
        .map((r) => r.start),
    ).toEqual([T0, T0 + HOUR, T0 + 2 * HOUR, T0 + 3 * HOUR])
    store.close()
  })

  it('does not count a sighting taken before the close as recorded after it', () => {
    const store = open()
    store.close()
    const path = join(dirs[0]!, 'market.sqlite')
    const db = new DatabaseSync(path)
    db.prepare(
      "INSERT INTO paper_futures_funding_sightings VALUES('PF_XBTUSD',?,?,'0.1',?,'t','h')",
    ).run(T0 + 3 * HOUR, T0 + 3 * HOUR + 1_000, T0 + 4 * HOUR)
    db.close()
    const again = new FuturesMarketStore(path)
    poll(again, T0 + 9 * HOUR + 30_000, 0, 9)
    expect(
      sightings(again).filter(
        (r) => r.start === T0 + 3 * HOUR && r.at >= r.end,
      ),
    ).toHaveLength(1)
    again.close()
  })

  it('keeps products independent', () => {
    const store = open()
    poll(store, T0 + 30_000, -3, 0, 'PF_XBTUSD')
    poll(store, T0 + 5 * HOUR + 30_000, -3, 5, 'PF_XBTUSD')
    poll(store, T0 + 5 * HOUR + 40_000, -3, 5, 'PF_ETHUSD')
    const eth = sightings(store, 'PF_ETHUSD')
    expect(eth).toHaveLength(8)
    expect(eth.every((r) => r.at === T0 + 5 * HOUR + 40_000)).toBe(true)
    store.close()
  })

  it('shares one cursor helper: last recorded wins, never older than the lookback', () => {
    expect(recoveryFrom(undefined, 1000, 300)).toBe(700)
    expect(recoveryFrom(900, 1000, 300)).toBe(900)
    expect(recoveryFrom(100, 1000, 300)).toBe(700)
  })
})
