import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs'
import { dirname } from 'node:path'

/**
 * Single-writer guard for a SQLite file, kept outside SQLite on purpose: a
 * `BEGIN EXCLUSIVE` connection or a lease row would block or race the WAL
 * readers (read-only gateway, Python services). A sibling lock file
 * `<db>.writer.lock` holding {pid, startedAt, processStart, token} is created
 * atomically (`wx`), so readers never see or need it. A crash or SIGKILL
 * leaves it behind; the next writer detects the dead holder with
 * `process.kill(pid, 0)` (plus the OS process start time to catch pid reuse)
 * and takes it over. Works on macOS and Linux; no native modules.
 */

export class WriterLockError extends Error {
  readonly holderPid: number | undefined
  readonly lockPath: string
  constructor(message: string, lockPath: string, holderPid?: number) {
    super(message)
    this.name = 'WriterLockError'
    this.lockPath = lockPath
    this.holderPid = holderPid
  }
}

export interface WriterLock {
  readonly path: string
  /** Idempotent; only removes the file while it is still this writer's. */
  release(): void
}

interface LockBody {
  pid?: unknown
  startedAt?: unknown
  processStart?: unknown
  token?: unknown
}

/** Best-effort OS start time of a pid (`ps -o lstart=`; macOS and Linux). */
function processStart(pid: number): string | undefined {
  try {
    const text = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).trim()
    return text || undefined
  } catch {
    return undefined
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: exists but owned by someone else, so it is alive.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function readBody(path: string): LockBody | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return parsed && typeof parsed === 'object' ? (parsed as LockBody) : {}
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    return {} // empty or corrupt: no live holder can be named
  }
}

function holderIsLive(body: LockBody): boolean {
  const pid = body.pid
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0)
    return false
  if (!pidAlive(pid)) return false
  if (typeof body.processStart === 'string') {
    const now = processStart(pid)
    if (now !== undefined && now !== body.processStart) return false // reused
  }
  return true
}

function createExclusive(path: string, text: string): boolean {
  let fd: number
  try {
    fd = openSync(path, 'wx', 0o644)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
  try {
    writeSync(fd, text)
  } finally {
    closeSync(fd)
  }
  return true
}

export function acquireWriterLock(dbPath: string): WriterLock {
  if (!dbPath || dbPath === ':memory:')
    throw new TypeError('A writer lock needs a database file path.')
  const path = `${dbPath}.writer.lock`
  const guard = `${path}.takeover`
  mkdirSync(dirname(path), { recursive: true })
  const token = randomBytes(8).toString('hex')
  const text = JSON.stringify({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    processStart: processStart(process.pid),
    token,
  })

  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (createExclusive(path, text)) {
      let released = false
      return {
        path,
        release() {
          if (released) return
          released = true
          if (readBody(path)?.token === token) rmSync(path, { force: true })
        },
      }
    }
    const body = readBody(path)
    if (body === undefined) continue // vanished between the two calls
    if (holderIsLive(body)) {
      const pid = typeof body.pid === 'number' ? body.pid : undefined
      throw new WriterLockError(
        `Another process (pid ${pid}, started ${String(body.startedAt)}) is ` +
          `already writing ${dbPath}. Stop it first (kill ${pid}, or Ctrl-C ` +
          `its \`pnpm run dev\`) and retry. Lock file: ${path}`,
        path,
        pid,
      )
    }
    // Stale. Serialise takeovers so two recoverers cannot delete each
    // other's fresh lock; an abandoned guard (>5 s old) is discarded.
    if (!createExclusive(guard, String(process.pid))) {
      try {
        if (Date.now() - statSync(guard).mtimeMs > 5000)
          rmSync(guard, { force: true })
      } catch {
        // guard already gone
      }
      continue
    }
    try {
      const again = readBody(path)
      if (again !== undefined && !holderIsLive(again)) {
        const aside = `${path}.stale.${process.pid}`
        renameSync(path, aside)
        rmSync(aside, { force: true })
      }
    } finally {
      rmSync(guard, { force: true })
    }
  }
  throw new WriterLockError(
    `Could not acquire the writer lock ${path} (contended).`,
    path,
  )
}
