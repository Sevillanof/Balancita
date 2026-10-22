import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSystemUsage, folderBytes } from './system-usage.ts'

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'system-usage-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

describe('system usage', () => {
  it('is all null when nothing is configured', () => {
    const body = createSystemUsage({ clock: () => 1 }).report()
    expect(body).toMatchObject({
      cpu_pct: null,
      rss_mb: null,
      data_mb: null,
      qwen: { running: null, decisions: null, exit_decisions: null },
      kronos: { running: null, trades: null },
    })
  })

  it('sums the saved data, resources, Qwen decisions and the Kronos run', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'a.sqlite'), Buffer.alloc(2 * 1_048_576))
    writeFileSync(
      join(dir, 'health.json'),
      JSON.stringify({
        updated_at_ms: 7_099_999,
        processes: { llm: { status: 'running' } },
        resources: {
          status: 'ok',
          reason: null,
          sampled_at_ms: 7_099_999,
          cores: 8,
          total_cpu_pct: 41.5,
          total_rss_mb: 900,
          processes: { llm: { cpu_pct: 12, rss_mb: 500 } },
          kronos: { running: true, cpu_pct: 3, rss_mb: 80 },
        },
      }),
    )
    writeFileSync(
      join(dir, 'exit.json'),
      JSON.stringify({ exit_decisions: { hold: 5, close: 2 } }),
    )
    writeFileSync(
      join(dir, 'kronos.json'),
      JSON.stringify({
        forward: { all: { trades: 7 } },
        decisions: [['forward', 30, 7]],
      }),
    )
    const dbPath = join(dir, 'decisions.sqlite')
    const db = new DatabaseSync(dbPath)
    db.exec(
      'CREATE TABLE paper_futures_llm_decisions(written_at INTEGER, latency_ms INTEGER)',
    )
    db.exec(
      'INSERT INTO paper_futures_llm_decisions VALUES (100, 1000), (7000000, 2000), (7000100, 4000)',
    )
    db.close()
    const prepare = vi.spyOn(DatabaseSync.prototype, 'prepare')
    const body = createSystemUsage({
      healthPath: join(dir, 'health.json'),
      dataDir: dir,
      decisionsDbPath: dbPath,
      qwenExitSummaryPath: join(dir, 'exit.json'),
      kronosSummaryPath: join(dir, 'kronos.json'),
      clock: () => 7_100_000,
    }).report()
    expect(prepare).not.toHaveBeenCalled()
    prepare.mockRestore()
    expect(body.cpu_pct).toBe(41.5)
    expect(body.data_mb).toBeGreaterThanOrEqual(2)
    expect(body.qwen).toMatchObject({
      running: true,
      cpu_pct: 12,
      decisions: null,
      decisions_reason: 'no_bounded_source',
      exit_decisions: 7,
    })
    expect(body.kronos).toMatchObject({
      running: true,
      cpu_pct: 3,
      trades: 7,
      decisions: 30,
    })
  })

  it('caches the report for a few seconds', () => {
    let now = 0
    const usage = createSystemUsage({ clock: () => now, cacheMs: 5_000 })
    const first = usage.report()
    now = 1_000
    expect(usage.report()).toMatchObject({
      ...first,
      at_ms: 1_000,
      cached_at_ms: 0,
    })
    now = 6_000
    const later = usage.report()
    expect(later).not.toBe(first)
    expect(later).toMatchObject({
      at_ms: 6_000,
      cached_at_ms: 6_000,
      cache_ms: 5_000,
    })
    now = 5_999
    expect(usage.report()).toMatchObject({ at_ms: 5_999, cached_at_ms: 5_999 })
  })

  it.each([
    [{}, 'missing_source'],
    [
      { updated_at_ms: 100_000, resources: { sampled_at_ms: 100_000 } },
      'legacy_metadata',
    ],
    [
      {
        updated_at_ms: 69_999,
        resources: { status: 'ok', sampled_at_ms: 100_000 },
      },
      'supervisor_stale',
    ],
    [
      {
        updated_at_ms: 100_001,
        resources: { status: 'ok', sampled_at_ms: 100_000 },
      },
      'supervisor_invalid_time',
    ],
    [
      {
        updated_at_ms: 100_000,
        resources: { status: 'ok', sampled_at_ms: 84_999 },
      },
      'sample_stale',
    ],
    [
      {
        updated_at_ms: 100_000,
        resources: { status: 'ok', sampled_at_ms: 100_001 },
      },
      'sample_invalid_time',
    ],
    [
      {
        updated_at_ms: 100_000,
        resources: { status: 'ok', sampled_at_ms: 'bad' },
      },
      'sample_invalid_time',
    ],
    [
      {
        updated_at_ms: 100_000,
        resources: { status: 'ok', sampled_at_ms: 100_000, total_cpu_pct: -1 },
      },
      'malformed_output',
    ],
    [
      {
        updated_at_ms: 100_000,
        resources: { status: 'unavailable', reason: 'timeout' },
      },
      'timeout',
    ],
    [
      {
        updated_at_ms: 100_000,
        resources: { status: 'unavailable', reason: '/secret/path' },
      },
      'collector_error',
    ],
  ])('rejects unavailable evidence: %s', (health, reason) => {
    const path = join(tempDir(), 'health.json')
    writeFileSync(
      path,
      JSON.stringify({
        ...health,
        resources:
          'resources' in health
            ? {
                total_cpu_pct: 5,
                total_rss_mb: 8,
                processes: { llm: { cpu_pct: 2 } },
                kronos: { running: true, cpu_pct: 1 },
                ...health.resources,
              }
            : undefined,
      }),
    )
    const body = createSystemUsage({
      healthPath: path,
      clock: () => 100_000,
    }).report()
    expect(body).toMatchObject({
      status: 'unavailable',
      reason,
      sampled_at_ms: null,
      cpu_pct: null,
      rss_mb: null,
      per_process: null,
      qwen: { cpu_pct: null },
      kronos: { running: null, cpu_pct: null },
    })
  })

  it('keeps a measured zero and source time distinct from response and storage times', () => {
    const dir = tempDir()
    const path = join(dir, 'health.json')
    writeFileSync(
      path,
      JSON.stringify({
        updated_at_ms: 99_999,
        resources: {
          status: 'ok',
          sampled_at_ms: 85_000,
          attempted_at_ms: 84_999,
          completed_at_ms: 85_000,
          total_cpu_pct: 0,
          total_rss_mb: 0,
        },
      }),
    )
    const body = createSystemUsage({
      healthPath: path,
      dataDir: dir,
      clock: () => 100_000,
    }).report()
    expect(body).toMatchObject({
      status: 'ok',
      reason: null,
      cpu_pct: 0,
      rss_mb: 0,
      sampled_at_ms: 85_000,
      attempted_at_ms: 84_999,
      completed_at_ms: 85_000,
      at_ms: 100_000,
      storage: { sampled_at_ms: 100_000, complete: true },
      scope: {
        cpu_basis: 'one_core_percent',
        memory_basis: 'summed_rss_mib_not_unique_or_gpu',
      },
    })
    let now = 100_000
    const usage = createSystemUsage({ healthPath: path, clock: () => now })
    expect(usage.report().status).toBe('ok')
    now++
    expect(usage.report()).toMatchObject({
      status: 'unavailable',
      reason: 'sample_stale',
    })
  })

  it('inventories file categories without following symlinks and discloses depth limits', () => {
    const dir = tempDir()
    for (const name of [
      'a.sqlite',
      'a.sqlite-wal',
      'a.sqlite-shm',
      'a.log',
      'a.json',
    ])
      writeFileSync(join(dir, name), '1234')
    symlinkSync(dir, join(dir, 'link'))
    mkdirSync(join(dir, 'models'))
    writeFileSync(join(dir, 'models', 'weights.bin'), 'not inventoried')
    const report = () =>
      createSystemUsage({ dataDir: dir, clock: () => 123 }).report()
    expect(report()).toMatchObject({
      storage: {
        status: 'ok',
        complete: true,
        total_bytes: 20,
        symlinks_skipped: 1,
        bytes: { sqlite_main: 4, wal: 4, shm: 4, log: 4, other: 4 },
        scope: 'configured_data_directory',
        excludes: ['models', 'other_roots', 'symlinks'],
      },
    })
    mkdirSync(join(dir, 'one/two/three/four'), { recursive: true })
    expect(report()).toMatchObject({
      data_mb: null,
      storage: {
        status: 'partial',
        reason: 'depth_limit',
        complete: false,
        max_depth: 3,
      },
    })
  })

  it('stops the inventory at its entry budget, even in one wide directory', () => {
    const dir = tempDir()
    for (let i = 0; i < 1_001; i++) writeFileSync(join(dir, `${i}.log`), 'x')
    expect(createSystemUsage({ dataDir: dir }).report()).toMatchObject({
      data_mb: null,
      storage: {
        status: 'partial',
        reason: 'entry_limit',
        visited_entries: 1_000,
        max_entries: 1_000,
        complete: false,
      },
    })
  })

  it('bounds JSON reads and does not turn absent exit counters into zero', () => {
    const dir = tempDir()
    const path = join(dir, 'summary.json')
    writeFileSync(path, JSON.stringify({ exit_decisions: {} }))
    expect(
      createSystemUsage({ qwenExitSummaryPath: path }).report().qwen,
    ).toMatchObject({ exit_decisions: null })
    writeFileSync(
      path,
      JSON.stringify({
        forward: { all: { trades: 7 } },
        padding: 'x'.repeat(131_072),
      }),
    )
    expect(
      createSystemUsage({ kronosSummaryPath: path }).report().kronos,
    ).toMatchObject({ trades: null })
  })

  it('expires supervisor process state even when the resource sample failed', () => {
    const path = join(tempDir(), 'health.json')
    let now = 30_000
    writeFileSync(
      path,
      JSON.stringify({
        updated_at_ms: 0,
        processes: { llm: { status: 'running' } },
        resources: { status: 'unavailable', reason: 'timeout' },
      }),
    )
    const usage = createSystemUsage({ healthPath: path, clock: () => now })
    expect(usage.report().qwen).toMatchObject({ running: true })
    now++
    expect(usage.report().qwen).toMatchObject({ running: null })
  })

  it('folderBytes is null for a missing folder', () => {
    expect(folderBytes('/nonexistent/folder')).toBeNull()
    const dir = tempDir()
    const link = join(dir, 'link')
    symlinkSync(dir, link)
    for (const dataDir of [join(dir, 'missing'), link])
      expect(createSystemUsage({ dataDir }).report()).toMatchObject({
        data_mb: null,
        storage: {
          status: 'unavailable',
          reason: 'io_error',
          complete: false,
          error_count: 1,
          bytes: null,
          total_bytes: null,
        },
      })
  })
})
