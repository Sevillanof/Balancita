import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  backupDatabase,
  backupStamp,
  backupStampMs,
  defaultBackupDir,
  isMalformedError,
  latestBackupMs,
  listBackups,
  quickCheck,
} from './sqlite-safety.ts'
import { damageTable, makeDb } from './sqlite-test-helpers.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'balancita-safety-'))
  dirs.push(dir)
  return dir
}

describe('malformed errors', () => {
  it('recognises what SQLite says when the file is damaged', () => {
    expect(
      isMalformedError(new Error('database disk image is malformed')),
    ).toBe(true)
    expect(
      isMalformedError(
        'quick_check: Main freelist: freelist leaf count too big',
      ),
    ).toBe(true)
    expect(isMalformedError('file is not a database')).toBe(true)
    expect(isMalformedError(new Error('database is locked'))).toBe(false)
    expect(isMalformedError('connection reset')).toBe(false)
  })
})

describe('quick check', () => {
  it('passes a healthy database and names the problem of a damaged one', () => {
    const path = join(tmp(), 'a.sqlite')
    makeDb(path)
    expect(quickCheck(path)).toMatchObject({ ok: true })
    damageTable(path, 'bad')
    const result = quickCheck(path)
    expect(result.ok).toBe(false)
    expect(result.detail).toMatch(/quick_check/)
    expect(quickCheck(join(tmp(), 'missing.sqlite')).ok).toBe(false)
  })
})

describe('backup with retention', () => {
  it('makes consistent copies through the backup API and keeps the 3 newest good ones', async () => {
    const dir = tmp()
    const path = join(dir, 'src.sqlite')
    makeDb(path, 200)
    const backups = join(dir, 'backups')
    const t0 = Date.UTC(2026, 10, 1, 3, 0, 0)
    for (let day = 0; day < 5; day += 1) {
      const result = await backupDatabase({
        name: 'src',
        dbPath: path,
        dir: backups,
        keep: 3,
        now: t0 + day * 86_400_000,
      })
      expect(result.ok).toBe(true)
    }
    const kept = listBackups(backups, 'src')
    expect(kept).toEqual([
      'src-20261103-030000.sqlite',
      'src-20261104-030000.sqlite',
      'src-20261105-030000.sqlite',
    ])
    expect(latestBackupMs(backups, 'src')).toBe(t0 + 4 * 86_400_000)
    // No temporary files are left behind and every copy opens and holds the data.
    expect(readdirSync(backups).sort()).toEqual(kept) // no .tmp, -wal or -shm left behind
    const copy = new DatabaseSync(join(backups, kept[2] as string), {
      readOnly: true,
    })
    expect(
      (copy.prepare('SELECT COUNT(*) AS n FROM good').get() as { n: number }).n,
    ).toBe(200)
    copy.close()
  })

  it('does not copy a source that fails its check and leaves the last good copy untouched', async () => {
    const dir = tmp()
    const path = join(dir, 'src.sqlite')
    makeDb(path)
    const backups = join(dir, 'backups')
    const first = await backupDatabase({
      name: 'src',
      dbPath: path,
      dir: backups,
      keep: 3,
      now: Date.UTC(2026, 10, 1),
    })
    expect(first.ok).toBe(true)
    damageTable(path, 'bad')
    const second = await backupDatabase({
      name: 'src',
      dbPath: path,
      dir: backups,
      keep: 3,
      now: Date.UTC(2026, 10, 2),
    })
    expect(second).toMatchObject({ ok: false, sourceFailed: true })
    expect(second.detail).toContain('se conserva la última copia buena')
    expect(listBackups(backups, 'src')).toEqual(['src-20261101-000000.sqlite'])
    expect(quickCheck(join(backups, 'src-20261101-000000.sqlite')).ok).toBe(
      true,
    )
  })

  it('a missing source is reported, not created', async () => {
    const dir = tmp()
    const result = await backupDatabase({
      name: 'gone',
      dbPath: join(dir, 'gone.sqlite'),
      dir: join(dir, 'backups'),
      keep: 3,
    })
    expect(result.ok).toBe(false)
    expect(existsSync(join(dir, 'backups'))).toBe(false)
  })
})

describe('backup names', () => {
  it('round-trips the stamp and ignores other files and other databases with a similar name', () => {
    const at = Date.UTC(2026, 10, 2, 10, 11, 5)
    expect(backupStamp(at)).toBe('20261102-101105')
    expect(backupStampMs('x-20261102-101105.sqlite')).toBe(at)
    expect(backupStampMs('x.sqlite')).toBeNull()
    const dir = tmp()
    expect(listBackups(join(dir, 'none'), 'x')).toEqual([])
  })

  it('puts the copies of dev-live next to it in server/data/backups', () => {
    expect(
      defaultBackupDir('/r/server/data/dev-live/futures-market.sqlite'),
    ).toBe('/r/server/data/backups')
    expect(defaultBackupDir('/r/data/futures-market.sqlite')).toBe(
      '/r/data/backups',
    )
  })
})
