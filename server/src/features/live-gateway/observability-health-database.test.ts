import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createObservabilityHealth } from './observability-health.ts'
import {
  PRODUCTS,
  sandbox,
  seedMarket,
  type Sandbox,
} from './observability-health-fixtures.ts'
import { damageTable } from '../../platform/sqlite-test-helpers.ts'

const NOW = 1_790_000_000_000
const MIN = 60_000
const boxes: Sandbox[] = []
afterEach(() => {
  for (const box of boxes.splice(0))
    rmSync(box.dir, { recursive: true, force: true })
})

function setup() {
  const b = sandbox()
  boxes.push(b)
  seedMarket(b.marketDb, {
    now: NOW,
    tickerAgeMs: Object.fromEntries(PRODUCTS.map((p) => [p, 2_000])),
    candleAgeMs: Object.fromEntries(PRODUCTS.map((p) => [p, 20_000])),
  })
  const statePath = join(b.dir, 'db-health-state.json')
  const write = (state: Record<string, unknown>) =>
    writeFileSync(
      statePath,
      JSON.stringify({ schema: 'db-health.v1', updated_at: NOW, ...state }),
    )
  const data = () => {
    const report = createObservabilityHealth({
      products: PRODUCTS,
      marketDbPath: b.marketDb,
      dbHealthStatePath: statePath,
      staleAfterMs: 15_000,
      clock: () => NOW,
    }).report()
    return report.components.find((c) => c.id === 'data')!
  }
  return { b, write, data }
}

const integrityOk = {
  file: 'futures-market.sqlite',
  ok: true,
  checked_at: NOW - 5 * MIN,
  detail: 'quick_check ok',
  timed_out: false,
}

describe('system health: database integrity and backups', () => {
  it('shows a healthy database and a recent backup as ok rows', () => {
    const { write, data } = setup()
    write({
      integrity: integrityOk,
      damaged: null,
      backup_every_ms: 86_400_000,
      backups: {
        'futures-market': {
          ok: true,
          at: NOW - 3_600_000,
          detail: 'ok',
          source_failed: false,
          last_good_at: NOW - 3_600_000,
        },
      },
    })
    const component = data()
    const integrity = component.checks.find(
      (c) => c.id === 'database_integrity',
    )!
    expect(integrity.status).toBe('ok')
    expect(integrity.detail).toContain('quick_check correcto hace 5 min')
    expect(
      component.checks.find((c) => c.id === 'database_backup')!.status,
    ).toBe('ok')
    expect(component.status).toBe('ok')
  })

  it('names the damaged file and the repair step instead of "snapshot sin velas verificables"', () => {
    const { write, data } = setup()
    write({
      integrity: {
        ...integrityOk,
        ok: false,
        detail: 'quick_check: Main freelist: freelist leaf count too big',
      },
      damaged: 'futures-market.sqlite',
      backups: {},
    })
    const component = data()
    expect(component.status).toBe('error')
    expect(component.summary).toContain('Base dañada: futures-market.sqlite')
    expect(component.summary).toContain('restaurar la última copia buena')
    expect(component.summary).toContain('pnpm db:rebuild')
    expect(component.summary).toContain('freelist leaf count too big')
    expect(component.summary).not.toContain('velas verificables')
    // The damaged row leads the list.
    expect(component.checks[0]?.id).toBe('database_integrity')
  })

  it('also says "Base dañada" when the database cannot be read as malformed, even before a check ran', () => {
    const { b, data } = setup()
    damageTable(b.marketDb, 'paper_futures_market_events')
    const component = data()
    expect(component.status).toBe('error')
    expect(component.summary).toContain('Base dañada: futures-market.sqlite')
  })

  it('turns a backup whose source failed its check into an error that keeps the last good copy', () => {
    const { write, data } = setup()
    write({
      integrity: integrityOk,
      damaged: null,
      backup_every_ms: 86_400_000,
      backups: {
        'futures-verdicts': {
          ok: false,
          at: NOW - MIN,
          detail: 'futures-verdicts: la base falló su chequeo, no se copió',
          source_failed: true,
          last_good_at: NOW - 30 * 3_600_000,
        },
      },
    })
    const row = data().checks.find((c) => c.id === 'database_backup')!
    expect(row.status).toBe('error')
    expect(row.detail).toContain('Base dañada: futures-verdicts.sqlite')
  })

  it('warns when the integrity check stopped running or the last good backup is old', () => {
    const { write, data } = setup()
    write({
      integrity: { ...integrityOk, checked_at: NOW - 2 * 3_600_000 },
      damaged: null,
      backup_every_ms: 86_400_000,
      backups: {
        a: {
          ok: true,
          at: NOW,
          detail: 'ok',
          source_failed: false,
          last_good_at: NOW - 5 * 86_400_000,
        },
      },
    })
    const checks = data().checks
    expect(checks.find((c) => c.id === 'database_integrity')!.status).toBe(
      'warning',
    )
    expect(checks.find((c) => c.id === 'database_backup')!.status).toBe(
      'warning',
    )
  })

  it('judges the age of the integrity check by the interval the capture publishes', () => {
    const { write, data } = setup()
    const sixHours = 6 * 3_600_000
    write({
      integrity: { ...integrityOk, checked_at: NOW - 5 * 3_600_000 },
      integrity_every_ms: sixHours,
      damaged: null,
      backups: {},
    })
    const fresh = data().checks.find((c) => c.id === 'database_integrity')!
    expect(fresh.status).toBe('ok')
    expect(fresh.rule).toContain('cada 6 h')
    write({
      integrity: { ...integrityOk, checked_at: NOW - 10 * 3_600_000 },
      integrity_every_ms: sixHours,
      damaged: null,
      backups: {},
    })
    const stale = data().checks.find((c) => c.id === 'database_integrity')!
    expect(stale.status).toBe('warning')
    expect(stale.detail).toContain('se hace cada 6 h')
  })

  it('without the state file the rows are «Sin datos» and do not change the component', () => {
    const { data } = setup()
    const component = data()
    expect(
      component.checks.find((c) => c.id === 'database_integrity')!.status,
    ).toBe('unknown')
    expect(component.status).toBe('ok')
  })
})
