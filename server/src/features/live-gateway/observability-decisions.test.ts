/* eslint-disable @typescript-eslint/no-explicit-any -- loosely typed JSON assertions */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { buildLiveGateway } from './gateway.ts'
import {
  createObservabilityDecisions,
  DECISIONS_MAX_LIMIT,
  DECISIONS_MAX_SPAN_MS,
  DecisionsRequestError,
  MAX_PAYLOAD_CHARS,
  type DecisionTrace,
  type DecisionsReport,
} from './observability-decisions.ts'
import {
  C25,
  seedSyntheticModelDecisions,
  seedSyntheticVerdicts,
  type SyntheticVerdict,
} from './observability-decisions-fixtures.ts'
import {
  MINUTE,
  PRODUCTS,
  sandbox,
  type Sandbox,
} from './observability-health-fixtures.ts'

const NOW = 1_790_000_000_000
const TO = NOW - (NOW % MINUTE)
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

function decisionsOf(
  b: Sandbox,
  verdictsDbPath = b.verdictsDb,
  decisionsDbPath: string | null = b.decisionsDb,
) {
  return createObservabilityDecisions({
    products: PRODUCTS,
    verdictsDbPath,
    decisionsDbPath: decisionsDbPath ?? undefined,
    clock: () => NOW,
  })
}

/** `minutes` consecutive synthetic verdicts, newest at `TO - MINUTE`. */
function stream(
  product: string,
  minutes: number,
  pick: (i: number) => Partial<SyntheticVerdict> = () => ({}),
): SyntheticVerdict[] {
  return Array.from({ length: minutes }, (_, i) => ({
    product,
    bucket: TO - (i + 1) * MINUTE,
    action: 'WAIT',
    reason: 'no_directional_proposal',
    ...pick(i),
  }))
}

function seedMixed(b: Sandbox): void {
  seedSyntheticVerdicts(b.verdictsDb, [
    ...stream('PF_XBTUSD', 120, (i) =>
      i === 7
        ? { action: 'LONG', reason: 'c25_long_pullback', strategy: C25 }
        : i % 10 === 0
          ? { action: 'ABSTAIN', reason: 'conflicting_signals' }
          : {},
    ),
    ...stream('PF_ETHUSD', 5),
  ])
}

describe('B3 decisions list', () => {
  it('lists newest first without payloads and counts the range', () => {
    const b = box()
    seedMixed(b)
    const report = decisionsOf(b).list({ product: 'PF_XBTUSD', limit: 10 })
    expect(report.schema).toBe('observability-decisions.v1')
    expect(report.to_ms).toBe(TO)
    expect(report.from_ms).toBe(TO - 3 * 60 * MINUTE)
    const section = report.decisions as any
    expect(section.state).toBe('ok')
    expect(section.range_total).toBe(120)
    expect(section.matching).toBe(120)
    expect(section.by_action).toEqual([
      { action: 'ABSTAIN', count: 12 },
      { action: 'LONG', count: 1 },
      { action: 'WAIT', count: 107 },
    ])
    expect(section.items).toHaveLength(10)
    const buckets = section.items.map((i: any) => i.bucket_start_ms)
    expect(buckets).toEqual([...buckets].sort((a, b) => b - a))
    expect(buckets[0]).toBe(TO - MINUTE)
    // No payload rides along in the list.
    expect(JSON.stringify(section.items)).not.toContain('proposals')
    expect(Object.keys(section.items[0]).sort()).toEqual([
      'action',
      'bucket_start_ms',
      'decision_known_at_ms',
      'interval_ms',
      'product',
      'reason_code',
      'regime',
      'selected_strategy_id',
      'verdict_hash',
      'written_at_ms',
    ])
  })

  it('names a strategy only when the payload does: a discard has none', () => {
    const b = box()
    seedMixed(b)
    const items = (
      decisionsOf(b).list({ product: 'PF_XBTUSD', limit: 20 }).decisions as any
    ).items
    const long = items.find((i: any) => i.action === 'LONG')
    expect(long.selected_strategy_id).toBe(C25)
    for (const i of items.filter((x: any) => x.action !== 'LONG'))
      expect(i.selected_strategy_id).toBeNull()
  })

  it('paginates with a cursor without repeating or skipping rows', () => {
    const b = box()
    seedMixed(b)
    const d = decisionsOf(b)
    const seen: number[] = []
    let cursor: string | undefined
    let pages = 0
    for (;;) {
      const section = d.list({ product: 'PF_XBTUSD', limit: 25, cursor })
        .decisions as any
      seen.push(...section.items.map((i: any) => i.bucket_start_ms))
      pages += 1
      if (section.next_cursor === null) break
      cursor = section.next_cursor
    }
    expect(pages).toBe(5)
    expect(seen).toHaveLength(120)
    expect(new Set(seen).size).toBe(120)
    expect(seen).toEqual([...seen].sort((a, b) => b - a))
  })

  it('filters by action and reason_code and still reports the range', () => {
    const b = box()
    seedMixed(b)
    const d = decisionsOf(b)
    const longs = d.list({ product: 'PF_XBTUSD', action: 'LONG' })
      .decisions as any
    expect(longs.matching).toBe(1)
    expect(longs.range_total).toBe(120)
    expect(longs.items).toHaveLength(1)
    const conflicts = d.list({
      product: 'PF_XBTUSD',
      reasonCode: 'conflicting_signals',
    }).decisions as any
    expect(conflicts.matching).toBe(12)
    expect(
      conflicts.items.every(
        (i: any) => i.reason_code === 'conflicting_signals',
      ),
    ).toBe(true)
    const none = d.list({ product: 'PF_XBTUSD', reasonCode: 'nope' })
      .decisions as any
    expect(none.matching).toBe(0)
    expect(none.items).toEqual([])
    expect(none.next_cursor).toBeNull()
  })

  it('honours from/to as [from, to) and one product never reads another', () => {
    const b = box()
    seedMixed(b)
    const d = decisionsOf(b)
    const section = d.list({
      product: 'PF_XBTUSD',
      fromMs: TO - 10 * MINUTE,
      toMs: TO - 5 * MINUTE,
    }).decisions as any
    expect(section.items.map((i: any) => i.bucket_start_ms)).toEqual([
      TO - 6 * MINUTE,
      TO - 7 * MINUTE,
      TO - 8 * MINUTE,
      TO - 9 * MINUTE,
      TO - 10 * MINUTE,
    ])
    const eth = d.list({ product: 'PF_ETHUSD' }).decisions as any
    expect(eth.items.every((i: any) => i.product === 'PF_ETHUSD')).toBe(true)
    expect(eth.range_total).toBe(5)
  })

  it('says «unavailable» with the cause when the source is missing', () => {
    const b = box()
    const missing = decisionsOf(b, '/ruta/inexistente/futures-verdicts.sqlite')
    const report = missing.list({ product: 'PF_XBTUSD' })
    const section = report.decisions as any
    expect(section.state).toBe('unavailable')
    expect(section.detail).toBe('file_not_found')
    expect(section.items).toBeUndefined()
    expect(section.evidence.state).toBe('missing')
    const none = createObservabilityDecisions({
      products: PRODUCTS,
      clock: () => NOW,
    }).list({ product: 'PF_XBTUSD' }).decisions as any
    expect(none.detail).toBe('source_not_configured')
  })

  it('says «unavailable» when the file is not a verdicts database', () => {
    const b = box()
    writeFileSync(b.verdictsDb, 'esto no es sqlite')
    const section = decisionsOf(b).list({ product: 'PF_XBTUSD' })
      .decisions as any
    expect(section.state).toBe('unavailable')
    expect(section.evidence.state).toBe('unreadable')
  })

  it('never writes: the database is opened read-only', () => {
    const b = box()
    seedMixed(b)
    const before = readFileSync(b.verdictsDb)
    decisionsOf(b).list({ product: 'PF_XBTUSD' })
    decisionsOf(b).trace('PF_XBTUSD', TO - MINUTE)
    expect(readFileSync(b.verdictsDb).equals(before)).toBe(true)
  })

  it('caches briefly and does not mix queries', () => {
    const b = box()
    seedMixed(b)
    let now = NOW
    const d = createObservabilityDecisions({
      products: PRODUCTS,
      verdictsDbPath: b.verdictsDb,
      clock: () => now,
      cacheMs: 10_000,
    })
    const first = d.list({ product: 'PF_XBTUSD', limit: 5 })
    expect(d.list({ product: 'PF_XBTUSD', limit: 5 })).toBe(first)
    expect(d.list({ product: 'PF_XBTUSD', limit: 6 })).not.toBe(first)
    now += 10_000
    expect(d.list({ product: 'PF_XBTUSD', limit: 5 })).not.toBe(first)
  })

  it('keeps its cache bounded under many different queries', () => {
    const b = box()
    seedMixed(b)
    const d = decisionsOf(b)
    for (let i = 1; i <= 200; i += 1)
      d.list({ product: 'PF_XBTUSD', limit: 1, cursor: String(TO - i) })
    // Still answers (no growth to fail on); the oldest entries were evicted.
    expect(() => d.list({ product: 'PF_XBTUSD' })).not.toThrow()
  })

  it('reads a page of real-sized payloads quickly (bounded cost)', () => {
    const b = box()
    seedSyntheticVerdicts(
      b.verdictsDb,
      stream('PF_XBTUSD', 1440, () => ({ padChars: 8_000 })),
    )
    const started = performance.now()
    const section = decisionsOf(b).list({
      product: 'PF_XBTUSD',
      fromMs: TO - 1440 * MINUTE,
      limit: DECISIONS_MAX_LIMIT,
    }).decisions as any
    const elapsed = performance.now() - started
    expect(section.items).toHaveLength(DECISIONS_MAX_LIMIT)
    expect(elapsed).toBeLessThan(1000)
  })

  it('tolerates a verdict whose payload is not valid JSON', () => {
    const b = box()
    seedSyntheticVerdicts(b.verdictsDb, stream('PF_XBTUSD', 3), (v) =>
      v.bucket === TO - MINUTE ? '{no json' : undefined,
    )
    const section = decisionsOf(b).list({ product: 'PF_XBTUSD' })
      .decisions as any
    expect(section.items).toHaveLength(3)
    expect(section.items[0].selected_strategy_id).toBeNull()
  })

  describe('request validation', () => {
    const bad = (
      query: Parameters<ReturnType<typeof decisionsOf>['list']>[0],
    ) => {
      const b = box()
      seedMixed(b)
      try {
        decisionsOf(b).list(query)
      } catch (error) {
        expect(error).toBeInstanceOf(DecisionsRequestError)
        return (error as DecisionsRequestError).code
      }
      return 'no_error'
    }
    it.each([
      [{ product: 'PF_NOPE' }, 'invalid_product'],
      [{ product: 'toString' }, 'invalid_product'],
      [{ product: 'PF_XBTUSD', fromMs: 10, toMs: 10 }, 'invalid_range'],
      [{ product: 'PF_XBTUSD', fromMs: 20, toMs: 10 }, 'invalid_range'],
      [{ product: 'PF_XBTUSD', fromMs: -1, toMs: 10 }, 'invalid_range'],
      [
        {
          product: 'PF_XBTUSD',
          fromMs: TO - DECISIONS_MAX_SPAN_MS - MINUTE,
          toMs: TO,
        },
        'range_too_large',
      ],
      [{ product: 'PF_XBTUSD', limit: 0 }, 'invalid_limit'],
      [
        { product: 'PF_XBTUSD', limit: DECISIONS_MAX_LIMIT + 1 },
        'invalid_limit',
      ],
      [{ product: 'PF_XBTUSD', limit: 1.5 }, 'invalid_limit'],
      [{ product: 'PF_XBTUSD', cursor: 'abc' }, 'invalid_cursor'],
      [{ product: 'PF_XBTUSD', cursor: '1e9' }, 'invalid_cursor'],
      [{ product: 'PF_XBTUSD', action: 'BUY' }, 'invalid_action'],
      [{ product: 'PF_XBTUSD', action: 'toString' }, 'invalid_action'],
      [{ product: 'PF_XBTUSD', reasonCode: '' }, 'invalid_reason_code'],
      [
        { product: 'PF_XBTUSD', reasonCode: 'x'.repeat(81) },
        'invalid_reason_code',
      ],
    ] as const)('rejects %j with %s', (query, code) => {
      expect(bad(query as any)).toBe(code)
    })
  })
})

describe('B3 decision trace', () => {
  it('returns the row and the payload exactly as stored', () => {
    const b = box()
    seedMixed(b)
    const bucket = TO - 8 * MINUTE // i === 7: the LONG
    const trace = decisionsOf(b).trace('PF_XBTUSD', bucket) as any
    expect(trace.state).toBe('ok')
    expect(trace.decision).toMatchObject({
      product: 'PF_XBTUSD',
      bucket_start_ms: bucket,
      action: 'LONG',
      reason_code: 'c25_long_pullback',
      regime: 'range',
    })
    expect(trace.payload_state).toBe('ok')
    expect(trace.mismatches).toEqual([])
    expect(trace.payload.selected.strategy_id).toBe(C25)
    expect(trace.payload.proposals).toHaveLength(4)
    expect(trace.payload.features['1m'].atr14).toBe('0.42')
    expect(trace.not_recorded.length).toBeGreaterThan(0)
  })

  it('a discard payload keeps the selector result without a strategy', () => {
    const b = box()
    seedMixed(b)
    const trace = decisionsOf(b).trace('PF_XBTUSD', TO - 2 * MINUTE) as any
    expect(trace.decision.action).toBe('WAIT')
    expect(trace.payload.selected).toEqual({
      action: 'WAIT',
      reason_code: 'no_directional_proposal',
    })
    expect(trace.payload.selected.strategy_id).toBeUndefined()
  })

  it('reports not_found for a minute with no verdict (not an empty decision)', () => {
    const b = box()
    seedMixed(b)
    const d = decisionsOf(b)
    expect(d.trace('PF_XBTUSD', TO + 5 * MINUTE).state).toBe('not_found')
    // The verdict of another product at that minute is not this product's.
    expect(d.trace('PF_SOLUSD', TO - MINUTE).state).toBe('not_found')
  })

  it('reports unavailable with the cause when the source is missing', () => {
    const b = box()
    const trace = decisionsOf(b, '/ruta/inexistente/v.sqlite').trace(
      'PF_XBTUSD',
      TO - MINUTE,
    ) as any
    expect(trace.state).toBe('unavailable')
    expect(trace.detail).toBe('file_not_found')
  })

  it.each([
    ['unparseable', '{no json', 'unparseable'],
    ['not an object', '[1,2]', 'not_an_object'],
    [
      'too large',
      JSON.stringify({ pad: 'x'.repeat(MAX_PAYLOAD_CHARS) }),
      'too_large',
    ],
  ])('keeps the row when the payload is %s', (_name, raw, state) => {
    const b = box()
    seedSyntheticVerdicts(b.verdictsDb, stream('PF_XBTUSD', 1), () => raw)
    const trace = decisionsOf(b).trace('PF_XBTUSD', TO - MINUTE) as any
    expect(trace.state).toBe('ok')
    expect(trace.decision.action).toBe('WAIT')
    expect(trace.payload_state).toBe(state)
    expect(trace.payload).toBeNull()
  })

  it('reports columns the payload contradicts instead of hiding them', () => {
    const b = box()
    seedSyntheticVerdicts(b.verdictsDb, stream('PF_XBTUSD', 1))
    const db = new DatabaseSync(b.verdictsDb)
    db.exec(
      `UPDATE paper_futures_verdicts SET reason_code='otro_motivo', regime='trend'`,
    )
    db.close()
    const trace = decisionsOf(b).trace('PF_XBTUSD', TO - MINUTE) as any
    expect(trace.mismatches.sort()).toEqual(['reason_code', 'regime'])
  })

  describe('model decisions of the same product and minute', () => {
    const bucket = TO - 8 * MINUTE
    const modelOf = (trace: unknown) => (trace as any).model_decisions

    it('are listed by (product, bucket) without the heavy columns', () => {
      const b = box()
      seedMixed(b)
      seedSyntheticModelDecisions(b.decisionsDb, [
        { product: 'PF_XBTUSD', bucket, chosen: 'LONG', confidence: 0.62 },
        {
          product: 'PF_XBTUSD',
          bucket,
          questionId: 'q-other',
          chosen: 'SHORT',
          confidence: 0.4,
        },
        { product: 'PF_ETHUSD', bucket, chosen: 'SHORT', confidence: 0.9 },
      ])
      const model = modelOf(decisionsOf(b).trace('PF_XBTUSD', bucket))
      expect(model.state).toBe('ok')
      expect(model.items.map((i: any) => i.question_id)).toEqual([
        'q-entry-direction',
        'q-other',
      ])
      expect(model.items[0]).toMatchObject({
        chosen: 'LONG',
        confidence: 0.62,
        matches_verdict: true,
        probabilities: { LONG: 0.62 },
      })
      expect(JSON.stringify(model)).not.toContain('xxxx')
      expect(model.evidence.source).toBe('paper_futures_llm_decisions')
    })

    it('a row written against another verdict is flagged, not hidden', () => {
      const b = box()
      seedMixed(b)
      seedSyntheticModelDecisions(b.decisionsDb, [
        {
          product: 'PF_XBTUSD',
          bucket,
          chosen: 'LONG',
          confidence: 0.6,
          verdictHash: 'otro-hash',
        },
      ])
      const model = modelOf(decisionsOf(b).trace('PF_XBTUSD', bucket))
      expect(model.items[0].matches_verdict).toBe(false)
    })

    it('an empty read says so; it is not «unavailable»', () => {
      const b = box()
      seedMixed(b)
      seedSyntheticModelDecisions(b.decisionsDb, [
        {
          product: 'PF_XBTUSD',
          bucket: TO - 99 * MINUTE,
          chosen: 'LONG',
          confidence: 0.5,
        },
      ])
      const model = modelOf(decisionsOf(b).trace('PF_XBTUSD', bucket))
      expect(model).toMatchObject({ state: 'ok', items: [] })
    })

    it('is unavailable with the cause when the model DB is missing or not configured', () => {
      const b = box()
      seedMixed(b)
      expect(
        modelOf(
          decisionsOf(b, b.verdictsDb, '/no/existe.sqlite').trace(
            'PF_XBTUSD',
            bucket,
          ),
        ),
      ).toMatchObject({ state: 'unavailable', detail: 'file_not_found' })
      expect(
        modelOf(decisionsOf(b, b.verdictsDb, null).trace('PF_XBTUSD', bucket)),
      ).toMatchObject({ state: 'unavailable', detail: 'source_not_configured' })
    })

    it('does not break the trace when the table is absent', () => {
      const b = box()
      seedMixed(b)
      writeFileSync(b.decisionsDb, '')
      const trace = decisionsOf(b).trace('PF_XBTUSD', bucket) as any
      expect(trace.state).toBe('ok')
      expect(trace.model_decisions.state).toBe('unavailable')
    })
  })

  it('rejects an invalid product or bucket', () => {
    const d = decisionsOf(box())
    expect(() => d.trace('PF_NOPE', 1)).toThrow(DecisionsRequestError)
    expect(() => d.trace('PF_XBTUSD', -1)).toThrow(DecisionsRequestError)
    expect(() => d.trace('PF_XBTUSD', 1.5)).toThrow(DecisionsRequestError)
  })
})

describe('GET /api/observability/decisions', () => {
  async function app(b: Sandbox) {
    return buildLiveGateway({
      marketDbPath: b.marketDb,
      products: PRODUCTS,
      clock: () => NOW,
      observabilityDecisions: decisionsOf(b),
    })
  }
  async function get(b: Sandbox, url: string) {
    const server = await app(b)
    try {
      return await server.inject({ method: 'GET', url })
    } finally {
      await server.close()
    }
  }

  it('serves the list and the trace', async () => {
    const b = box()
    seedMixed(b)
    const list = await get(
      b,
      '/api/observability/decisions?product=PF_XBTUSD&limit=3',
    )
    expect(list.statusCode).toBe(200)
    const body = list.json() as DecisionsReport
    expect((body.decisions as any).items).toHaveLength(3)
    const trace = await get(
      b,
      `/api/observability/decisions/PF_XBTUSD/${TO - MINUTE}`,
    )
    expect(trace.statusCode).toBe(200)
    expect((trace.json() as DecisionTrace).state).toBe('ok')
  })

  it('answers 200 not_found for a minute without verdict (404 is for unknown routes)', async () => {
    const b = box()
    seedMixed(b)
    const res = await get(
      b,
      `/api/observability/decisions/PF_XBTUSD/${TO + MINUTE}`,
    )
    expect(res.statusCode).toBe(200)
    expect((res.json() as DecisionTrace).state).toBe('not_found')
  })

  it.each([
    ['', 'invalid_product'],
    ['?product=PF_NOPE', 'invalid_product'],
    ['?product=PF_XBTUSD&product=PF_ETHUSD', 'invalid_product'],
    ['?product=PF_XBTUSD&from=abc&to=10', 'invalid_range'],
    ['?product=PF_XBTUSD&from=10&to=10', 'invalid_range'],
    ['?product=PF_XBTUSD&from=1&to=99999999999999', 'range_too_large'],
    ['?product=PF_XBTUSD&limit=0', 'invalid_limit'],
    ['?product=PF_XBTUSD&limit=201', 'invalid_limit'],
    ['?product=PF_XBTUSD&limit=5&limit=6', 'invalid_limit'],
    ['?product=PF_XBTUSD&cursor=x', 'invalid_cursor'],
    ['?product=PF_XBTUSD&action=BUY', 'invalid_action'],
    ['?product=PF_XBTUSD&reason_code=', 'invalid_reason_code'],
  ])('answers 400 to %s', async (query, code) => {
    const b = box()
    const res = await get(b, `/api/observability/decisions${query}`)
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: { code } })
  })

  it.each([
    ['/api/observability/decisions/PF_NOPE/1', 'invalid_product'],
    ['/api/observability/decisions/PF_XBTUSD/abc', 'invalid_bucket'],
    ['/api/observability/decisions/PF_XBTUSD/-5', 'invalid_bucket'],
    ['/api/observability/decisions/PF_XBTUSD/1.5', 'invalid_bucket'],
  ])('answers 400 to %s', async (url, code) => {
    const b = box()
    const res = await get(b, url)
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: { code } })
  })

  it('is read only: it accepts GET and nothing else', async () => {
    const b = box()
    const server = await app(b)
    try {
      for (const method of ['POST', 'PUT', 'DELETE'] as const) {
        const res = await server.inject({
          method,
          url: '/api/observability/decisions?product=PF_XBTUSD',
        })
        expect(res.statusCode).toBeGreaterThanOrEqual(400)
      }
    } finally {
      await server.close()
    }
  })
})

describe('documented examples (docs/mission-control/b3/)', () => {
  const dir = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../../docs/mission-control/b3',
  )
  const scenarios: Record<string, () => unknown> = {
    'ejemplo-listado': () => {
      const b = box()
      seedMixed(b)
      return decisionsOf(b).list({ product: 'PF_XBTUSD', limit: 5 })
    },
    'ejemplo-listado-descartes': () => {
      const b = box()
      seedMixed(b)
      return decisionsOf(b).list({
        product: 'PF_XBTUSD',
        reasonCode: 'conflicting_signals',
        limit: 3,
      })
    },
    'ejemplo-listado-sin-datos': () =>
      decisionsOf(box(), '/ruta/inexistente/futures-verdicts.sqlite').list({
        product: 'PF_XBTUSD',
      }),
    'ejemplo-traza-propuesta': () => {
      const b = box()
      seedMixed(b)
      seedSyntheticModelDecisions(b.decisionsDb, [
        {
          product: 'PF_XBTUSD',
          bucket: TO - 8 * MINUTE,
          chosen: 'LONG',
          confidence: 0.62,
        },
      ])
      return decisionsOf(b).trace('PF_XBTUSD', TO - 8 * MINUTE)
    },
    'ejemplo-traza-descarte': () => {
      const b = box()
      seedMixed(b)
      // The model DB exists but holds no row for this minute.
      seedSyntheticModelDecisions(b.decisionsDb, [
        {
          product: 'PF_XBTUSD',
          bucket: TO - 50 * MINUTE,
          chosen: 'SHORT',
          confidence: 0.55,
        },
      ])
      return decisionsOf(b).trace('PF_XBTUSD', TO - 2 * MINUTE)
    },
    'ejemplo-traza-no-encontrada': () => {
      const b = box()
      seedMixed(b)
      return decisionsOf(b).trace('PF_XBTUSD', TO + MINUTE)
    },
  }
  for (const [name, build] of Object.entries(scenarios))
    it(`${name}.json matches what the code produces`, () => {
      const file = resolve(dir, `${name}.json`)
      // The sandbox folder is random: the example must not depend on it.
      const text = `${JSON.stringify(build(), null, 2)}\n`
      if (process.env.UPDATE_DECISIONS_EXAMPLES === '1') {
        mkdirSync(dir, { recursive: true })
        writeFileSync(file, text)
      }
      expect(readFileSync(file, 'utf8')).toBe(text)
    })
})
