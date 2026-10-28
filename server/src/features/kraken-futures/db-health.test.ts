import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { createDbHealth, spawnTask, type HealthTask } from './db-health.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'balancita-health-'))
  dirs.push(dir)
  return dir
}

function fixture(over: Partial<Parameters<typeof createDbHealth>[0]> = {}) {
  const lines: string[] = []
  const records: Record<string, unknown>[] = []
  const tasks: HealthTask[] = []
  const health = createDbHealth({
    store: { checkpoint: () => ({ busy: false, walFrames: 10, moved: 10 }) },
    dbPath: '/nowhere/market.sqlite',
    log: (line) => lines.push(line),
    record: (entry) => records.push(entry),
    clock: () => 1_000,
    walBytes: () => 1_000,
    runTask: async (task) => {
      tasks.push(task)
      return { ok: true, detail: 'fine' }
    },
    ...over,
  })
  return { health, lines, records, tasks }
}

describe('database health', () => {
  it('records each checkpoint and warns about a WAL that stays huge', () => {
    const { health, lines, records } = fixture({
      walBytes: () => 3 * 1024 ** 3,
    })
    health.checkpointNow()
    expect(records[0]).toMatchObject({ check: 'checkpoint', moved: 10 })
    expect(lines.join('\n')).toContain('the WAL is 3072 MiB')
  })

  it('reports a failed integrity check loudly and keeps going', async () => {
    const { health, lines, records } = fixture({
      runTask: async () => ({ ok: false, detail: 'quick_check: bad page' }),
    })
    await health.integrityNow()
    expect(records[0]).toMatchObject({ check: 'integrity', ok: false })
    expect(lines.join('\n')).toContain('DATABASE HEALTH PROBLEM (integrity)')
  })

  it('never backs up unless a directory is given, and never overlaps itself', async () => {
    const off = fixture()
    await off.health.backupNow()
    expect(off.tasks).toEqual([])
    let release: () => void = () => undefined
    const slow = fixture({
      backupDir: '/b',
      runTask: () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true, detail: 'done' })
        }),
    })
    const first = slow.health.integrityNow()
    void slow.health.integrityNow()
    release()
    await first
    expect(slow.records).toHaveLength(1)
  })

  it('checks a real database in its own process and keeps only the last backups', async () => {
    const dir = tmp()
    const dbPath = join(dir, 'market.sqlite')
    const db = new DatabaseSync(dbPath)
    db.exec('CREATE TABLE t(x INTEGER); INSERT INTO t VALUES (1),(2),(3)')
    db.close()
    expect(await spawnTask({ kind: 'integrity', dbPath })).toMatchObject({
      ok: true,
    })
    const backups = join(dir, 'backups')
    for (let i = 0; i < 3; i += 1) {
      const result = await spawnTask({
        kind: 'backup',
        dbPath,
        dir: backups,
        keep: 2,
      })
      expect(result.ok).toBe(true)
      await new Promise((resolve) => setTimeout(resolve, 1_100))
    }
    expect(readdirSync(backups)).toHaveLength(2)
    const bad = await spawnTask({
      kind: 'integrity',
      dbPath: join(dir, 'missing.sqlite'),
    })
    expect(bad.ok).toBe(false)
  }, 30_000)
})
