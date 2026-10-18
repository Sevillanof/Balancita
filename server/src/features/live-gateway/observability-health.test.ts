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
  assemble,
  createObservabilityHealth,
  type HealthComponent,
  type ObservabilityHealthOptions,
  type ObservabilityHealthReport,
} from './observability-health.ts'
import {
  PRODUCTS,
  sandbox,
  seedDecisions,
  seedForward,
  seedMarket,
  seedStrategies,
  seedVerdicts,
  writeForwardConfig,
  writeHealthFile,
  type Sandbox,
} from './observability-health-fixtures.ts'

const NOW = 1_790_000_000_000
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

/** Removes a SQLite file and its WAL companions so a case can reseed it. */
function fresh(path: string): void {
  for (const suffix of ['', '-wal', '-shm'])
    rmSync(`${path}${suffix}`, { force: true })
}

const everyProduct = (ms: number) =>
  Object.fromEntries(PRODUCTS.map((p) => [p, ms]))

function optionsOf(b: Sandbox): ObservabilityHealthOptions {
  return {
    products: PRODUCTS,
    marketDbPath: b.marketDb,
    verdictsDbPath: b.verdictsDb,
    decisionsDbPath: b.decisionsDb,
    forwardDbPath: b.forwardDb,
    strategiesDbPath: b.strategiesDb,
    forwardRegistrationPath: b.registration,
    strategySpecsDir: b.specsDir,
    processHealthPath: b.healthFile,
    qwenExitSummaryPath: b.qwenExitSummary,
    kronosSummaryPath: b.kronosSummary,
    resilienceLogPath: b.resilienceLog,
    staleAfterMs: 15_000,
    clock: () => NOW,
  }
}

/** Everything fresh and the processes running (risk stays «Sin datos»). */
function seedHealthy(b: Sandbox): void {
  seedMarket(b.marketDb, {
    now: NOW,
    tickerAgeMs: everyProduct(2_000),
    candleAgeMs: everyProduct(20_000),
  })
  seedVerdicts(b.verdictsDb, { now: NOW, newestAgeMs: everyProduct(30_000) })
  seedForward(b.forwardDb, {
    now: NOW,
    strategies: ['C29', 'C30'],
    checkedAgeMs: 5 * 60_000,
    trades: 2,
  })
  seedStrategies(
    b.strategiesDb,
    [
      { id: 'C29', state: 'active' },
      { id: 'C30', state: 'active' },
      { id: 'old', state: 'retired' },
    ],
    NOW,
  )
  writeForwardConfig(b, [], [])
  writeHealthFile(b.healthFile, NOW, {
    capture: 'running',
    live: 'running',
    verdict: 'running',
    scores: 'running',
    forward: 'running',
    strategies: 'running',
  })
}

const component = (r: ObservabilityHealthReport, id: HealthComponent['id']) =>
  r.components.find((c) => c.id === id)!
const check = (c: HealthComponent, id: string) =>
  c.checks.find((k) => k.id === id)!

describe('observability health', () => {
  it('reports capture working with recent data, and still not healthy overall without a risk source', () => {
    const b = box()
    seedHealthy(b)
    const report = createObservabilityHealth(optionsOf(b)).report()
    for (const id of [
      'data',
      'processing',
      'strategies',
      'decisions',
      'paper',
    ] as const)
      expect(component(report, id).status, id).toBe('ok')
    expect(component(report, 'risk').status).toBe('unknown')
    // The global state is never healthy while a component is unverified.
    expect(report.overall.status).toBe('unknown')
    expect(report.overall.unverified).toEqual(['risk'])
    expect(report.overall.failing).toEqual([])
    const data = component(report, 'data')
    expect(data.items).toHaveLength(PRODUCTS.length)
    expect(data.items![0]).toMatchObject({ ticker_age_ms: 2_000 })
    // Every component names its evidence, origin and last update.
    for (const c of report.components)
      for (const e of c.evidence) {
        expect(e).toHaveProperty('source')
        expect(e).toHaveProperty('origin')
        expect(e).toHaveProperty('last_updated_ms')
      }
    expect(
      data.evidence.find((e) => e.source.includes('ticker')),
    ).toMatchObject({
      origin: 'futures-market.sqlite',
      last_updated_ms: NOW - 2_000,
      state: 'read',
    })
  })

  it('only the six components become ok together: ok overall needs all six ok', () => {
    const ok = (id: HealthComponent['id']): HealthComponent => ({
      id,
      label: id,
      status: 'ok',
      summary: '',
      checks: [],
      evidence: [],
      limitations: [],
    })
    const six = (
      [
        'data',
        'processing',
        'strategies',
        'decisions',
        'paper',
        'risk',
      ] as const
    ).map(ok)
    expect(assemble(six, NOW, 15_000).overall.status).toBe('ok')
    expect(
      assemble(
        [...six.slice(0, 5), { ...six[5]!, status: 'unknown' }],
        NOW,
        15_000,
      ).overall.status,
    ).toBe('unknown')
  })

  it('flags the ticker as stale when other feeds are alive and the capture process is running', () => {
    const b = box()
    seedHealthy(b)
    // The trades socket keeps delivering, the 1 s ticker poll stopped 3 min ago.
    fresh(b.marketDb)
    seedMarket(b.marketDb, {
      now: NOW,
      tickerAgeMs: everyProduct(180_000),
      candleAgeMs: everyProduct(20_000),
      otherFeed: { feed: 'trade', product: 'PF_XBTUSD', ageMs: 1_000 },
    })
    const report = createObservabilityHealth(optionsOf(b)).report()
    const data = component(report, 'data')
    expect(data.status).toBe('error')
    expect(check(data, 'ticker_freshness').status).toBe('error')
    expect(check(data, 'ticker_freshness').detail).toMatch(
      /otro feed \(trade\)/,
    )
    expect(check(data, 'capture_process')).toMatchObject({
      status: 'error',
      value: 'running',
    })
    expect(check(data, 'capture_process').detail).toMatch(
      /output_stale|process_active/,
    )
    expect(report.overall.status).toBe('error')
    expect(report.overall.failing).toContain('data')
  })

  it('does not take a running process for a producing one: no recent evaluations is an error', () => {
    const b = box()
    seedHealthy(b)
    // The verdict process runs, but its newest rows are 20 min old.
    fresh(b.verdictsDb)
    seedVerdicts(b.verdictsDb, {
      now: NOW,
      newestAgeMs: everyProduct(20 * 60_000),
    })
    const report = createObservabilityHealth(optionsOf(b)).report()
    const processing = component(report, 'processing')
    expect(check(processing, 'evaluations_continuity')).toMatchObject({
      status: 'error',
      value: 20 * 60_000,
    })
    expect(check(processing, 'evaluations_continuity').detail).toMatch(
      /process_active_output_stale/,
    )
    expect(processing.status).toBe('error')
    expect(component(report, 'decisions').status).toBe('error')
    // The capture is fine: the failure is attributed to the right component.
    expect(component(report, 'data').status).toBe('ok')
  })

  it('without a launched process, stale output is «Sin datos», not a failure and not ok', () => {
    const b = box()
    seedHealthy(b)
    fresh(b.verdictsDb)
    seedVerdicts(b.verdictsDb, {
      now: NOW,
      newestAgeMs: everyProduct(2 * 3_600_000),
    })
    // DEV_ONLY=vite,capture,live,forward,strategies: verdict was never launched.
    writeHealthFile(b.healthFile, NOW, {
      capture: 'running',
      live: 'running',
      forward: 'running',
      strategies: 'running',
    })
    const report = createObservabilityHealth(optionsOf(b)).report()
    expect(
      check(component(report, 'decisions'), 'verdict_cadence').status,
    ).toBe('unknown')
    expect(component(report, 'decisions').status).toBe('unknown')
    expect(component(report, 'processing').status).toBe('unknown')
  })

  it('returns «Sin datos» for every component when no source exists', () => {
    const report = createObservabilityHealth({
      products: PRODUCTS,
      marketDbPath: '/nonexistent/market.sqlite',
      clock: () => NOW,
    }).report()
    for (const c of report.components) expect(c.status, c.id).toBe('unknown')
    expect(report.overall.status).toBe('unknown')
    expect(report.overall.unverified).toHaveLength(6)
    const data = component(report, 'data')
    expect(data.evidence.some((e) => e.state === 'missing')).toBe(true)
    expect(data.checks.every((k) => k.value === null)).toBe(true)
  })

  it('does not call a component ok on thin evidence (registry without forward, stale supervisor file)', () => {
    const b = box()
    seedMarket(b.marketDb, {
      now: NOW,
      tickerAgeMs: everyProduct(1_000),
      candleAgeMs: everyProduct(10_000),
    })
    seedStrategies(b.strategiesDb, [{ id: 'C29', state: 'active' }], NOW)
    // The supervisor file is two minutes old: process state is not known now.
    writeHealthFile(b.healthFile, NOW, { capture: 'running' }, 120_000)
    const report = createObservabilityHealth(optionsOf(b)).report()
    expect(component(report, 'data').status).toBe('ok')
    const strategies = component(report, 'strategies')
    expect(check(strategies, 'registry').status).toBe('ok')
    expect(check(strategies, 'forward_coverage').status).toBe('unknown')
    expect(strategies.status).toBe('unknown')
    expect(
      check(component(report, 'processing'), 'supervisor_health_file').status,
    ).toBe('unknown')
    expect(component(report, 'processing').status).toBe('unknown')
    expect(component(report, 'paper').status).toBe('unknown')
  })

  it('mixes healthy and unknown components without averaging them into ok', () => {
    const b = box()
    seedMarket(b.marketDb, {
      now: NOW,
      tickerAgeMs: everyProduct(1_000),
      candleAgeMs: everyProduct(10_000),
    })
    const report = createObservabilityHealth({
      products: PRODUCTS,
      marketDbPath: b.marketDb,
      clock: () => NOW,
    }).report()
    expect(report.components.map((c) => [c.id, c.status])).toEqual([
      ['data', 'ok'],
      ['processing', 'unknown'],
      ['strategies', 'unknown'],
      ['decisions', 'unknown'],
      ['paper', 'unknown'],
      ['risk', 'unknown'],
    ])
    expect(report.overall.status).toBe('unknown')
    expect(report.overall.failing).toEqual([])
  })

  it('warns on a recent data gap and on forward anomalies, with their numbers', () => {
    const b = box()
    seedHealthy(b)
    fresh(b.marketDb)
    seedMarket(b.marketDb, {
      now: NOW,
      tickerAgeMs: everyProduct(2_000),
      candleAgeMs: everyProduct(20_000),
      gaps: [
        { product: 'PF_ETHUSD', ageMs: 10 * 60_000 },
        { product: 'PF_ETHUSD', ageMs: 5 * 3_600_000 },
      ],
    })
    fresh(b.forwardDb)
    seedForward(b.forwardDb, {
      now: NOW,
      strategies: ['C29', 'C30'],
      checkedAgeMs: 60_000,
      diverged: 3,
      candleLagMs: 15 * 60_000,
    })
    const report = createObservabilityHealth(optionsOf(b)).report()
    expect(check(component(report, 'data'), 'data_gaps')).toMatchObject({
      status: 'warning',
      value: 2,
    })
    expect(
      check(component(report, 'paper'), 'forward_anomalies'),
    ).toMatchObject({ status: 'warning' })
    expect(report.overall.status).toBe('warning')
  })

  it('does not raise a warning for old-rule legacy trades but still does for current-era divergences', () => {
    const b = box()
    seedHealthy(b)
    fresh(b.forwardDb)
    seedForward(b.forwardDb, {
      now: NOW,
      strategies: ['C29'],
      checkedAgeMs: 60_000,
      legacyDiverged: 28,
    })
    const report = createObservabilityHealth(optionsOf(b)).report()
    const paper = component(report, 'paper')
    const anomalies = check(paper, 'forward_anomalies')
    expect(anomalies.status).toBe('ok')
    expect(anomalies.detail).toContain('28 operación(es) del legado')
    expect(anomalies.detail).toContain('#283')
    expect(JSON.stringify(report)).toContain('"legacy_diverged_trades":28')
    expect(JSON.stringify(paper.limitations)).not.toContain('falta B5')
    expect(JSON.stringify(paper.limitations)).toContain(
      'GET /api-strategies/forward',
    )
  })

  it('treats a forward process with no recent cycle as an error and an old cycle without process info as unknown', () => {
    const b = box()
    seedHealthy(b)
    fresh(b.forwardDb)
    seedForward(b.forwardDb, {
      now: NOW,
      strategies: ['C29'],
      checkedAgeMs: 3 * 3_600_000,
    })
    const running = createObservabilityHealth(optionsOf(b)).report()
    expect(check(component(running, 'paper'), 'forward_cycle')).toMatchObject({
      status: 'error',
    })
    expect(check(component(running, 'paper'), 'forward_cycle').detail).toMatch(
      /process_active_output_stale/,
    )
    writeHealthFile(b.healthFile, NOW, {
      capture: 'running',
      verdict: 'running',
    })
    const absent = createObservabilityHealth(optionsOf(b)).report()
    expect(check(component(absent, 'paper'), 'forward_cycle').status).toBe(
      'unknown',
    )
  })

  it('flags an active strategy that the forward does not track', () => {
    const b = box()
    seedHealthy(b)
    fresh(b.strategiesDb)
    seedStrategies(
      b.strategiesDb,
      [
        { id: 'C29', state: 'active' },
        { id: 'C99', state: 'active' },
      ],
      NOW,
    )
    const report = createObservabilityHealth(optionsOf(b)).report()
    const strategies = component(report, 'strategies')
    // The runner is running and C99 has been active for hours: no row at all
    // is not «pending», it is a strategy nobody updates.
    expect(check(strategies, 'forward_coverage')).toMatchObject({
      status: 'error',
    })
    expect(check(strategies, 'forward_coverage').detail).toMatch(
      /C99\/PF_XBTUSD \(sin estado\)/,
    )
  })

  describe('freshness of each strategy/product pair', () => {
    const stale = 3 * 3_600_000
    const reseedForward = (
      b: Sandbox,
      pairs: Record<string, number | null>,
    ) => {
      fresh(b.forwardDb)
      seedForward(b.forwardDb, {
        now: NOW,
        strategies: ['C29', 'C30'],
        checkedAgeMs: 5 * 60_000,
        pairs,
      })
    }

    it('is not ok when only some pairs keep updating, and names the delayed ones', () => {
      const b = box()
      seedHealthy(b)
      // C29 is current everywhere; C30 stopped on two products hours ago and
      // has no row at all on a third. The newest row of the table is fresh.
      reseedForward(b, {
        'C30/PF_ETHUSD': stale,
        'C30/PF_SOLUSD': stale,
        'C30/PF_XRPUSD': null,
      })
      const report = createObservabilityHealth(optionsOf(b)).report()
      const cycle = check(component(report, 'paper'), 'forward_cycle')
      expect(cycle.status).toBe('error')
      expect(cycle.value).toBe(stale)
      expect(cycle.detail).toContain('C30/PF_ETHUSD (180 min)')
      expect(cycle.detail).toContain('C30/PF_SOLUSD (180 min)')
      expect(cycle.detail).toContain('C30/PF_XRPUSD (sin estado)')
      expect(cycle.detail).not.toContain('C29/')
      const items = component(report, 'paper').items as Record<string, any>[]
      const pair = (s: string, p: string) =>
        items.find((i) => i.strategy_id === s && i.product_id === p)
      expect(pair('C29', 'PF_ETHUSD')).toMatchObject({ status: 'ok' })
      expect(pair('C30', 'PF_ETHUSD')).toMatchObject({
        status: 'error',
        reason: 'process_active_output_stale',
        age_ms: stale,
      })
      expect(pair('C30', 'PF_XRPUSD')).toMatchObject({
        status: 'error',
        reason: 'process_active_without_output',
        checked_ms: null,
      })
      expect(items.at(-1)!.summary).toMatchObject({
        expected_pairs: 16,
        current_pairs: 13,
      })
      // Coverage per strategy: C29 whole, C30 only partly current.
      const coverage = component(report, 'strategies')
      expect(check(coverage, 'forward_coverage').status).toBe('warning')
      const rows = coverage.items as Record<string, any>[]
      expect(rows.find((r) => r.strategy_id === 'C29')).toMatchObject({
        status: 'ok',
        products_current: 8,
      })
      expect(rows.find((r) => r.strategy_id === 'C30')).toMatchObject({
        status: 'warning',
        products_current: 5,
      })
      expect(
        rows
          .find((r) => r.strategy_id === 'C30')!
          .products_delayed.map((d: any) => d.product_id),
      ).toEqual(['PF_ETHUSD', 'PF_SOLUSD', 'PF_XRPUSD'])
      expect(report.overall.status).toBe('error')
    })

    it('does not accept a strategy whose rows are all old as covered because other strategies are fresh', () => {
      const b = box()
      seedHealthy(b)
      reseedForward(
        b,
        Object.fromEntries(PRODUCTS.map((p) => [`C30/${p}`, stale])),
      )
      const report = createObservabilityHealth(optionsOf(b)).report()
      const coverage = component(report, 'strategies')
      expect(check(coverage, 'forward_coverage').status).toBe('error')
      expect(
        (coverage.items as Record<string, any>[]).find(
          (r) => r.strategy_id === 'C30',
        ),
      ).toMatchObject({ status: 'error', products_current: 0 })
    })

    it('ignores rows of strategies that are no longer expected: a historical row proves nothing', () => {
      const b = box()
      seedHealthy(b)
      // C28 was switched off: its stale rows stay in the forward DB.
      fresh(b.strategiesDb)
      seedStrategies(
        b.strategiesDb,
        [
          { id: 'C29', state: 'active' },
          { id: 'C30', state: 'active' },
          { id: 'C28', state: 'retired' },
        ],
        NOW,
      )
      fresh(b.forwardDb)
      seedForward(b.forwardDb, {
        now: NOW,
        strategies: ['C29', 'C30'],
        checkedAgeMs: 5 * 60_000,
      })
      const old = new DatabaseSync(b.forwardDb)
      old.exec(
        `INSERT INTO forward_status SELECT 'C28', product_id, payload FROM forward_status WHERE strategy_id='C29'`,
      )
      old.close()
      const report = createObservabilityHealth(optionsOf(b)).report()
      expect(component(report, 'paper').status).toBe('ok')
      const summary = (
        component(report, 'paper').items as Record<string, any>[]
      ).at(-1)!.summary
      expect(summary).toMatchObject({
        expected_pairs: 16,
        rows_not_expected: 8,
      })
    })

    it('does not mix up the strategy switched on a minute ago with one that stopped', () => {
      const b = box()
      seedHealthy(b)
      fresh(b.strategiesDb)
      seedStrategies(
        b.strategiesDb,
        [
          { id: 'C29', state: 'active' },
          { id: 'C30', state: 'active' },
        ],
        NOW,
      )
      const db = new DatabaseSync(b.strategiesDb)
      db.exec(
        `UPDATE strategy_events SET known_at=${NOW - 10 * 60_000} WHERE strategy_id='C30' AND state='active'`,
      )
      db.close()
      fresh(b.forwardDb)
      seedForward(b.forwardDb, {
        now: NOW,
        strategies: ['C29'],
        checkedAgeMs: 60_000,
      })
      const report = createObservabilityHealth(optionsOf(b)).report()
      const cycle = check(component(report, 'paper'), 'forward_cycle')
      expect(cycle.status).toBe('warning')
      const items = component(report, 'paper').items as Record<string, any>[]
      expect(items.find((i) => i.strategy_id === 'C30')).toMatchObject({
        status: 'warning',
        reason: 'awaiting_first_cycle',
      })
    })

    it('reports «Sin datos» when the expected pairs cannot be determined, even with fresh rows', () => {
      const b = box()
      seedHealthy(b)
      for (const [name, options] of [
        [
          'registration file missing',
          {
            ...optionsOf(b),
            forwardRegistrationPath: '/nonexistent/forward-strategies.json',
          },
        ],
        [
          'registry missing',
          { ...optionsOf(b), strategiesDbPath: '/nonexistent/registry.sqlite' },
        ],
        [
          'registration path not configured',
          { ...optionsOf(b), forwardRegistrationPath: undefined },
        ],
      ] as const) {
        const report = createObservabilityHealth(options).report()
        expect(
          check(component(report, 'paper'), 'forward_cycle').status,
          name,
        ).toBe('unknown')
        expect(
          check(component(report, 'paper'), 'forward_cycle').detail,
        ).toMatch(/No se puede determinar/)
        expect(
          check(component(report, 'strategies'), 'forward_coverage').status,
          name,
        ).toBe('unknown')
        expect(component(report, 'paper').status, name).toBe('unknown')
      }
    })

    it('rebuilds the expected set like the runner: file strategies unless the registry switched them off, plus registry-active ones', () => {
      const b = box()
      seedHealthy(b)
      // File: C30 (also active in the registry), C28 (retired in the registry),
      // FILE1 (file only, with a spec) and NOSPEC (file only, no spec).
      fresh(b.strategiesDb)
      seedStrategies(
        b.strategiesDb,
        [
          { id: 'C29', state: 'active' },
          { id: 'C30', state: 'active' },
          { id: 'C28', state: 'retired' },
        ],
        NOW,
      )
      writeForwardConfig(b, ['C30', 'C28', 'FILE1', 'NOSPEC'], ['FILE1'])
      fresh(b.forwardDb)
      seedForward(b.forwardDb, {
        now: NOW,
        strategies: ['C29', 'C30', 'FILE1'],
        checkedAgeMs: 5 * 60_000,
      })
      const report = createObservabilityHealth(optionsOf(b)).report()
      expect(component(report, 'paper').status).toBe('ok')
      const ids = (
        component(report, 'strategies').items as Record<string, any>[]
      )
        .filter((r) => r.strategy_id)
        .map((r) => [r.strategy_id, r.source])
      expect(ids).toEqual([
        ['C30', 'archivo de registro forward'],
        ['FILE1', 'archivo de registro forward'],
        ['C29', 'registro'],
      ])
      expect(component(report, 'strategies').limitations.join(' ')).toMatch(
        /NOSPEC.*omite/,
      )
    })

    it('says unknown for a file-only strategy when the specs folder is not configured', () => {
      const b = box()
      seedHealthy(b)
      writeForwardConfig(b, ['FILE1'], ['FILE1'])
      const report = createObservabilityHealth({
        ...optionsOf(b),
        strategySpecsDir: undefined,
      }).report()
      expect(check(component(report, 'paper'), 'forward_cycle').status).toBe(
        'unknown',
      )
      expect(check(component(report, 'paper'), 'forward_cycle').detail).toMatch(
        /FILE1/,
      )
    })
  })

  it('never reads the trade history: the report is the same without forward_trade', () => {
    const b = box()
    seedHealthy(b)
    const before = createObservabilityHealth(optionsOf(b)).report()
    const db = new DatabaseSync(b.forwardDb)
    db.exec('DROP TABLE forward_trade')
    db.close()
    const after = createObservabilityHealth(optionsOf(b)).report()
    expect(after.components.map((c) => c.status)).toEqual(
      before.components.map((c) => c.status),
    )
    expect(component(after, 'paper').items).toEqual(
      component(before, 'paper').items,
    )
  })

  it('lists C31 as apagada with its reason when the owner switched it off', () => {
    const b = box()
    seedHealthy(b)
    const report = createObservabilityHealth({
      ...optionsOf(b),
      qwenExitOff: { reason: 'funding inventado', since: '2026-10-18' },
    }).report()
    const c31 = check(
      component(report, 'strategies'),
      'experiment_qwen_exit_c31',
    )
    expect(c31).toMatchObject({ status: 'unknown', required: false })
    expect(c31.detail).toContain(
      'apagada: funding inventado (desde 2026-10-18)',
    )
  })

  it('does not trust a running optional experiment without a recent summary', () => {
    const b = box()
    seedHealthy(b)
    writeFileSync(
      b.qwenExitSummary,
      JSON.stringify({ updated_ms: NOW - 5 * 3_600_000 }),
    )
    writeHealthFile(b.healthFile, NOW, {
      capture: 'running',
      live: 'running',
      verdict: 'running',
      scores: 'running',
      forward: 'running',
      strategies: 'running',
      qwenexit: 'running',
    })
    const report = createObservabilityHealth(optionsOf(b)).report()
    const c31 = check(
      component(report, 'strategies'),
      'experiment_qwen_exit_c31',
    )
    expect(c31).toMatchObject({ status: 'error', required: false })
    expect(c31.detail).toMatch(/process_active_output_stale/)
    // Kronos is not in the supervisor and has no summary: unknown, never ok.
    expect(
      check(component(report, 'strategies'), 'experiment_kronos').status,
    ).toBe('unknown')
  })

  it('reports Qwen without judging it, since it has no fixed cadence', () => {
    const b = box()
    seedHealthy(b)
    seedDecisions(b.decisionsDb, [60_000], NOW)
    const decisions = component(
      createObservabilityHealth(optionsOf(b)).report(),
      'decisions',
    )
    expect(check(decisions, 'qwen_decisions')).toMatchObject({
      status: 'unknown',
      required: false,
    })
    expect(decisions.status).toBe('ok')
  })

  it('reuses the report for 15 s and recomputes afterwards', () => {
    const b = box()
    seedHealthy(b)
    let now = NOW
    const health = createObservabilityHealth({
      ...optionsOf(b),
      clock: () => now,
    })
    const first = health.report()
    now += 14_000
    expect(health.report()).toBe(first)
    now += 2_000
    const later = health.report()
    expect(later).not.toBe(first)
    expect(later.generated_at_ms).toBe(NOW + 16_000)
  })

  it('writes nothing: the source files keep their bytes, size and modification time', () => {
    const b = box()
    seedHealthy(b)
    writeFileSync(
      b.resilienceLog,
      `${JSON.stringify({ at: NOW - 5_000, result: 'recovered' })}\n`,
    )
    const files = [
      b.marketDb,
      b.verdictsDb,
      b.forwardDb,
      b.strategiesDb,
      b.healthFile,
      b.resilienceLog,
    ]
    const digest = (path: string) =>
      createHash('sha256').update(readFileSync(path)).digest('hex')
    const before = files.map((f) => [
      digest(f),
      statSync(f).size,
      statSync(f).mtimeMs,
    ])
    const health = createObservabilityHealth(optionsOf(b))
    health.report()
    let t = NOW
    for (let i = 0; i < 3; i += 1)
      createObservabilityHealth({
        ...optionsOf(b),
        clock: () => (t += 20_000),
      }).report()
    expect(
      files.map((f) => [digest(f), statSync(f).size, statSync(f).mtimeMs]),
    ).toEqual(before)
  })

  it('tells risk apart: it is always «Sin datos» and names why', () => {
    const b = box()
    seedHealthy(b)
    const risk = component(
      createObservabilityHealth(optionsOf(b)).report(),
      'risk',
    )
    expect(risk.status).toBe('unknown')
    expect(risk.checks[0]!.detail).toMatch(/multi_risk\.py/)
    expect(risk.evidence[0]).toMatchObject({
      state: 'missing',
      last_updated_ms: null,
    })
  })

  it('is served by the gateway at /api/observability/health', async () => {
    const b = box()
    seedHealthy(b)
    const app = await buildLiveGateway({
      marketDbPath: b.marketDb,
      verdictsDbPath: b.verdictsDb,
      processHealthPath: b.healthFile,
      products: PRODUCTS,
      clock: () => NOW,
      observabilityHealth: createObservabilityHealth(optionsOf(b)),
    })
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/observability/health',
      })
      expect(response.statusCode).toBe(200)
      const body = response.json() as ObservabilityHealthReport
      expect(body.schema).toBe('observability-health.v1')
      expect(body.components.map((c) => c.id)).toEqual([
        'data',
        'processing',
        'strategies',
        'decisions',
        'paper',
        'risk',
      ])
      expect(body.overall.status).toBe('unknown')
    } finally {
      await app.close()
    }
  })

  it('works without extra options: the gateway builds it from the paths it already has', async () => {
    const b = box()
    seedMarket(b.marketDb, {
      now: NOW,
      tickerAgeMs: everyProduct(1_000),
      candleAgeMs: everyProduct(10_000),
    })
    const app = await buildLiveGateway({
      marketDbPath: b.marketDb,
      products: PRODUCTS,
      clock: () => NOW,
    })
    try {
      const body = (
        await app.inject({ method: 'GET', url: '/api/observability/health' })
      ).json() as ObservabilityHealthReport
      expect(component(body, 'data').status).toBe('ok')
      expect(component(body, 'decisions').status).toBe('unknown')
      expect(body.overall.status).toBe('unknown')
    } finally {
      await app.close()
    }
  })

  describe('documented examples (docs/mission-control/b1/)', () => {
    const dir = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../../../../docs/mission-control/b1',
    )
    const scenarios: Record<string, () => ObservabilityHealthReport> = {
      'ejemplo-saludable': () => {
        const b = box()
        seedHealthy(b)
        return createObservabilityHealth(optionsOf(b)).report()
      },
      'ejemplo-degradado': () => {
        const b = box()
        seedHealthy(b)
        fresh(b.marketDb)
        seedMarket(b.marketDb, {
          now: NOW,
          tickerAgeMs: everyProduct(180_000),
          candleAgeMs: everyProduct(20_000),
          otherFeed: { feed: 'trade', product: 'PF_XBTUSD', ageMs: 1_000 },
          gaps: [{ product: 'PF_ETHUSD', ageMs: 10 * 60_000 }],
        })
        fresh(b.verdictsDb)
        seedVerdicts(b.verdictsDb, {
          now: NOW,
          newestAgeMs: everyProduct(20 * 60_000),
        })
        fresh(b.forwardDb)
        seedForward(b.forwardDb, {
          now: NOW,
          strategies: ['C29', 'C30'],
          checkedAgeMs: 60_000,
          diverged: 3,
          // C30 stopped updating on two products three hours ago.
          pairs: {
            'C30/PF_ETHUSD': 3 * 3_600_000,
            'C30/PF_SOLUSD': 3 * 3_600_000,
          },
        })
        return createObservabilityHealth(optionsOf(b)).report()
      },
      'ejemplo-sin-datos': () =>
        createObservabilityHealth({
          products: PRODUCTS,
          marketDbPath: '/ruta/inexistente/futures-market.sqlite',
          clock: () => NOW,
        }).report(),
    }
    for (const [name, build] of Object.entries(scenarios))
      it(`${name}.json matches what the code produces`, () => {
        const file = resolve(dir, `${name}.json`)
        const text = `${JSON.stringify(build(), null, 2)}\n`
        if (process.env.UPDATE_HEALTH_EXAMPLES === '1') {
          mkdirSync(dir, { recursive: true })
          writeFileSync(file, text)
        }
        expect(readFileSync(file, 'utf8')).toBe(text)
      })
  })
})
