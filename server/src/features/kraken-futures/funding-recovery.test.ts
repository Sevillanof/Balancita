import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FuturesMarketStore } from './futures-market-store.ts'
import { parseHistoricalFundingResponse } from './historical-funding.ts'
import { needsFundingSighting, recoveryFrom } from './recovery-cursor.ts'

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

  it('a normal hourly poll sights only the new hour plus the 2 h re-sight, with no backlog scan', () => {
    const store = open()
    poll(store, T0 + 30_000, -5, 0)
    poll(store, T0 + HOUR + 30_000, -5, 1)
    const scan = vi.spyOn(
      store as unknown as { sightedAfterClose: () => Set<number> },
      'sightedAfterClose',
    )
    const before = sightings(store).length
    poll(store, T0 + 2 * HOUR + 30_000, -5, 2)
    poll(store, T0 + 3 * HOUR + 30_000, -5, 3)
    expect(scan).not.toHaveBeenCalled()
    const added = sightings(store).slice(before)
    const starts = (at: number) =>
      added.filter((r) => r.at === T0 + at * HOUR + 30_000).map((r) => r.start)
    expect(starts(2)).toEqual([T0, T0 + HOUR])
    expect(starts(3)).toEqual([T0 + HOUR, T0 + 2 * HOUR])
    store.close()
  })

  it('runs the one-time backlog only on the first poll of each product, never after a restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'funding-recovery-'))
    dirs.push(dir)
    const path = join(dir, 'market.sqlite')
    let store = new FuturesMarketStore(path)
    const spy = (s: FuturesMarketStore) =>
      vi.spyOn(
        s as unknown as { sightedAfterClose: () => Set<number> },
        'sightedAfterClose',
      )
    let scan = spy(store)
    poll(store, T0 + 30_000, -5, 0)
    poll(store, T0 + HOUR + 30_000, -5, 1)
    expect(scan).toHaveBeenCalledTimes(1)
    poll(store, T0 + 2 * HOUR + 30_000, -5, 2, 'PF_ETHUSD')
    expect(scan).toHaveBeenCalledTimes(2)
    store.close()
    store = new FuturesMarketStore(path)
    scan = spy(store)
    poll(store, T0 + 12 * HOUR + 30_000, -5, 12)
    poll(store, T0 + 13 * HOUR + 30_000, -5, 13, 'PF_ETHUSD')
    expect(scan).not.toHaveBeenCalled()
    store.close()
  })

  it('a failed poll leaves the backlog pending; marker rows are append-only', () => {
    const store = open()
    store.recordFundingPoll({
      productId: 'PF_XBTUSD',
      purpose: 'startup',
      scheduledAt: T0,
      startedAt: T0,
      finishedAt: T0,
      outcome: 'http_error',
      httpStatus: 500,
      response: undefined,
    })
    const scan = vi.spyOn(
      store as unknown as { sightedAfterClose: () => Set<number> },
      'sightedAfterClose',
    )
    poll(store, T0 + 30_000, -5, 0)
    expect(scan).toHaveBeenCalledTimes(1)
    const db = (store as unknown as { db: DatabaseSync }).db
    expect(() => db.exec('DELETE FROM paper_futures_funding_backlog')).toThrow(
      /immutable/,
    )
    store.close()
  })

  it('after the backlog, old holes are not refilled and no hour is sighted twice after its close', () => {
    const store = open()
    poll(store, T0 + 30_000, -5, 0)
    poll(store, T0 + 10 * HOUR + 35 * 60_000, -5, 10)
    // A hole older than the cursor stays alone: no scan, no refill.
    const hole = sightings(store).filter((r) => r.start === T0 - 3 * HOUR)
    poll(store, T0 + 11 * HOUR + 30_000, -5, 11)
    expect(sightings(store).filter((r) => r.start === T0 - 3 * HOUR)).toEqual(
      hole,
    )
    const post = sightings(store).filter((r) => r.at >= r.end)
    const old = post.filter((r) => r.start <= T0 + 8 * HOUR)
    const keys = old.map((r) => r.start)
    expect(new Set(keys).size).toBe(keys.length)
    store.close()
  })

  it('needsFundingSighting: cursor is exclusive, open hour never, floor respected', () => {
    const base = {
      endMs: 0,
      receivedAtMs: 0,
      floorMs: 0,
      resightMs: 2 * HOUR,
      sighted: undefined,
    }
    const q = (startMs: number, cursorMs: number | undefined, nowH = 20) =>
      needsFundingSighting({
        ...base,
        startMs: startMs * HOUR,
        endMs: (startMs + 1) * HOUR,
        receivedAtMs: nowH * HOUR + 1,
        cursorMs: cursorMs === undefined ? undefined : cursorMs * HOUR,
      })
    expect(q(10, 10)).toBe(false) // cursor itself
    expect(q(11, 10)).toBe(true) // first after the cursor
    expect(q(9, 10)).toBe(false) // older hole after the backlog
    expect(q(19, 19)).toBe(true) // inside the 2 h re-sight
    expect(q(20, 10)).toBe(false) // open hour
    expect(q(5, undefined)).toBe(true)
    expect(
      needsFundingSighting({
        ...base,
        startMs: 4 * HOUR,
        endMs: 5 * HOUR,
        receivedAtMs: 20 * HOUR,
        floorMs: 5 * HOUR,
        cursorMs: undefined,
      }),
    ).toBe(false)
    expect(
      needsFundingSighting({
        ...base,
        startMs: 4 * HOUR,
        endMs: 5 * HOUR,
        receivedAtMs: 20 * HOUR,
        cursorMs: 19 * HOUR,
        sighted: new Set([4 * HOUR]),
      }),
    ).toBe(false)
    expect(
      needsFundingSighting({
        ...base,
        startMs: 4 * HOUR,
        endMs: 5 * HOUR,
        receivedAtMs: 20 * HOUR,
        cursorMs: 19 * HOUR,
        sighted: new Set(),
      }),
    ).toBe(true)
  })

  it('shares one cursor helper: last recorded wins, never older than the lookback', () => {
    expect(recoveryFrom(undefined, 1000, 300)).toBe(700)
    expect(recoveryFrom(900, 1000, 300)).toBe(900)
    expect(recoveryFrom(100, 1000, 300)).toBe(700)
  })
})
