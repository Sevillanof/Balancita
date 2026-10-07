import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { mockBars, seedMockMarket } from './mock-market.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('mock market', () => {
  it('is deterministic and ends at the requested minute', () => {
    const end = 1_790_000_000_000
    expect(mockBars(end, 50)).toEqual(mockBars(end, 50))
    const bars = mockBars(end, 50)
    expect(bars).toHaveLength(50)
    expect(bars.at(-1)!.start + 60_000).toBe(end - (end % 60_000))
    expect(bars.every((bar) => bar.low <= bar.close && bar.close <= bar.high)).toBe(true)
  })

  it('writes official 1m and 5m candles and one ticker per minute', () => {
    const dir = mkdtempSync(join(tmpdir(), 'balancita-mock-'))
    dirs.push(dir)
    const path = join(dir, 'market.sqlite')
    const seeded = seedMockMarket(path, { endMs: 1_790_000_000_000, minutes: 60 })
    expect(seeded.bars).toBe(60)
    const db = new DatabaseSync(path, { readOnly: true })
    const count = (sql: string) =>
      Number((db.prepare(sql).get() as { n: number }).n)
    expect(count('SELECT COUNT(*) n FROM paper_futures_official_candles WHERE interval_ms=60000')).toBe(60)
    expect(count('SELECT COUNT(*) n FROM paper_futures_official_candles WHERE interval_ms=300000')).toBeGreaterThanOrEqual(11)
    expect(count("SELECT COUNT(*) n FROM paper_futures_market_events WHERE feed='ticker'")).toBe(60)
    db.close()
  })
})
