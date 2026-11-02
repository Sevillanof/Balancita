import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createDbHealth,
  spawnTask,
  type DbHealthState,
  type HealthTask,
} from './db-health.ts'

const dirs: string[] = []
afterEach(() => {
  vi.useRealTimers()
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
  const order: string[] = []
  let now = 1_000
  const health = createDbHealth({
    store: {
      checkpoint: () => ({ busy: false, walFrames: 10, moved: 10 }),
      checkpointTruncate: () => {
        order.push('truncate')
        return { busy: false, walFrames: 0, moved: 0 }
      },
    },
    dbPath: '/nowhere/market.sqlite',
    log: (line) => lines.push(line),
    record: (entry) => records.push(entry),
    clock: () => now,
    walBytes: () => 1_000,
    runTask: async (task) => {
      tasks.push(task)
      order.push(task.kind)
      return { ok: true, detail: 'fine' }
    },
    ...over,
  })
  return {
    health,
    lines,
    records,
    tasks,
    order,
    advance: (ms: number) => (now += ms),
  }
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

  it('reports a failed integrity check loudly, names the damaged file and keeps going', async () => {
    const dir = tmp()
    const statePath = join(dir, 'db-health-state.json')
    const { health, lines, records } = fixture({
      statePath,
      runTask: async () => ({ ok: false, detail: 'quick_check: bad page' }),
    })
    await health.integrityNow()
    expect(records[0]).toMatchObject({ check: 'integrity', ok: false })
    expect(lines.join('\n')).toContain('DATABASE HEALTH PROBLEM (integrity)')
    expect(lines.join('\n')).toContain('Base dañada: market.sqlite')
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as DbHealthState
    expect(state.damaged).toBe('market.sqlite')
    expect(state.integrity).toMatchObject({ ok: false })
    // Heavy writes (the cleanup) wait while the database is damaged...
    expect(health.writesAllowed()).toBe(false)
  })

  it('clears the damaged flag when a later check passes, and a check that timed out gives no verdict', async () => {
    let answer: Awaited<
      ReturnType<NonNullable<Parameters<typeof createDbHealth>[0]['runTask']>>
    > = {
      ok: false,
      detail: 'bad',
    }
    const { health } = fixture({ runTask: async () => answer })
    await health.integrityNow()
    expect(health.state().damaged).toBe('market.sqlite')
    answer = { ok: false, timedOut: true, detail: 'too slow' }
    await health.integrityNow()
    expect(health.state().damaged).toBe('market.sqlite')
    expect(health.state().integrity.timed_out).toBe(true)
    answer = { ok: true, detail: 'quick_check ok' }
    await health.integrityNow()
    expect(health.state().damaged).toBeNull()
    expect(health.writesAllowed()).toBe(true)
  })

  it('a write that answers "malformed" marks the database damaged at once and confirms with a check', async () => {
    const { health, tasks, lines } = fixture()
    health.reportMalformed('SqliteError: database disk image is malformed')
    expect(health.state().damaged).toBe('market.sqlite')
    expect(lines.join('\n')).toContain('Base dañada: market.sqlite')
    await vi.waitFor(() => expect(tasks).toHaveLength(1))
    expect(tasks[0]).toMatchObject({ kind: 'integrity' })
  })

  it('never overlaps two integrity checks', async () => {
    let release: () => void = () => undefined
    const slow = fixture({
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

  it('checks the integrity every 15 minutes by default', async () => {
    vi.useFakeTimers()
    const { health, tasks } = fixture()
    health.start()
    await vi.advanceTimersByTimeAsync(15 * 60_000 + 10)
    expect(tasks.filter((t) => t.kind === 'integrity')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(15 * 60_000)
    expect(tasks.filter((t) => t.kind === 'integrity')).toHaveLength(2)
    health.stop()
  })

  it('after waking up it truncates the WAL first and checks the integrity before heavy writes resume', async () => {
    let release: () => void = () => undefined
    const { health, order } = fixture({
      runTask: () =>
        new Promise((resolve) => {
          order.push('integrity')
          release = () => resolve({ ok: true, detail: 'quick_check ok' })
        }),
    })
    const pending = health.afterWake({
      at: 1_000,
      gapMs: 8 * 3_600_000,
      sleptMs: 8 * 3_600_000,
      kind: 'sleep',
    })
    expect(order).toEqual(['truncate', 'integrity'])
    expect(health.writesAllowed()).toBe(false)
    release()
    await pending
    expect(health.writesAllowed()).toBe(true)
    expect(health.state().wake).toMatchObject({ kind: 'sleep' })
  })

  describe('daily backups', () => {
    const targets = [
      { name: 'a', dbPath: '/db/a.sqlite' },
      { name: 'b', dbPath: '/db/b.sqlite' },
    ]

    it('asks for a copy of each database, one at a time, keeping 3, and retries a missing copy after an hour', async () => {
      const dir = tmp()
      const { health, tasks, advance } = fixture({
        backupDir: join(dir, 'backups'),
        backupTargets: targets,
        statePath: join(dir, 'state.json'),
      })
      await health.backupsNow()
      expect(tasks.map((t) => (t.kind === 'backup' ? t.name : t.kind))).toEqual(
        ['a', 'b'],
      )
      expect(tasks[0]).toMatchObject({ keep: 3 })
      // Fake runner wrote no file: due again once the retry gap passes.
      advance(2 * 3_600_000)
      await health.backupsNow()
      expect(tasks).toHaveLength(4)
    })

    it('does not start while the cleanup works nor right after a wake-up', async () => {
      let busy = true
      const { health, tasks, advance } = fixture({
        backupDir: tmp(),
        backupTargets: targets,
        isRetentionBusy: () => busy,
      })
      await health.backupsNow()
      expect(tasks).toHaveLength(0)
      busy = false
      await health.afterWake({ at: 1, gapMs: 3e5, sleptMs: 3e5, kind: 'sleep' })
      tasks.length = 0
      await health.backupsNow()
      expect(tasks).toHaveLength(0)
      advance(11 * 60_000)
      await health.backupsNow()
      expect(tasks).toHaveLength(2)
    })

    it('never makes two copies at the same time', async () => {
      const releases: (() => void)[] = []
      const { health, tasks } = fixture({
        backupDir: tmp(),
        backupTargets: targets,
        runTask: (task) =>
          new Promise((resolve) => {
            tasks.push(task)
            releases.push(() => resolve({ ok: true, detail: 'ok' }))
          }),
      })
      const first = health.backupsNow()
      void health.backupsNow()
      expect(health.backupBusy()).toBe(true)
      expect(tasks).toHaveLength(1)
      releases[0]?.()
      await vi.waitFor(() => expect(tasks).toHaveLength(2))
      releases[1]?.()
      await first
      expect(health.backupBusy()).toBe(false)
    })

    it('publishes a failed source check so the panel shows it, without a retry storm', async () => {
      const dir = tmp()
      const statePath = join(dir, 'state.json')
      const { health, tasks, advance } = fixture({
        backupDir: join(dir, 'backups'),
        backupTargets: [targets[0] as (typeof targets)[number]],
        statePath,
        runTask: async (task) => {
          tasks.push(task)
          return {
            ok: false,
            sourceFailed: true,
            detail: 'a: la base falló su chequeo',
          }
        },
      })
      await health.backupsNow()
      const state = JSON.parse(readFileSync(statePath, 'utf8')) as DbHealthState
      expect(state.backups.a).toMatchObject({ ok: false, source_failed: true })
      advance(10 * 60_000)
      await health.backupsNow()
      expect(tasks).toHaveLength(1)
    })
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
    for (let i = 0; i < 4; i += 1) {
      const result = await spawnTask({
        kind: 'backup',
        name: 'market',
        dbPath,
        dir: backups,
        keep: 3,
      })
      expect(result.ok).toBe(true)
      await new Promise((resolve) => setTimeout(resolve, 1_100))
    }
    expect(readdirSync(backups)).toHaveLength(3)
    const bad = await spawnTask({
      kind: 'integrity',
      dbPath: join(dir, 'missing.sqlite'),
    })
    expect(bad.ok).toBe(false)
  }, 30_000)
})
