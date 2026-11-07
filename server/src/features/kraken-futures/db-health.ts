import { spawn } from 'node:child_process'
import {
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { latestBackupMs } from '../../platform/sqlite-safety.ts'
import type { WakeEvent } from '../../platform/wake-detector.ts'

/** Result of one child task: `ok` false means the database (or its backup) is not healthy. */
export type HealthTaskResult = Readonly<{
  ok: boolean
  detail: string
  /** The database being backed up failed its own check, so nothing was copied. */
  sourceFailed?: boolean
  /** The check took longer than its limit and was stopped: no verdict, not a damaged database. */
  timedOut?: boolean
  file?: string
}>
export type HealthTask =
  | { kind: 'integrity'; dbPath: string }
  | {
      kind: 'backup'
      name: string
      dbPath: string
      dir: string
      keep: number
    }

export interface BackupTarget {
  /** Name used in the backup file names (`<name>-<stamp>.sqlite`). */
  readonly name: string
  readonly dbPath: string
}

/** What the system-health panel reads (`db-health-state.json`, rewritten atomically). */
export interface DbHealthState {
  readonly schema: 'db-health.v1'
  readonly updated_at: number
  readonly integrity: {
    readonly file: string
    /** null until the first check finished. */
    readonly ok: boolean | null
    readonly checked_at: number | null
    readonly detail: string
    /** The last check ran too long and was stopped (no verdict). */
    readonly timed_out: boolean
  }
  /** Base name of the damaged database file, null when none is known to be damaged. */
  readonly damaged: string | null
  /** How often the integrity check runs (the panel judges a «late» check against this). */
  readonly integrity_every_ms: number
  readonly backup_every_ms: number
  readonly backups: Readonly<
    Record<
      string,
      {
        readonly ok: boolean
        readonly at: number
        readonly detail: string
        readonly source_failed: boolean
        readonly last_good_at: number | null
      }
    >
  >
  readonly wake: {
    readonly at: number
    readonly kind: WakeEvent['kind']
    readonly slept_ms: number
  } | null
}

export interface DbHealthOptions {
  readonly store: {
    checkpoint(): { busy: boolean; walFrames: number; moved: number }
    checkpointTruncate?(): { busy: boolean; walFrames: number; moved: number }
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
  /** Integrity check of the capture database (default every 6 h; see `DEFAULT_INTEGRITY_MS`). */
  readonly integrityMs?: number
  /** Databases copied daily (empty: no backups). */
  readonly backupTargets?: readonly BackupTarget[]
  readonly backupDir?: string
  /** A new copy is made when the newest one is older than this (default 24 h). */
  readonly backupMs?: number
  /** How often the scheduler looks whether a copy is due (default 10 min). */
  readonly backupCheckMs?: number
  /** Good copies kept per database (default 3). */
  readonly backupKeep?: number
  /** A failed copy of the same database is not retried before this (default 1 h). */
  readonly backupRetryMs?: number
  /** True while the retention cleanup is working: backups wait for it. */
  readonly isRetentionBusy?: () => boolean
  /** Where the panel's state is written; omitted: nothing is written. */
  readonly statePath?: string
  /** A WAL bigger than this is reported as a problem (default 2 GiB). */
  readonly walWarnBytes?: number
  /** After a wake-up no backup starts for this long (default 10 min). */
  readonly wakePauseMs?: number
  /** The integrity check is stopped, with no verdict, after this long (default 45 min). */
  readonly integrityTimeoutMs?: number
  readonly backupTimeoutMs?: number
}

const CHILD = fileURLToPath(new URL('./db-health-child.ts', import.meta.url))

const MINUTE = 60_000
/** Integrity check every 6 h: a 10 GB `quick_check` every 15 min kept the disk busy (analisis/vps-qwen-lento). */
export const DEFAULT_INTEGRITY_MS = 360 * MINUTE
/** Margin for that check on a busy disk; past it the check is stopped without a verdict. */
export const DEFAULT_INTEGRITY_TIMEOUT_MS = 45 * MINUTE

/**
 * The command that runs a health child. On Linux, with `nice` and `ionice` on the PATH, the child gets the
 * lowest CPU and idle IO priority (`nice -n 19 ionice -c3 node ...`) so the capture and llama-server win any
 * disk collision; anywhere else (or if either binary is missing) it is the plain `node ...`.
 */
export function lowPriorityCommand(input: {
  execPath: string
  args: readonly string[]
  platform?: NodeJS.Platform
  pathEnv?: string
  exists?: (file: string) => boolean
}): { command: string; args: string[] } {
  const plain = { command: input.execPath, args: [...input.args] }
  if ((input.platform ?? process.platform) !== 'linux') return plain
  const exists = input.exists ?? existsSync
  const dirs = (input.pathEnv ?? process.env.PATH ?? '')
    .split(delimiter)
    .filter(Boolean)
  const find = (name: string): string | undefined =>
    dirs.map((dir) => join(dir, name)).find((file) => exists(file))
  const nice = find('nice')
  const ionice = find('ionice')
  if (!nice || !ionice) return plain
  return {
    command: nice,
    args: ['-n', '19', ionice, '-c3', input.execPath, ...input.args],
  }
}

/** Default task runner: `node db-health-child.ts <json>`, one JSON line back. */
export function spawnTask(
  task: HealthTask,
  timeoutMs = 3_600_000,
): Promise<HealthTaskResult> {
  return new Promise((resolve) => {
    const { command, args } = lowPriorityCommand({
      execPath: process.execPath,
      args: ['--experimental-strip-types', CHILD, JSON.stringify(task)],
    })
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    timer.unref()
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()))
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ ok: false, detail: String(error) })
    })
    child.on('close', () => {
      clearTimeout(timer)
      if (timedOut)
        return resolve({
          ok: false,
          timedOut: true,
          detail: `el chequeo tardó más de ${Math.round(timeoutMs / 60_000)} min y se detuvo`,
        })
      try {
        const last = out.trim().split('\n').at(-1) ?? ''
        const parsed = JSON.parse(last) as HealthTaskResult
        resolve({
          ok: parsed.ok === true,
          detail: String(parsed.detail),
          ...(parsed.sourceFailed === true ? { sourceFailed: true } : {}),
          ...(typeof parsed.file === 'string' ? { file: parsed.file } : {}),
        })
      } catch {
        resolve({
          ok: false,
          detail: `check did not answer: ${err.trim().slice(-300) || 'no output'}`,
        })
      }
    })
  })
}

const HOUR = 3_600_000

/**
 * Keeps the market database healthy while the capture runs:
 * - folds the WAL back every few minutes (a WAL that never shrinks slows every reader);
 * - checks integrity every 6 h by default in its own process (`quick_check`, stopped after 45 min), at low priority on Linux;
 * - copies the databases once a day through SQLite's backup API (one at a time, never
 *   while the retention cleanup works, never right after a wake-up) and keeps the last good copies;
 * - after the machine wakes up: truncates the WAL and checks integrity before heavy writes resume.
 * A failed check is logged loudly, recorded and published in `db-health-state.json` (the panel
 * «Salud del sistema» reads it); the capture itself is never stopped by it.
 */
export function createDbHealth(options: DbHealthOptions) {
  const clock = options.clock ?? Date.now
  const runTask =
    options.runTask ?? ((task) => spawnTask(task, taskTimeout(task)))
  const taskTimeout = (task: HealthTask): number =>
    task.kind === 'integrity'
      ? (options.integrityTimeoutMs ?? DEFAULT_INTEGRITY_TIMEOUT_MS)
      : (options.backupTimeoutMs ?? 90 * 60_000)
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
  const backupEvery = options.backupMs ?? 24 * HOUR
  const integrityEvery = options.integrityMs ?? DEFAULT_INTEGRITY_MS
  const backupRetry = options.backupRetryMs ?? HOUR
  const wakePause = options.wakePauseMs ?? 10 * 60_000
  const dbFile = basename(options.dbPath)
  const timers: ReturnType<typeof setInterval>[] = []
  const timeouts: ReturnType<typeof setTimeout>[] = []
  let integrityRunning = false
  let backupRunning = false
  let wakeCheckPending = false
  let wakePausedUntil = Number.NEGATIVE_INFINITY
  let lastMalformedCheck = Number.NEGATIVE_INFINITY
  const lastAttempt = new Map<string, number>()

  let state: DbHealthState = loadState() ?? {
    schema: 'db-health.v1',
    updated_at: clock(),
    integrity: {
      file: dbFile,
      ok: null,
      checked_at: null,
      detail: 'todavía sin chequear',
      timed_out: false,
    },
    damaged: null,
    integrity_every_ms: integrityEvery,
    backup_every_ms: backupEvery,
    backups: {},
    wake: null,
  }

  function loadState(): DbHealthState | undefined {
    if (!options.statePath) return undefined
    try {
      const raw = JSON.parse(
        readFileSync(options.statePath, 'utf8'),
      ) as DbHealthState
      if (raw.schema !== 'db-health.v1') return undefined
      // A damaged flag from a previous run stays until a check says otherwise.
      return {
        ...raw,
        integrity_every_ms: integrityEvery,
        backup_every_ms: backupEvery,
      }
    } catch {
      return undefined
    }
  }
  const publish = (patch: Partial<DbHealthState>): void => {
    state = { ...state, ...patch, updated_at: clock() }
    if (!options.statePath) return
    try {
      const temp = `${options.statePath}.tmp`
      writeFileSync(temp, `${JSON.stringify(state)}\n`)
      renameSync(temp, options.statePath)
    } catch {
      // The panel falls back to "sin datos"; the capture is not the place to fail on it.
    }
  }

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

  const integrityNow = async (): Promise<HealthTaskResult | undefined> => {
    if (integrityRunning) return undefined
    integrityRunning = true
    try {
      const result = await runTask({
        kind: 'integrity',
        dbPath: options.dbPath,
      })
      options.record({ at: clock(), check: 'integrity', ...result })
      const timedOut = result.timedOut === true
      publish({
        integrity: {
          file: dbFile,
          // A check that was stopped for taking too long gives no verdict: the last one stands.
          ok: timedOut ? state.integrity.ok : result.ok,
          checked_at: clock(),
          detail: result.detail,
          timed_out: timedOut,
        },
        damaged: timedOut ? state.damaged : result.ok ? null : dbFile,
      })
      if (!result.ok)
        options.log(
          timedOut
            ? `database health: the integrity check was stopped: ${result.detail}`
            : `DATABASE HEALTH PROBLEM (integrity): ${result.detail}. Base dañada: ${dbFile}. The capture keeps running; see health.jsonl.`,
        )
      return result
    } finally {
      integrityRunning = false
    }
  }

  const inWakeWindow = (): boolean => clock() < wakePausedUntil

  const backupDue = (target: BackupTarget): boolean => {
    if (!options.backupDir) return false
    const last = latestBackupMs(options.backupDir, target.name)
    const tried = lastAttempt.get(target.name)
    if (tried !== undefined && clock() - tried < backupRetry) return false
    return last === null || clock() - last >= backupEvery
  }

  /** Copies, one at a time, every database whose newest copy is older than a day. `force` ignores the age. */
  const backupsNow = async (force = false): Promise<void> => {
    const dir = options.backupDir
    if (!dir || backupRunning) return
    backupRunning = true
    try {
      for (const target of options.backupTargets ?? []) {
        if (options.isRetentionBusy?.() || inWakeWindow()) return
        if (!force && !backupDue(target)) continue
        lastAttempt.set(target.name, clock())
        const result = await runTask({
          kind: 'backup',
          name: target.name,
          dbPath: target.dbPath,
          dir,
          keep: options.backupKeep ?? 3,
        })
        options.record({
          at: clock(),
          check: 'backup',
          name: target.name,
          ...result,
        })
        publish({
          backups: {
            ...state.backups,
            [target.name]: {
              ok: result.ok,
              at: clock(),
              detail: result.detail,
              source_failed: result.sourceFailed === true,
              last_good_at: latestBackupMs(dir, target.name),
            },
          },
        })
        if (!result.ok)
          options.log(
            `DATABASE HEALTH PROBLEM (backup ${target.name}): ${result.detail}. The capture keeps running; see health.jsonl.`,
          )
      }
    } finally {
      backupRunning = false
    }
  }

  return {
    checkpointNow,
    integrityNow,
    backupsNow,
    /** True while a backup copy is being made (the cleanup waits for it). */
    backupBusy: (): boolean => backupRunning,
    /** Current state as the panel sees it. */
    state: (): DbHealthState => state,
    /** False while the database is known damaged or a wake-up check is pending: heavy writes (cleanup) wait. */
    writesAllowed: (): boolean => state.damaged === null && !wakeCheckPending,
    /**
     * A write answered "malformed" (or a log line said so): mark the database as damaged now and
     * confirm with a real check (at most once a minute).
     */
    reportMalformed(source: string): void {
      options.log(
        `DATABASE HEALTH PROBLEM: a write failed as malformed (${source.slice(0, 120)}). Base dañada: ${dbFile}; checking.`,
      )
      publish({
        damaged: dbFile,
        integrity: {
          ...state.integrity,
          ok: false,
          detail: `escritura con error «malformed»: ${source.slice(0, 160)}`,
        },
      })
      if (clock() - lastMalformedCheck < 60_000) return
      lastMalformedCheck = clock()
      void integrityNow()
    },
    /**
     * The machine woke up. Folds the WAL fully (`TRUNCATE`) and checks integrity before heavy
     * writes resume; backups stay off for `wakePauseMs`.
     */
    async afterWake(event: WakeEvent): Promise<void> {
      wakePausedUntil = clock() + wakePause
      wakeCheckPending = true
      publish({
        wake: { at: event.at, kind: event.kind, slept_ms: event.sleptMs },
      })
      try {
        try {
          const result = (
            options.store.checkpointTruncate ?? options.store.checkpoint
          )()
          options.record({
            at: clock(),
            check: 'checkpoint',
            reason: 'wake',
            ...result,
            walBytes: walBytes(),
          })
        } catch (error) {
          options.log(
            `database health: checkpoint after waking failed: ${String(error)}`,
          )
        }
        await integrityNow()
      } finally {
        wakeCheckPending = false
      }
    },
    start(): void {
      const every = (ms: number, task: () => unknown): void => {
        const timer = setInterval(() => void task(), ms)
        timer.unref()
        timers.push(timer)
      }
      every(options.checkpointMs ?? 300_000, checkpointNow)
      every(integrityEvery, integrityNow)
      if (options.backupDir && (options.backupTargets?.length ?? 0) > 0) {
        every(options.backupCheckMs ?? 10 * 60_000, () => backupsNow())
        const first = setTimeout(() => void backupsNow(), 3 * 60_000)
        first.unref()
        timeouts.push(first)
      }
    },
    stop(): void {
      for (const timer of timers) clearInterval(timer)
      for (const timer of timeouts) clearTimeout(timer)
      timers.length = 0
      timeouts.length = 0
    },
  }
}
