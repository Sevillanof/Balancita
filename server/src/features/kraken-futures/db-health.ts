import { spawn } from 'node:child_process'
import { statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** Result of one child task: `ok` false means the database (or its backup) is not healthy. */
export type HealthTaskResult = Readonly<{ ok: boolean; detail: string }>
export type HealthTask =
  | { kind: 'integrity'; dbPath: string }
  | { kind: 'backup'; dbPath: string; dir: string; keep: number }

export interface DbHealthOptions {
  readonly store: {
    checkpoint(): { busy: boolean; walFrames: number; moved: number }
  }
  readonly dbPath: string
  readonly log: (line: string) => void
  /** One JSON per line in `health.jsonl`: every check leaves a trace. */
  readonly record: (entry: Record<string, unknown>) => void
  readonly clock?: () => number
  /** Runs a slow check in another process, so the capture's event loop is never held. */
  readonly runTask?: (task: HealthTask) => Promise<HealthTaskResult>
  readonly walBytes?: () => number
  /** WAL folded back into the file this often (default 5 min). */
  readonly checkpointMs?: number
  /** Integrity check of the database (default daily). */
  readonly integrityMs?: number
  /** Full backup into `backupDir`, keeping `backupKeep` (default off: 0). */
  readonly backupMs?: number
  readonly backupDir?: string
  readonly backupKeep?: number
  /** A WAL bigger than this is reported as a problem (default 2 GiB). */
  readonly walWarnBytes?: number
}

const CHILD = fileURLToPath(new URL('./db-health-child.ts', import.meta.url))

/** Default task runner: `node db-health-child.ts <json>`, one JSON line back. */
export function spawnTask(task: HealthTask): Promise<HealthTaskResult> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['--experimental-strip-types', CHILD, JSON.stringify(task)],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()))
    child.on('error', (error) => resolve({ ok: false, detail: String(error) }))
    child.on('close', () => {
      try {
        const last = out.trim().split('\n').at(-1) ?? ''
        const parsed = JSON.parse(last) as HealthTaskResult
        resolve({ ok: parsed.ok === true, detail: String(parsed.detail) })
      } catch {
        resolve({
          ok: false,
          detail: `check did not answer: ${err.trim().slice(-300) || 'no output'}`,
        })
      }
    })
  })
}

/**
 * Keeps the market database healthy while the capture runs: folds the WAL
 * back every few minutes (a WAL that never shrinks slows every reader),
 * checks integrity daily and, if asked, keeps the last backups. A failed check
 * is logged loudly and recorded; the capture itself is never stopped by it.
 */
export function createDbHealth(options: DbHealthOptions) {
  const clock = options.clock ?? Date.now
  const runTask = options.runTask ?? spawnTask
  const walBytes =
    options.walBytes ??
    (() => {
      try {
        return statSync(`${options.dbPath}-wal`).size
      } catch {
        return 0
      }
    })
  const walWarn = options.walWarnBytes ?? 2 * 1024 ** 3
  const timers: ReturnType<typeof setInterval>[] = []
  const busy = new Set<string>()

  const checkpointNow = (): void => {
    try {
      const result = options.store.checkpoint()
      const wal = walBytes()
      options.record({
        at: clock(),
        check: 'checkpoint',
        ...result,
        walBytes: wal,
      })
      if (wal > walWarn)
        options.log(
          `database health: the WAL is ${Math.round(wal / 1024 ** 2)} MiB after a checkpoint (a reader may be holding it back)`,
        )
    } catch (error) {
      options.log(`database health: checkpoint failed: ${String(error)}`)
    }
  }

  const runChild = async (
    check: 'integrity' | 'backup',
    task: HealthTask,
  ): Promise<void> => {
    if (busy.has(check)) return
    busy.add(check)
    try {
      const result = await runTask(task)
      options.record({ at: clock(), check, ...result })
      if (!result.ok)
        options.log(
          `DATABASE HEALTH PROBLEM (${check}): ${result.detail}. The capture keeps running; see health.jsonl.`,
        )
    } finally {
      busy.delete(check)
    }
  }
  const integrityNow = (): Promise<void> =>
    runChild('integrity', { kind: 'integrity', dbPath: options.dbPath })
  const backupNow = (): Promise<void> =>
    options.backupDir
      ? runChild('backup', {
          kind: 'backup',
          dbPath: options.dbPath,
          dir: options.backupDir,
          keep: options.backupKeep ?? 2,
        })
      : Promise.resolve()

  return {
    checkpointNow,
    integrityNow,
    backupNow,
    start(): void {
      const every = (ms: number, task: () => unknown): void => {
        const timer = setInterval(() => void task(), ms)
        timer.unref()
        timers.push(timer)
      }
      every(options.checkpointMs ?? 300_000, checkpointNow)
      every(options.integrityMs ?? 86_400_000, integrityNow)
      if (options.backupDir && (options.backupMs ?? 0) > 0)
        every(options.backupMs ?? 0, backupNow)
    },
    stop(): void {
      for (const timer of timers) clearInterval(timer)
      timers.length = 0
    },
  }
}
