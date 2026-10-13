/* eslint-disable @typescript-eslint/no-explicit-any -- loosely typed JSON assertions */
import { createHash } from 'node:crypto'
import {
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { buildLiveGateway } from './gateway.ts'
import {
  createObservabilityActivity,
  isActivityWindow,
  type ObservabilityActivityOptions,
  type ObservabilityActivityReport,
} from './observability-activity.ts'
import {
  MINUTE,
  PRODUCTS,
  sandbox,
  seedForward,
  seedForwardTrades,
  seedStrategies,
  seedVerdictRows,
  writeForwardConfig,
  type Sandbox,
  type VerdictRow,
} from './observability-health-fixtures.ts'

const NOW = 1_790_000_000_000
const TO = NOW - (NOW % MINUTE)
const HOUR = 60 * MINUTE
const boxes: Sandbox[] = []
afterEach(() => {
  for (const box of boxes.splice(0))
    rmSync(box.dir, { recursive: true, force: true })
})

function box(): Sandbox {
  const b = sandbox()
  boxes.push(b)
  return b
}

function optionsOf(b: Sandbox): ObservabilityActivityOptions {
  return {
    products: PRODUCTS,
    verdictsDbPath: b.verdictsDb,
    forwardDbPath: b.forwardDb,
    strategiesDbPath: b.strategiesDb,
    forwardRegistrationPath: b.registration,
    strategySpecsDir: b.specsDir,
    clock: () => NOW,
  }
}

/** `minutes` consecutive verdicts per product, ending at the last closed minute. */
function continuous(
  products: readonly string[],
  minutes: number,
  pick: (product: string, i: number) => [string, string] = () => [
    'WAIT',
    'no_directional_proposal',
  ],
): VerdictRow[] {
  const rows: VerdictRow[] = []
  for (const product of products)
    for (let i = 0; i < minutes; i += 1) {
      const [action, reason] = pick(product, i)
      rows.push({ product, bucket: TO - (i + 1) * MINUTE, action, reason })
    }
  return rows
}

function seedForwardWorld(b: Sandbox): void {
  seedForward(b.forwardDb, {
    now: NOW,
    strategies: ['C29', 'C30'],
    checkedAgeMs: 5 * MINUTE,
  })
  seedStrategies(
    b.strategiesDb,
    [
      { id: 'C29', state: 'active' },
      { id: 'C30', state: 'active' },
    ],
    NOW,
  )
  writeForwardConfig(b, [], [])
}

/** Gives the strategy an open position on these products (the others stay empty). */
function openPositions(b: Sandbox, strategy: string, products: string[]) {
  const db = new DatabaseSync(b.forwardDb)
  const update = db.prepare(
    'UPDATE forward_open SET payload = ? WHERE strategy_id = ? AND product_id = ?',
  )
  for (const product of products)
    update.run(JSON.stringify({ side: 'LONG' }), strategy, product)
  db.close()
}

const report = (
  b: Sandbox,
  window: '3h' | '24h' = '3h',
  product?: string,
): ObservabilityActivityReport =>
  createObservabilityActivity(optionsOf(b)).report(window, product)

const sha = (path: string) =>
  createHash('sha256').update(readFileSync(path)).digest('hex')

describe('observability activity', () => {
  describe('evaluations, signals and discards (verdicts)', () => {
    it('counts the rows of each window, not those of the whole table', () => {
      const b = box()
      seedVerdictRows(b.verdictsDb, continuous(['PF_XBTUSD'], 24 * 60))
      const three = report(b, '3h').evaluations as any
      const day = report(b, '24h').evaluations as any
      expect(three.state).toBe('ok')
      const xbt3 = three.by_product.find((p: any) => p.product === 'PF_XBTUSD')
      const xbt24 = day.by_product.find((p: any) => p.product === 'PF_XBTUSD')
      expect([xbt3.count, xbt3.expected, xbt3.missing]).toEqual([180, 180, 0])
      expect([xbt24.count, xbt24.expected, xbt24.missing]).toEqual([
        1440, 1440, 0,
      ])
      expect(xbt3.last_bucket_ms).toBe(TO - MINUTE)
      expect(xbt3.first_bucket_ms).toBe(TO - 180 * MINUTE)
    })

    it('applies [from, to): the first minute is in, the unfinished one and older rows are out', () => {
      const b = box()
      seedVerdictRows(b.verdictsDb, [
        {
          product: 'PF_XBTUSD',
          bucket: TO - 3 * HOUR - MINUTE,
          action: 'WAIT',
          reason: 'old',
        },
        {
          product: 'PF_XBTUSD',
          bucket: TO - 3 * HOUR,
          action: 'WAIT',
          reason: 'first',
        },
        {
          product: 'PF_XBTUSD',
          bucket: TO,
          action: 'WAIT',
          reason: 'unfinished',
        },
      ])
      const r = report(b)
      const reasons = (r.discards as any).by_reason.map(
        (x: any) => x.reason_code,
      )
      expect(reasons).toEqual(['first'])
      expect((r.evaluations as any).total).toBe(1)
    })

    it('reports minutes without a verdict as missing instead of hiding them', () => {
      const b = box()
      const rows = continuous(['PF_ETHUSD'], 180).filter((_, i) => i % 3 !== 0)
      seedVerdictRows(b.verdictsDb, rows)
      const eth = (report(b).evaluations as any).by_product.find(
        (p: any) => p.product === 'PF_ETHUSD',
      )
      expect(eth.count).toBe(120)
      expect(eth.missing).toBe(60)
    })

    it('a product with no rows is zero evaluations (read) and has no timestamps', () => {
      const b = box()
      seedVerdictRows(b.verdictsDb, continuous(['PF_XBTUSD'], 10))
      const sol = (report(b).evaluations as any).by_product.find(
        (p: any) => p.product === 'PF_SOLUSD',
      )
      expect(sol).toMatchObject({
        count: 0,
        missing: 180,
        first_bucket_ms: null,
        last_bucket_ms: null,
        last_known_at_ms: null,
        last_signal: null,
      })
    })

    it('splits directional signals from discards and groups discards by reason', () => {
      const b = box()
      seedVerdictRows(
        b.verdictsDb,
        continuous(['PF_XBTUSD', 'PF_ETHUSD'], 60, (product, i) => {
          if (product === 'PF_XBTUSD' && i === 5)
            return ['LONG', 'c25_long_pullback']
          if (product === 'PF_XBTUSD' && i === 2)
            return ['SHORT', 'c27_short_breakout']
          if (i % 10 === 0) return ['ABSTAIN', 'conflicting_signals']
          return ['WAIT', 'no_directional_proposal']
        }),
      )
      const r = report(b)
      const signals = r.signals as any
      expect([signals.long, signals.short]).toEqual([1, 1])
      const xbt = (r.evaluations as any).by_product.find(
        (p: any) => p.product === 'PF_XBTUSD',
      )
      // The newest signal is the SHORT two minutes back, not the older LONG.
      expect(xbt.last_signal).toEqual({
        bucket_ms: TO - 3 * MINUTE,
        action: 'SHORT',
        reason_code: 'c27_short_breakout',
      })
      const discards = r.discards as any
      // 120 rows - 2 signals; i=0,10,..,50 abstain in ETH (6) and XBT (6, none of them 2 or 5).
      expect(discards.total).toBe(118)
      expect(discards.by_reason).toEqual([
        { reason_code: 'no_directional_proposal', action: 'WAIT', count: 106 },
        { reason_code: 'conflicting_signals', action: 'ABSTAIN', count: 12 },
      ])
      expect(discards.not_recorded.join(' ')).toMatch(/Qwen/)
    })

    it('limits everything to the product asked for', () => {
      const b = box()
      seedVerdictRows(
        b.verdictsDb,
        continuous(['PF_XBTUSD', 'PF_ETHUSD'], 30, (p) =>
          p === 'PF_ETHUSD' ? ['LONG', 'x'] : ['WAIT', 'only_xbt'],
        ),
      )
      const r = report(b, '3h', 'PF_XBTUSD')
      expect(r.product).toBe('PF_XBTUSD')
      expect(
        (r.evaluations as any).by_product.map((p: any) => p.product),
      ).toEqual(['PF_XBTUSD'])
      expect((r.signals as any).long).toBe(0)
      expect((r.discards as any).by_reason).toEqual([
        { reason_code: 'only_xbt', action: 'WAIT', count: 30 },
      ])
    })

    it('says unavailable, with the reason, when the verdicts DB does not exist', () => {
      const b = box()
      seedForwardWorld(b)
      const r = report(b)
      for (const section of [r.evaluations, r.signals, r.discards] as any[]) {
        expect(section.state).toBe('unavailable')
        expect(section.detail).toBe('file_not_found')
        expect(section.evidence.state).toBe('missing')
        expect(section.by_product).toBeUndefined()
      }
      // The forward section is independent of it.
      expect(r.operations.state).toBe('ok')
    })

    it('says unavailable when the source is not configured', () => {
      const b = box()
      const r = createObservabilityActivity({
        ...optionsOf(b),
        verdictsDbPath: undefined,
        forwardDbPath: undefined,
      }).report('3h')
      expect((r.evaluations as any).detail).toBe('source_not_configured')
      expect((r.operations as any).detail).toBe('source_not_configured')
    })
  })

  describe('window validation', () => {
    it('accepts only its own keys', () => {
      expect(isActivityWindow('3h')).toBe(true)
      expect(isActivityWindow('24h')).toBe(true)
      for (const bad of [
        'toString',
        'constructor',
        '__proto__',
        'hasOwnProperty',
        'valueOf',
        '',
        '7d',
        undefined,
        ['3h'],
        3,
      ])
        expect(isActivityWindow(bad)).toBe(false)
    })
  })

  describe('discard totals', () => {
    it('totals every reason and says when the list was cut', () => {
      const b = box()
      // 70 distinct reasons: reason r<i> appears (i % 3) + 1 times, spread over products.
      const rows: VerdictRow[] = []
      let minute = 0
      for (let r = 0; r < 70; r += 1)
        for (let k = 0; k < (r % 3) + 1; k += 1) {
          rows.push({
            product: PRODUCTS[minute % PRODUCTS.length]!,
            bucket: TO - (Math.floor(minute / PRODUCTS.length) + 1) * MINUTE,
            action: r % 2 ? 'ABSTAIN' : 'WAIT',
            reason: `reason_${String(r).padStart(2, '0')}`,
          })
          minute += 1
        }
      rows.push({
        product: 'PF_XBTUSD',
        bucket: TO - 100 * MINUTE,
        action: 'LONG',
        reason: 'c25_long_pullback',
      })
      seedVerdictRows(b.verdictsDb, rows)
      const r = report(b)
      const discards = r.discards as any
      const expectedDiscards = rows.length - 1
      expect(discards.by_reason).toHaveLength(50)
      expect(discards.distinct_reasons).toBe(70)
      expect(discards.truncated).toBe(true)
      expect(discards.total).toBe(expectedDiscards)
      const listed = discards.by_reason.reduce(
        (a: number, x: any) => a + x.count,
        0,
      )
      expect(discards.omitted_count).toBe(expectedDiscards - listed)
      expect(discards.omitted_count).toBeGreaterThan(0)
      // evaluations = signals + discards, whatever the list shows.
      expect((r.evaluations as any).total).toBe(rows.length)
      expect((r.signals as any).total).toBe(1)
      expect((r.evaluations as any).total).toBe(
        (r.signals as any).total + discards.total,
      )
      // The most frequent reasons come first, ties by code.
      const counts = discards.by_reason.map((x: any) => x.count)
      expect(counts).toEqual([...counts].sort((a, b) => b - a))
    })

    it('does not flag truncation when everything fits', () => {
      const b = box()
      seedVerdictRows(b.verdictsDb, continuous(['PF_XBTUSD'], 5))
      const discards = report(b).discards as any
      expect([
        discards.truncated,
        discards.omitted_count,
        discards.distinct_reasons,
      ]).toEqual([false, 0, 1])
    })
  })

  describe('missing minutes', () => {
    it('is described as the difference from the nominal cadence, not as health', () => {
      const b = box()
      seedVerdictRows(b.verdictsDb, continuous(['PF_XBTUSD'], 10))
      const rule = (report(b).evaluations as any).evidence.rule as string
      expect(rule).toMatch(/cadencia nominal/)
      expect(rule).toMatch(/no un diagnóstico de salud/)
      expect(rule).toMatch(/DEV_ONLY/)
      expect(rule).toMatch(/B1/)
    })
  })

  describe('last operation per experiment (forward)', () => {
    it('reports the newest trade across products, the window count and open positions', () => {
      const b = box()
      seedForwardWorld(b)
      seedForwardTrades(b.forwardDb, [
        {
          strategy: 'C29',
          product: 'PF_XBTUSD',
          entry: TO - 30 * HOUR,
          side: 'LONG',
        },
        {
          strategy: 'C29',
          product: 'PF_XBTUSD',
          entry: TO - 2 * HOUR,
          side: 'SHORT',
          reason: 'stop',
        },
        {
          strategy: 'C29',
          product: 'PF_ETHUSD',
          entry: TO - 1 * HOUR,
          side: 'LONG',
          exit: TO - 30 * MINUTE,
        },
        { strategy: 'C30', product: 'PF_SOLUSD', entry: TO - 40 * HOUR },
      ])
      const ops = report(b, '3h').operations as any
      expect(ops.pair_source).toBe('registro del forward')
      const c29 = ops.experiments.find((e: any) => e.experiment_id === 'C29')
      expect(c29.expected_active).toBe(true)
      expect(c29.trades_in_window).toBe(2)
      expect(c29.last_trade).toEqual({
        product: 'PF_ETHUSD',
        side: 'LONG',
        entry_bucket_ms: TO - HOUR,
        exit_bucket_ms: TO - 30 * MINUTE,
        exit_reason: 'time',
      })
      const day = (report(b, '24h').operations as any).experiments.find(
        (e: any) => e.experiment_id === 'C29',
      )
      expect(day.trades_in_window).toBe(2)
      expect(day.last_trade.entry_bucket_ms).toBe(TO - HOUR)
    })

    it('a quiet experiment is zero trades with its last older trade, not an error', () => {
      const b = box()
      seedForwardWorld(b)
      seedForwardTrades(b.forwardDb, [
        {
          strategy: 'C30',
          product: 'PF_SOLUSD',
          entry: TO - 40 * HOUR,
          side: 'SHORT',
        },
      ])
      const c30 = (report(b, '24h').operations as any).experiments.find(
        (e: any) => e.experiment_id === 'C30',
      )
      expect(c30.trades_in_window).toBe(0)
      expect(c30.last_trade).toMatchObject({
        product: 'PF_SOLUSD',
        side: 'SHORT',
        entry_bucket_ms: TO - 40 * HOUR,
      })
      const c29 = (report(b, '24h').operations as any).experiments.find(
        (e: any) => e.experiment_id === 'C29',
      )
      expect(c29.last_trade).toBeNull()
    })

    it('counts open positions from forward_open, ignoring empty slots', () => {
      const b = box()
      seedForwardWorld(b)
      openPositions(b, 'C29', ['PF_ETHUSD', 'PF_SOLUSD'])
      const c29 = (report(b).operations as any).experiments.find(
        (e: any) => e.experiment_id === 'C29',
      )
      expect(c29.open_records).toBe(2)
      expect(c29.expected_active).toBe(true)
    })

    it('a stopped forward keeps its records but they are not presented as current', () => {
      const b = box()
      const stoppedFor = 3 * 24 * HOUR
      seedForward(b.forwardDb, {
        now: NOW,
        strategies: ['C29', 'C30'],
        checkedAgeMs: stoppedFor,
      })
      seedStrategies(
        b.strategiesDb,
        [
          { id: 'C29', state: 'active' },
          { id: 'C30', state: 'active' },
        ],
        NOW,
      )
      writeForwardConfig(b, [], [])
      openPositions(b, 'C29', ['PF_ETHUSD', 'PF_SOLUSD'])
      const ops = report(b, '24h').operations as any
      const c29 = ops.experiments.find((e: any) => e.experiment_id === 'C29')
      expect(c29.open_records).toBe(2)
      expect(c29.last_cycle_ms).toBe(NOW - stoppedFor)
      expect(NOW - c29.last_cycle_ms).toBeGreaterThan(24 * HOUR)
      expect(c29).not.toHaveProperty('open_positions')
      expect(ops.notes.join(' ')).toMatch(/no posiciones actuales verificadas/)
      expect(ops.notes.join(' ')).toMatch(/last_cycle_ms/)
      const c30 = ops.experiments.find((e: any) => e.experiment_id === 'C30')
      expect(c30.open_records).toBe(0)
    })

    it('has no last cycle when the forward holds no cycle row for the experiment', () => {
      const b = box()
      seedForward(b.forwardDb, {
        now: NOW,
        strategies: ['C29', 'C30'],
        checkedAgeMs: MINUTE,
        pairs: Object.fromEntries(PRODUCTS.map((p) => [`C30/${p}`, null])),
      })
      seedStrategies(
        b.strategiesDb,
        [
          { id: 'C29', state: 'active' },
          { id: 'C30', state: 'active' },
        ],
        NOW,
      )
      writeForwardConfig(b, [], [])
      const ops = report(b).operations as any
      expect(
        ops.experiments.map((e: any) => [e.experiment_id, e.last_cycle_ms]),
      ).toEqual([
        ['C29', NOW - MINUTE],
        ['C30', null],
      ])
    })

    it('restricts the trades and positions to the product asked for', () => {
      const b = box()
      seedForwardWorld(b)
      seedForwardTrades(b.forwardDb, [
        { strategy: 'C29', product: 'PF_XBTUSD', entry: TO - HOUR },
        { strategy: 'C29', product: 'PF_ETHUSD', entry: TO - 2 * HOUR },
      ])
      openPositions(b, 'C29', ['PF_ETHUSD', 'PF_SOLUSD'])
      const c29 = (
        report(b, '3h', 'PF_ETHUSD').operations as any
      ).experiments.find((e: any) => e.experiment_id === 'C29')
      expect(c29.trades_in_window).toBe(1)
      expect(c29.last_trade.product).toBe('PF_ETHUSD')
      expect(c29.open_records).toBe(1)
    })

    it('does not depend on how long the trade history is', () => {
      const b = box()
      seedForwardWorld(b)
      seedForwardTrades(b.forwardDb, [
        { strategy: 'C29', product: 'PF_XBTUSD', entry: TO - HOUR },
      ])
      const before = JSON.stringify((report(b).operations as any).experiments)
      const old = Array.from({ length: 5_000 }, (_, i) => ({
        strategy: 'C29',
        product: 'PF_XBTUSD',
        entry: TO - 100 * HOUR - i * MINUTE,
      }))
      seedForwardTrades(b.forwardDb, old)
      const after = JSON.stringify((report(b).operations as any).experiments)
      expect(after).toBe(before)
    })

    it('does not break on a payload that does not parse', () => {
      const b = box()
      seedForwardWorld(b)
      seedForwardTrades(b.forwardDb, [
        {
          strategy: 'C29',
          product: 'PF_XBTUSD',
          entry: TO - HOUR,
          raw: '{oops',
        },
      ])
      const c29 = (report(b).operations as any).experiments.find(
        (e: any) => e.experiment_id === 'C29',
      )
      expect(c29.last_trade).toEqual({
        product: 'PF_XBTUSD',
        side: null,
        entry_bucket_ms: TO - HOUR,
        exit_bucket_ms: null,
        exit_reason: null,
      })
    })

    it('marks experiments as undetermined when the expected set cannot be known', () => {
      const b = box()
      seedForwardWorld(b)
      const r = createObservabilityActivity({
        ...optionsOf(b),
        strategiesDbPath: undefined,
      }).report('3h')
      const ops = r.operations as any
      expect(ops.pair_source).toBe('estado del forward')
      expect(
        ops.experiments.map((e: any) => [e.experiment_id, e.expected_active]),
      ).toEqual([
        ['C29', null],
        ['C30', null],
      ])
    })

    it('lists a strategy the forward has state for but that is no longer required as expected_active=false', () => {
      const b = box()
      seedForward(b.forwardDb, {
        now: NOW,
        strategies: ['C29', 'C30', 'GONE'],
        checkedAgeMs: MINUTE,
      })
      seedStrategies(
        b.strategiesDb,
        [
          { id: 'C29', state: 'active' },
          { id: 'C30', state: 'active' },
          { id: 'GONE', state: 'retired' },
        ],
        NOW,
      )
      writeForwardConfig(b, [], [])
      const ops = report(b).operations as any
      expect(
        ops.experiments.map((e: any) => [e.experiment_id, e.expected_active]),
      ).toEqual([
        ['C29', true],
        ['C30', true],
        ['GONE', false],
      ])
    })

    it('says unavailable when the forward DB is missing, leaving the verdict sections intact', () => {
      const b = box()
      seedVerdictRows(b.verdictsDb, continuous(['PF_XBTUSD'], 5))
      const r = report(b)
      expect((r.operations as any).state).toBe('unavailable')
      expect((r.operations as any).detail).toBe('file_not_found')
      expect(r.evaluations.state).toBe('ok')
    })
  })

  describe('safety', () => {
    it('leaves every source untouched (hash, size and mtime)', () => {
      const b = box()
      seedForwardWorld(b)
      seedVerdictRows(b.verdictsDb, continuous(['PF_XBTUSD'], 30))
      seedForwardTrades(b.forwardDb, [
        { strategy: 'C29', product: 'PF_XBTUSD', entry: TO - HOUR },
      ])
      const files = [b.verdictsDb, b.forwardDb, b.strategiesDb, b.registration]
      const snap = () =>
        files.map((f) => [sha(f), statSync(f).size, statSync(f).mtimeMs])
      const before = snap()
      const api = createObservabilityActivity({ ...optionsOf(b), cacheMs: 0 })
      api.report('3h')
      api.report('24h', 'PF_XBTUSD')
      expect(snap()).toEqual(before)
    })

    it('caches per window and product for the TTL, then recomputes', () => {
      const b = box()
      seedVerdictRows(b.verdictsDb, continuous(['PF_XBTUSD'], 5))
      let now = NOW
      const api = createObservabilityActivity({
        ...optionsOf(b),
        clock: () => now,
      })
      const first = api.report('3h')
      expect(api.report('3h')).toBe(first)
      expect(api.report('24h')).not.toBe(first)
      expect(api.report('3h', 'PF_XBTUSD')).not.toBe(first)
      now += 14_000
      expect(api.report('3h')).toBe(first)
      now += 2_000
      expect(api.report('3h')).not.toBe(first)
    })

    it('rejects a product outside the list', () => {
      const b = box()
      expect(() => report(b, '3h', 'PF_NOPE')).toThrow('invalid_product')
    })
  })

  describe('GET /api/observability/activity', () => {
    async function app(b: Sandbox) {
      return buildLiveGateway({
        marketDbPath: b.marketDb,
        products: PRODUCTS,
        clock: () => NOW,
        observabilityActivity: createObservabilityActivity(optionsOf(b)),
      })
    }

    it('serves the report for a window and a product', async () => {
      const b = box()
      seedForwardWorld(b)
      seedVerdictRows(b.verdictsDb, continuous(['PF_XBTUSD'], 10))
      const server = await app(b)
      try {
        const response = await server.inject({
          method: 'GET',
          url: '/api/observability/activity?window=24h&product=PF_XBTUSD',
        })
        expect(response.statusCode).toBe(200)
        const body = response.json() as ObservabilityActivityReport
        expect(body.window).toBe('24h')
        expect(body.product).toBe('PF_XBTUSD')
        expect(body.to_ms - body.from_ms).toBe(24 * HOUR)
        expect((body.evaluations as any).total).toBe(10)
      } finally {
        await server.close()
      }
    })

    it.each([
      ['', 'invalid_window'],
      ['?window=7d', 'invalid_window'],
      ['?window=toString', 'invalid_window'],
      ['?window=constructor', 'invalid_window'],
      ['?window=__proto__', 'invalid_window'],
      ['?window=hasOwnProperty', 'invalid_window'],
      ['?window=3h&window=24h', 'invalid_window'],
      ['?window=3h&product=PF_NOPE', 'invalid_product'],
      ['?window=3h&product=toString', 'invalid_product'],
    ])('answers 400 to %s', async (query, code) => {
      const b = box()
      const server = await app(b)
      try {
        const response = await server.inject({
          method: 'GET',
          url: `/api/observability/activity${query}`,
        })
        expect(response.statusCode).toBe(400)
        expect(response.json()).toEqual({ error: { code } })
      } finally {
        await server.close()
      }
    })
  })

  describe('documented examples (docs/mission-control/b2/)', () => {
    const dir = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../../../../docs/mission-control/b2',
    )
    const scenarios: Record<string, () => ObservabilityActivityReport> = {
      'ejemplo-con-actividad': () => {
        const b = box()
        seedForwardWorld(b)
        seedVerdictRows(
          b.verdictsDb,
          continuous(['PF_XBTUSD', 'PF_ETHUSD'], 180, (product, i) => {
            if (product === 'PF_XBTUSD' && i === 40)
              return ['LONG', 'c25_long_pullback']
            if (i % 15 === 0) return ['ABSTAIN', 'conflicting_signals']
            return ['WAIT', 'no_directional_proposal']
          }),
        )
        seedForwardTrades(b.forwardDb, [
          {
            strategy: 'C29',
            product: 'PF_XBTUSD',
            entry: TO - 2 * HOUR,
            side: 'LONG',
            exit: TO - HOUR,
            reason: 'target',
          },
          {
            strategy: 'C30',
            product: 'PF_ETHUSD',
            entry: TO - 30 * HOUR,
            side: 'SHORT',
            reason: 'stop',
          },
        ])
        openPositions(b, 'C29', ['PF_SOLUSD'])
        return report(b, '3h')
      },
      'ejemplo-sin-actividad': () => {
        // Rows are being written but nothing is proposed and nothing traded:
        // quiet is a count of zeros that were read, not an error.
        const b = box()
        seedForwardWorld(b)
        seedVerdictRows(b.verdictsDb, continuous(PRODUCTS, 180))
        return report(b, '3h', 'PF_XBTUSD')
      },
      'ejemplo-sin-datos': () =>
        createObservabilityActivity({
          products: PRODUCTS,
          verdictsDbPath: '/ruta/inexistente/futures-verdicts.sqlite',
          forwardDbPath: '/ruta/inexistente/forward.sqlite',
          clock: () => NOW,
        }).report('24h'),
    }
    for (const [name, build] of Object.entries(scenarios))
      it(`${name}.json matches what the code produces`, () => {
        const file = resolve(dir, `${name}.json`)
        const text = `${JSON.stringify(build(), null, 2)}\n`
        if (process.env.UPDATE_ACTIVITY_EXAMPLES === '1') {
          mkdirSync(dir, { recursive: true })
          writeFileSync(file, text)
        }
        expect(readFileSync(file, 'utf8')).toBe(text)
      })
  })
})
