/* eslint-disable @typescript-eslint/no-explicit-any -- loosely typed JSON assertions */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { buildLiveGateway } from './gateway.ts'
import {
  CANDLES_CACHE_MS,
  CANDLES_SQL,
  CANDLES_MAX_LIMIT,
  CandlesRequestError,
  createObservabilityCandles,
  type CandlesQuery,
  type CandlesReport,
} from './observability-candles.ts'
import {
  MINUTE,
  PRODUCTS,
  sandbox,
  seedOfficialCandles,
  type OfficialCandleSeed,
  type Sandbox,
} from './observability-health-fixtures.ts'

/* All data here is synthetic (fixtures under a temp folder), never a real DB. */
const NOW = 1_790_000_000_000
const HOUR = 60 * MINUTE
const XBT = 'PF_XBTUSD'
const boxes: Sandbox[] = []
afterEach(() => {
  for (const b of boxes.splice(0))
    rmSync(b.dir, { recursive: true, force: true })
})

function box(): Sandbox {
  const b = sandbox()
  boxes.push(b)
  return b
}

const BASE = NOW - (NOW % HOUR)
const row = (
  bucket: number,
  extra: Partial<OfficialCandleSeed> = {},
): OfficialCandleSeed => ({
  product: XBT,
  intervalMs: MINUTE,
  bucket,
  ...extra,
})

function service(path: string | undefined, now = NOW, cacheMs?: number) {
  return createObservabilityCandles({
    products: PRODUCTS,
    marketDbPath: path,
    clock: () => now,
    cacheMs,
  })
}

const q = (extra: Partial<CandlesQuery> = {}): CandlesQuery => ({
  product: XBT,
  interval: '1m',
  ...extra,
})

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn()
  } catch (error) {
    if (error instanceof CandlesRequestError) return error.code
    throw error
  }
  return undefined
}

describe('observability candles (B6)', () => {
  describe('validations', () => {
    const svc = service(undefined)
    it.each([
      [{ product: 'PF_NOPE' }, 'invalid_product'],
      [{ product: '' }, 'invalid_product'],
      [{ product: '__proto__' }, 'invalid_product'],
      [{ interval: '2m' }, 'invalid_interval'],
      [{ interval: '' }, 'invalid_interval'],
      [{ interval: 'toString' }, 'invalid_interval'],
      [{ interval: 'constructor' }, 'invalid_interval'],
      [{ from: 'abc' }, 'invalid_range'],
      [{ from: '-5' }, 'invalid_range'],
      [{ from: '1.5' }, 'invalid_range'],
      [{ from: '1e9' }, 'invalid_range'],
      [{ from: '99999999999999999999' }, 'invalid_range'],
      [{ to: '' }, 'invalid_range'],
      [{ from: '2000', to: '2000' }, 'invalid_range'],
      [{ from: '3000', to: '2000' }, 'invalid_range'],
      [{ limit: '0' }, 'invalid_limit'],
      [{ limit: '-1' }, 'invalid_limit'],
      [{ limit: '1.5' }, 'invalid_limit'],
      [{ limit: 'x' }, 'invalid_limit'],
      [{ limit: String(CANDLES_MAX_LIMIT + 1) }, 'invalid_limit'],
      [
        { from: String(BASE - 2000 * MINUTE), to: String(BASE) },
        'range_too_large',
      ],
      [{ from: '0', to: String(BASE) }, 'range_too_large'],
    ] as [Partial<CandlesQuery>, string][])(
      'rejects %j as %s',
      (extra, code) => {
        expect(codeOf(() => svc.report(q(extra)))).toBe(code)
      },
    )

    it('accepts the widest range exactly and rejects one bucket more', () => {
      const to = BASE
      const ok = svc.report(
        q({
          from: String(to - CANDLES_MAX_LIMIT * MINUTE),
          to: String(to),
          limit: String(CANDLES_MAX_LIMIT),
        }),
      )
      expect(ok.candles.state).toBe('unavailable')
      expect(
        codeOf(() =>
          svc.report(
            q({
              from: String(to - (CANDLES_MAX_LIMIT + 1) * MINUTE),
              to: String(to),
            }),
          ),
        ),
      ).toBe('range_too_large')
    })

    it('the span limit scales with the interval (1500 x 1d is fine, 1501 is not)', () => {
      const day = 24 * HOUR
      const to = Math.floor(NOW / day) * day
      expect(
        codeOf(() =>
          svc.report(
            q({
              interval: '1d',
              from: String(to - 1500 * day),
              to: String(to),
              limit: '1500',
            }),
          ),
        ),
      ).toBeUndefined()
      expect(
        codeOf(() =>
          svc.report(
            q({
              interval: '1d',
              from: String(to - 1501 * day),
              to: String(to),
            }),
          ),
        ),
      ).toBe('range_too_large')
    })
  })

  describe('reads', () => {
    it('returns candles oldest first, as stored strings, with provenance', () => {
      const b = box()
      seedOfficialCandles(
        b.marketDb,
        [3, 1, 2, 0].map((i) => row(BASE + i * MINUTE, { close: `10${i}.5` })),
      )
      const report = service(b.marketDb).report(
        q({ from: String(BASE), to: String(BASE + 4 * MINUTE) }),
      )
      expect(report.schema).toBe('observability-candles.v1')
      expect(report.generated_at_ms).toBe(NOW)
      expect(report.cache_ttl_ms).toBe(CANDLES_CACHE_MS)
      expect(report.interval).toBe('1m')
      expect(report.interval_ms).toBe(MINUTE)
      expect(report.from_ms).toBe(BASE)
      expect(report.to_ms).toBe(BASE + 4 * MINUTE)
      expect(report.truncated).toBe(false)
      const c: any = report.candles
      expect(c.state).toBe('ok')
      expect(c.evidence).toMatchObject({
        source: 'paper_futures_official_candles',
        origin: 'futures-market.sqlite',
        state: 'read',
      })
      expect(c.items.map((i: any) => i.bucket_start_ms)).toEqual([
        BASE,
        BASE + MINUTE,
        BASE + 2 * MINUTE,
        BASE + 3 * MINUTE,
      ])
      expect(c.items[1]).toEqual({
        bucket_start_ms: BASE + MINUTE,
        close_at_ms: BASE + 2 * MINUTE,
        known_at_ms: BASE + 2 * MINUTE + 3000,
        open: '100.0',
        high: '101.25',
        low: '99.75',
        close: '101.5',
        volume_btc: '3.5',
        closed: true,
      })
      expect(c).toMatchObject({
        count: 4,
        expected: 4,
        missing: 0,
        gaps: [],
        first_bucket_ms: BASE,
        last_bucket_ms: BASE + 3 * MINUTE,
        last_candle_closed: true,
      })
    })

    it('does not fill holes nor invent candles: gaps are listed and counted', () => {
      const b = box()
      seedOfficialCandles(
        b.marketDb,
        [0, 1, 4, 7, 8].map((i) => row(BASE + i * MINUTE)),
      )
      const report = service(b.marketDb).report(
        q({ from: String(BASE), to: String(BASE + 12 * MINUTE) }),
      )
      const c: any = report.candles
      expect(c.items).toHaveLength(5)
      expect(c.expected).toBe(12)
      expect(c.missing).toBe(7)
      expect(c.gaps).toEqual([
        { from_ms: BASE + 2 * MINUTE, to_ms: BASE + 4 * MINUTE, missing: 2 },
        { from_ms: BASE + 5 * MINUTE, to_ms: BASE + 7 * MINUTE, missing: 2 },
        { from_ms: BASE + 9 * MINUTE, to_ms: BASE + 12 * MINUTE, missing: 3 },
      ])
      expect(c.gaps_truncated).toBe(false)
    })

    it('an empty range of a readable source is ok with zero candles, not an error', () => {
      const b = box()
      seedOfficialCandles(b.marketDb, [row(BASE - 10 * HOUR)])
      const c: any = service(b.marketDb).report(
        q({ from: String(BASE), to: String(BASE + 3 * MINUTE) }),
      ).candles
      expect(c).toMatchObject({
        state: 'ok',
        count: 0,
        expected: 3,
        missing: 3,
        items: [],
        first_bucket_ms: null,
        last_bucket_ms: null,
        last_candle_closed: null,
      })
      expect(c.gaps).toEqual([
        { from_ms: BASE, to_ms: BASE + 3 * MINUTE, missing: 3 },
      ])
    })

    it('the range is [from, to): `to` is exclusive and unaligned bounds count aligned buckets only', () => {
      const b = box()
      seedOfficialCandles(
        b.marketDb,
        [0, 1, 2, 3].map((i) => row(BASE + i * MINUTE)),
      )
      const c: any = service(b.marketDb).report(
        q({ from: String(BASE + 1000), to: String(BASE + 3 * MINUTE) }),
      ).candles
      expect(c.items.map((i: any) => i.bucket_start_ms)).toEqual([
        BASE + MINUTE,
        BASE + 2 * MINUTE,
      ])
      expect(c.expected).toBe(2)
      expect(c.missing).toBe(0)
    })

    it('separates product and interval', () => {
      const b = box()
      seedOfficialCandles(b.marketDb, [
        row(BASE),
        row(BASE, { product: 'PF_ETHUSD', close: '7.7' }),
        row(BASE, { intervalMs: 5 * MINUTE, close: '5.5' }),
      ])
      const svc = service(b.marketDb)
      const range = { from: String(BASE), to: String(BASE + 5 * MINUTE) }
      const eth: any = svc.report(q({ ...range, product: 'PF_ETHUSD' })).candles
      expect(eth.items.map((i: any) => i.close)).toEqual(['7.7'])
      const five: any = svc.report(q({ ...range, interval: '5m' })).candles
      expect(five.items.map((i: any) => i.close)).toEqual(['5.5'])
      const sol: any = svc.report(q({ ...range, product: 'PF_SOLUSD' })).candles
      expect(sol).toMatchObject({ state: 'ok', count: 0 })
    })

    it('serves the first known revision of a bucket (same rule as the chart)', () => {
      const b = box()
      seedOfficialCandles(b.marketDb, [
        row(BASE, {
          close: '100.5',
          revisionKnownAt: NOW,
          revisionClose: '999',
        }),
      ])
      const c: any = service(b.marketDb).report(
        q({ from: String(BASE), to: String(BASE + MINUTE) }),
      ).candles
      expect(c.items).toHaveLength(1)
      expect(c.items[0].close).toBe('100.5')
    })

    it('limit keeps the newest candles and says so: truncated, from_ms moved up', () => {
      const b = box()
      seedOfficialCandles(
        b.marketDb,
        Array.from({ length: 10 }, (_, i) => row(BASE + i * MINUTE)),
      )
      const report = service(b.marketDb).report(
        q({ from: String(BASE), to: String(BASE + 10 * MINUTE), limit: '3' }),
      )
      const c: any = report.candles
      expect(report.truncated).toBe(true)
      expect(report.limit).toBe(3)
      expect(report.from_ms).toBe(BASE + 7 * MINUTE)
      expect(c.items.map((i: any) => i.bucket_start_ms)).toEqual([
        BASE + 7 * MINUTE,
        BASE + 8 * MINUTE,
        BASE + 9 * MINUTE,
      ])
      expect(c.expected).toBe(3)
      expect(c.missing).toBe(0)
    })

    it('exactly `limit` candles in the range is not truncated', () => {
      const b = box()
      seedOfficialCandles(
        b.marketDb,
        Array.from({ length: 3 }, (_, i) => row(BASE + i * MINUTE)),
      )
      const report = service(b.marketDb).report(
        q({ from: String(BASE), to: String(BASE + 3 * MINUTE), limit: '3' }),
      )
      expect(report.truncated).toBe(false)
      expect(report.from_ms).toBe(BASE)
    })

    it('default range is the last `limit` buckets ending with the bucket in progress, and marks the open one as not closed', () => {
      const b = box()
      const now = BASE + 10 * MINUTE + 20_000
      seedOfficialCandles(b.marketDb, [
        row(BASE + 8 * MINUTE),
        row(BASE + 9 * MINUTE),
        // A row for the bucket still in progress would be wrong data; the
        // report must still not call it closed.
        row(BASE + 10 * MINUTE),
      ])
      const report = service(b.marketDb, now).report(q({ limit: '5' }))
      expect(report.to_ms).toBe(BASE + 11 * MINUTE)
      expect(report.from_ms).toBe(BASE + 6 * MINUTE)
      const c: any = report.candles
      expect(c.items.map((i: any) => i.closed)).toEqual([true, true, false])
      expect(c.last_candle_closed).toBe(false)
      expect(c.missing).toBe(2)
    })

    it('caps the gap list but keeps exact counts', () => {
      const b = box()
      // One candle every other minute over 400 minutes -> 200 gap runs.
      seedOfficialCandles(
        b.marketDb,
        Array.from({ length: 200 }, (_, i) => row(BASE + i * 2 * MINUTE)),
      )
      const c: any = service(b.marketDb).report(
        q({
          from: String(BASE),
          to: String(BASE + 400 * MINUTE),
          limit: '500',
        }),
      ).candles
      expect(c.count).toBe(200)
      expect(c.missing).toBe(200)
      expect(c.gaps).toHaveLength(100)
      expect(c.gaps_truncated).toBe(true)
    })

    it('caches briefly and per query, bounded', () => {
      const b = box()
      seedOfficialCandles(b.marketDb, [row(BASE)])
      let now = NOW
      const svc = createObservabilityCandles({
        products: PRODUCTS,
        marketDbPath: b.marketDb,
        clock: () => now,
        cacheMs: 1000,
      })
      const range = q({ from: String(BASE), to: String(BASE + MINUTE) })
      const first = svc.report(range)
      expect(svc.report(range)).toBe(first)
      expect(svc.report(q({ ...range, limit: '5' }))).not.toBe(first)
      now += 999
      expect(svc.report(range)).toBe(first)
      now += 1
      expect(svc.report(range)).not.toBe(first)
      for (let i = 0; i < 200; i += 1)
        svc.report(q({ from: String(BASE + i), to: String(BASE + MINUTE + i) }))
      expect(svc.report(range)).toBeDefined()
    })

    it('the query walks the primary key of the range (no table scan)', () => {
      const b = box()
      seedOfficialCandles(b.marketDb, [row(BASE)])
      const db = new DatabaseSync(b.marketDb, { readOnly: true })
      const plan = db
        .prepare(`EXPLAIN QUERY PLAN ${CANDLES_SQL}`)
        .all(XBT, MINUTE, 0, 1, 5)
        .map((r: any) => String(r.detail))
      db.close()
      const scan = plan.find((d) =>
        d.includes('paper_futures_official_candles'),
      )
      expect(scan).toMatch(
        /SEARCH .*USING (COVERING )?INDEX .*product_id=\? AND interval_ms=\? AND bucket_start>\? AND bucket_start<\?/,
      )
      expect(
        plan.some((d) => /^SCAN paper_futures_official_candles/.test(d)),
      ).toBe(false)
    })

    it('never writes: the source file is byte-identical after reads', () => {
      const b = box()
      seedOfficialCandles(b.marketDb, [row(BASE)])
      const db = new DatabaseSync(b.marketDb)
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      db.close()
      const before = readFileSync(b.marketDb)
      service(b.marketDb).report(
        q({ from: String(BASE), to: String(BASE + MINUTE) }),
      )
      expect(readFileSync(b.marketDb).equals(before)).toBe(true)
    })
  })

  describe('source absent or unreadable is a state, not an error', () => {
    const range = { from: String(BASE), to: String(BASE + MINUTE) }
    it('not configured', () => {
      const report = service(undefined).report(q(range))
      expect(report.candles).toMatchObject({
        state: 'unavailable',
        detail: 'source_not_configured',
        evidence: { state: 'missing', origin: null },
      })
      expect((report.candles as any).items).toBeUndefined()
      expect(report.truncated).toBe(false)
    })
    it('file not found', () => {
      const report = service('/ruta/inexistente/futures-market.sqlite').report(
        q(range),
      )
      expect(report.candles).toMatchObject({
        state: 'unavailable',
        detail: 'file_not_found',
        evidence: { state: 'missing', origin: 'futures-market.sqlite' },
      })
    })
    it('not a SQLite file', () => {
      const b = box()
      writeFileSync(b.marketDb, 'esto no es sqlite'.repeat(100))
      const report = service(b.marketDb).report(q(range))
      expect(report.candles.state).toBe('unavailable')
      expect(report.candles.evidence.state).toBe('unreadable')
    })
    it('a database without the candles table', () => {
      const b = box()
      const db = new DatabaseSync(b.marketDb)
      db.exec('CREATE TABLE otra(x)')
      db.close()
      const report = service(b.marketDb).report(q(range))
      expect(report.candles.state).toBe('unavailable')
    })
    it('an old schema without product_id', () => {
      const b = box()
      const db = new DatabaseSync(b.marketDb)
      db.exec(
        'CREATE TABLE paper_futures_official_candles(interval_ms INTEGER, bucket_start INTEGER)',
      )
      db.close()
      const report = service(b.marketDb).report(q(range))
      expect(report.candles).toMatchObject({
        state: 'unavailable',
        detail: 'schema_without_product_id',
      })
    })
  })

  describe('through the gateway', () => {
    async function gateway(b: Sandbox) {
      return buildLiveGateway({
        marketDbPath: b.marketDb,
        products: PRODUCTS,
        clock: () => NOW,
      })
    }
    it('400 with a code on every rejection, repeated params included; 200 otherwise', async () => {
      const b = box()
      seedOfficialCandles(b.marketDb, [row(BASE)])
      const server = await gateway(b)
      try {
        const get = (qs: string) =>
          server.inject({ url: `/api/observability/candles?${qs}` })
        const ok = await get(
          `product=${XBT}&interval=1m&from=${BASE}&to=${BASE + MINUTE}`,
        )
        expect(ok.statusCode).toBe(200)
        expect(ok.json().candles.items).toHaveLength(1)
        const cases: [string, string][] = [
          ['interval=1m', 'invalid_product'],
          [`product=${XBT}`, 'invalid_interval'],
          [`product=${XBT}&interval=3m`, 'invalid_interval'],
          [`product=${XBT}&interval=1m&interval=5m`, 'invalid_interval'],
          [`product=${XBT}&interval=1m&from=x`, 'invalid_range'],
          [`product=${XBT}&interval=1m&from=1&from=2`, 'invalid_range'],
          [`product=${XBT}&interval=1m&limit=1501`, 'invalid_limit'],
          [`product=${XBT}&interval=1m&from=0&to=${BASE}`, 'range_too_large'],
        ]
        for (const [qs, code] of cases) {
          const res = await get(qs)
          expect([qs, res.statusCode]).toEqual([qs, 400])
          expect(res.json()).toEqual({ error: { code } })
        }
        // Unknown route: 404 only here.
        expect(
          (await server.inject({ url: '/api/observability/velas' })).statusCode,
        ).toBe(404)
        expect(
          (
            await server.inject({
              url: `/api/observability/candles/${XBT}`,
            })
          ).statusCode,
        ).toBe(404)
        // The route is read-only.
        expect(
          (
            await server.inject({
              method: 'POST',
              url: `/api/observability/candles?product=${XBT}&interval=1m`,
            })
          ).statusCode,
        ).toBe(404)
      } finally {
        await server.close()
      }
    })

    it('an absent source is a 200 with an explicit state, never a 404', async () => {
      const server = await buildLiveGateway({
        marketDbPath: '/ruta/inexistente/futures-market.sqlite',
        products: PRODUCTS,
        clock: () => NOW,
      })
      try {
        const res = await server.inject({
          url: `/api/observability/candles?product=${XBT}&interval=1m`,
        })
        expect(res.statusCode).toBe(200)
        expect(res.json().candles).toMatchObject({
          state: 'unavailable',
          detail: 'file_not_found',
        })
      } finally {
        await server.close()
      }
    })
  })

  // SYNTHETIC performance check, not a measurement of real data. Rows are
  // generated on a temp DB: 8 products x 1m candles over 30 days would be
  // 345k rows; we seed 1 product x 90 days of 1m (129.6k rows) + noise
  // products, and read the widest allowed range (1500 candles).
  describe('performance (synthetic data, temp DB)', () => {
    it('reads the widest range in a bounded time out of ~260k rows', () => {
      const b = box()
      const total = 90 * 24 * 60
      const rows: OfficialCandleSeed[] = []
      const start = BASE - total * MINUTE
      for (let i = 0; i < total; i += 1) {
        rows.push(row(start + i * MINUTE))
        if (i % 2 === 0)
          rows.push(row(start + i * MINUTE, { product: 'PF_ETHUSD' }))
      }
      seedOfficialCandles(b.marketDb, rows)
      const svc = service(b.marketDb, NOW, 0)
      const timings: number[] = []
      for (let n = 0; n < 20; n += 1) {
        const to = BASE - n * 7 * HOUR
        const t0 = performance.now()
        const report = svc.report(
          q({
            from: String(to - CANDLES_MAX_LIMIT * MINUTE),
            to: String(to),
            limit: String(CANDLES_MAX_LIMIT),
          }),
        )
        timings.push(performance.now() - t0)
        expect((report.candles as any).count).toBe(CANDLES_MAX_LIMIT)
      }
      timings.sort((a, c) => a - c)
      const median = timings[10]
      const worst = timings[19]
      console.info(
        `[B6 perf, SYNTHETIC] ${rows.length} rows, 1500 candles: median ${median.toFixed(1)} ms, worst ${worst.toFixed(1)} ms`,
      )
      // Generous ceilings (CI noise); a full scan of this table is far slower.
      expect(median).toBeLessThan(150)
      expect(worst).toBeLessThan(500)
    }, 120_000)
  })

  describe('documented examples (docs/mission-control/b6/)', () => {
    const dir = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../../../../docs/mission-control/b6',
    )
    const range = (from: number, to: number) => ({
      from: String(from),
      to: String(to),
    })
    const scenarios: Record<string, () => CandlesReport> = {
      'ejemplo-con-huecos': () => {
        const b = box()
        seedOfficialCandles(
          b.marketDb,
          [0, 1, 2, 5, 6].map((i) =>
            row(BASE + i * MINUTE, { close: `${100 + i}.5` }),
          ),
        )
        return service(b.marketDb).report(q(range(BASE, BASE + 8 * MINUTE)))
      },
      'ejemplo-truncado': () => {
        const b = box()
        seedOfficialCandles(
          b.marketDb,
          Array.from({ length: 6 }, (_, i) =>
            row(BASE + i * 5 * MINUTE, { intervalMs: 5 * MINUTE }),
          ),
        )
        return service(b.marketDb).report(
          q({ interval: '5m', limit: '3', ...range(BASE, BASE + 30 * MINUTE) }),
        )
      },
      'ejemplo-fuente-ausente': () =>
        service('/ruta/inexistente/futures-market.sqlite').report(
          q(range(BASE, BASE + 3 * MINUTE)),
        ),
    }
    for (const [name, build] of Object.entries(scenarios))
      it(`${name}.json matches what the code produces`, () => {
        const file = resolve(dir, `${name}.json`)
        const text = `${JSON.stringify(build(), null, 2)}\n`
        if (process.env.UPDATE_CANDLES_EXAMPLES === '1') {
          mkdirSync(dir, { recursive: true })
          writeFileSync(file, text)
        }
        expect(readFileSync(file, 'utf8')).toBe(text)
      })
  })
})
