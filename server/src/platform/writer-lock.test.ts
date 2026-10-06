import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FuturesMarketStore } from '../features/kraken-futures/futures-market-store.ts'
import { acquireWriterLock, WriterLockError } from './writer-lock.ts'

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'writer-lock-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function deadPid(): number {
  // A real pid that has certainly exited.
  const child = spawnSync(process.execPath, ['-e', ''])
  return child.pid
}

describe('writer lock', () => {
  it('creates a lock file with pid and start time and releases it', () => {
    const db = join(dir, 'market.sqlite')
    const lock = acquireWriterLock(db)
    const body = JSON.parse(readFileSync(lock.path, 'utf8'))
    expect(lock.path).toBe(`${db}.writer.lock`)
    expect(body.pid).toBe(process.pid)
    expect(typeof body.startedAt).toBe('string')
    lock.release()
    expect(existsSync(lock.path)).toBe(false)
    lock.release() // idempotent
    acquireWriterLock(db).release()
  })

  it('refuses a second writer and names the holder pid and how to stop it', () => {
    const db = join(dir, 'market.sqlite')
    const first = acquireWriterLock(db)
    let error: unknown
    try {
      acquireWriterLock(db)
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(WriterLockError)
    const message = (error as WriterLockError).message
    expect(message).toContain(String(process.pid))
    expect(message).toMatch(/kill|stop/i)
    expect((error as WriterLockError).holderPid).toBe(process.pid)
    // The refused attempt must not delete the live holder's lock.
    expect(existsSync(first.path)).toBe(true)
    first.release()
  })

  it('recovers a stale lock left by a dead process (crash / SIGKILL)', () => {
    const db = join(dir, 'market.sqlite')
    const path = `${db}.writer.lock`
    writeFileSync(
      path,
      JSON.stringify({ pid: deadPid(), startedAt: '2020-01-01T00:00:00.000Z' }),
    )
    const lock = acquireWriterLock(db)
    expect(JSON.parse(readFileSync(path, 'utf8')).pid).toBe(process.pid)
    lock.release()
  })

  it('recovers a corrupt or empty lock file', () => {
    const db = join(dir, 'market.sqlite')
    writeFileSync(`${db}.writer.lock`, '')
    acquireWriterLock(db).release()
    writeFileSync(`${db}.writer.lock`, '{not json')
    acquireWriterLock(db).release()
  })

  it('treats a live pid whose start time differs as pid reuse (stale)', () => {
    const db = join(dir, 'market.sqlite')
    writeFileSync(
      `${db}.writer.lock`,
      JSON.stringify({
        pid: process.pid,
        startedAt: '2020-01-01T00:00:00.000Z',
        processStart: 'Thu Jan  1 00:00:00 1970',
      }),
    )
    acquireWriterLock(db).release()
  })

  it('does not release a lock that another writer has since taken', () => {
    const db = join(dir, 'market.sqlite')
    const lock = acquireWriterLock(db)
    writeFileSync(
      lock.path,
      JSON.stringify({ pid: process.pid + 1, startedAt: 'x', token: 'other' }),
    )
    lock.release()
    expect(existsSync(lock.path)).toBe(true)
  })

  it('leaves readers unaffected: read-only stores open and read while locked', () => {
    const db = join(dir, 'market.sqlite')
    const lock = acquireWriterLock(db)
    const writer = new FuturesMarketStore(db)
    const reader = new FuturesMarketStore(db, { readOnly: true })
    expect(reader.eventCount()).toBe(0)
    // A second read-only opener needs no lock either.
    const another = new FuturesMarketStore(db, { readOnly: true })
    expect(another.eventCount()).toBe(0)
    another.close()
    reader.close()
    writer.close()
    lock.release()
  })
})
