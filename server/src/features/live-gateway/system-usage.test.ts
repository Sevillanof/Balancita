import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { createSystemUsage, folderBytes } from './system-usage.ts'

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'system-usage-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
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
        processes: { llm: { status: 'running' } },
        resources: {
          sampled_at_ms: 9,
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
    const body = createSystemUsage({
      healthPath: join(dir, 'health.json'),
      dataDir: dir,
      decisionsDbPath: dbPath,
      qwenExitSummaryPath: join(dir, 'exit.json'),
      kronosSummaryPath: join(dir, 'kronos.json'),
      clock: () => 7_100_000,
    }).report()
    expect(body.cpu_pct).toBe(41.5)
    expect(body.data_mb).toBeGreaterThanOrEqual(2)
    expect(body.qwen).toEqual({
      running: true,
      cpu_pct: 12,
      decisions: { total: 3, last_hour: 2, avg_latency_ms: 7000 / 3 },
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
    expect(usage.report()).toBe(first)
    now = 6_000
    expect(usage.report()).not.toBe(first)
  })

  it('folderBytes is null for a missing folder', () => {
    expect(folderBytes('/nonexistent/folder')).toBeNull()
  })
})
