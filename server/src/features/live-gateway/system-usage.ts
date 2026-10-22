import {
  closeSync, constants, fstatSync, lstatSync,
  openSync, opendirSync, readSync, statSync,
} from 'node:fs'
import { join } from 'node:path'

type Row = Record<string, unknown>

export interface SystemUsageOptions {
  /** JSON written by the dev supervisor: `processes` health and `resources`. */
  readonly healthPath?: string
  /** Only this directory is inventoried; file bytes are not logical data used. */
  readonly dataDir?: string
  /** Legacy option: not opened; historical aggregates have no bounded source. */
  readonly decisionsDbPath?: string
  /** Summary JSON of C31, where Qwen decides exits. */
  readonly qwenExitSummaryPath?: string
  /** Summary JSON of the Kronos forward measurement (run outside pnpm dev). */
  readonly kronosSummaryPath?: string
  readonly clock?: () => number
  readonly cacheMs?: number
}

export interface SystemUsage {
  report(): Row
}

const SAMPLE_MAX_AGE_MS = 15_000
const SUPERVISOR_MAX_AGE_MS = 30_000
const JSON_MAX_BYTES = 128 * 1024

function readJson(path: string | undefined): Row | null {
  if (!path) return null
  let fd: number | undefined
  try {
    fd = openSync(
      path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > JSON_MAX_BYTES) return null
    const buffer = Buffer.alloc(JSON_MAX_BYTES + 1)
    const length = readSync(fd, buffer, 0, buffer.length, 0)
    if (length > JSON_MAX_BYTES) return null
    const value: unknown = JSON.parse(buffer.subarray(0, length).toString('utf8'))
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Row) : null
  } catch {
    return null
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Streaming enumeration: no full listing/sort, no symlink traversal or DB reads. */
function storageInventory(dir: string | undefined, now: number) {
  const bytes = { sqlite_main: 0, wal: 0, shm: 0, log: 0, other: 0 }
  let visited = 0
  let symlinks = 0
  let errors = 0
  let reason: string | null = dir ? null : 'not_configured'
  let readable = false
  const walk = (path: string, depth: number): void => {
    const directory = opendirSync(path)
    try {
      for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
        if (visited >= 1_000) {
          reason = 'entry_limit'
          break
        }
        visited++
        const full = join(path, entry.name)
        try {
          const stat = lstatSync(full)
          if (stat.isSymbolicLink()) {
            symlinks++
            continue
          }
          if (stat.isDirectory()) {
            if (entry.name === 'models') continue
            if (depth < 3) walk(full, depth + 1)
            else reason ??= 'depth_limit'
          } else if (stat.isFile()) {
            const name = entry.name.toLowerCase()
            const category = name.endsWith('-wal') ? 'wal'
              : name.endsWith('-shm') ? 'shm'
              : /\.(sqlite|sqlite3|db)$/.test(name) ? 'sqlite_main'
              : /\.(log|jsonl)(\.\d+)?$/.test(name) ? 'log' : 'other'
            bytes[category] += stat.size
          }
        } catch {
          errors++
          reason ??= 'io_error'
        }
        if (reason === 'entry_limit') break
      }
    } finally {
      directory.closeSync()
    }
  }
  if (dir) {
    try {
      if (!lstatSync(dir).isDirectory()) throw new Error('not_directory')
      // Opening the root must succeed before any bytes can be evidence.
      const root = opendirSync(dir)
      root.closeSync()
      readable = true
      walk(dir, 0)
    } catch {
      errors++
      reason = 'io_error'
      readable = false
    }
  }
  const total = readable
    ? Object.values(bytes).reduce((sum, size) => sum + size, 0) : null
  return {
    status: !readable ? 'unavailable' : reason ? 'partial' : 'ok',
    reason,
    sampled_at_ms: readable ? now : null,
    complete: readable && reason === null,
    scope: 'configured_data_directory',
    excludes: ['models', 'other_roots', 'symlinks'],
    byte_basis: 'file_sizes_not_logical_data_used; partial_totals_are_lower_bounds',
    max_entries: 1_000,
    max_depth: 3,
    visited_entries: visited,
    symlinks_skipped: symlinks,
    error_count: errors,
    bytes: readable ? bytes : null,
    total_bytes: total,
  }
}

/** Legacy total exists only when the bounded inventory is complete. */
export function folderBytes(dir: string | undefined): number | null {
  const storage = storageInventory(dir, Date.now())
  return storage.complete ? storage.total_bytes : null
}

function resourceReason(
  health: Row | null, resources: Row | null, now: number,
): string | null {
  if (!resources) return 'missing_source'
  if (resources.status === undefined) return 'legacy_metadata'
  const updated = num(health?.updated_at_ms)
  if (updated === null || updated < 0 || updated > now)
    return 'supervisor_invalid_time'
  if (now - updated > SUPERVISOR_MAX_AGE_MS) return 'supervisor_stale'
  if (resources.status !== 'ok')
    return ['timeout', 'malformed_output'].includes(String(resources.reason))
      ? String(resources.reason) : 'collector_error'
  const sampled = num(resources.sampled_at_ms)
  if (sampled === null || sampled < 0 || sampled > now)
    return 'sample_invalid_time'
  if (now - sampled > SAMPLE_MAX_AGE_MS) return 'sample_stale'
  if ([resources.total_cpu_pct, resources.total_rss_mb].some(
    (value) => num(value) === null || Number(value) < 0,
  ))
    return 'malformed_output'
  return null
}

/** Kronos summary `decisions`: `[mode, count, traded]` rows; the forward count. */
function forwardDecisions(rows: unknown): number | null {
  if (!Array.isArray(rows)) return null
  const forward = rows.find((row) => Array.isArray(row) && row[0] === 'forward')
  return Array.isArray(forward) ? num(forward[1]) : null
}

function fileMtimeMs(path: string | undefined): number | null {
  if (!path) return null
  try {
    return Math.round(statSync(path).mtimeMs)
  } catch {
    return null
  }
}

/**
 * What the machine pays for the app: CPU and memory of the dev processes
 * (sampled by the dev supervisor), bounded file inventory and summary JSON.
 * No historical decision queries. Cached; every piece degrades
 * to null when its source is missing.
 */
export function createSystemUsage(options: SystemUsageOptions): SystemUsage {
  const clock = options.clock ?? Date.now
  const cacheMs = options.cacheMs ?? 5_000
  let cached: { at: number; body: Row } | undefined
  return {
    report() {
      const now = clock()
      if (
        cached && now >= cached.at && now - cached.at < cacheMs &&
        ((cached.body.status !== 'ok' && cached.body.processes === null) ||
          now - Number(cached.body.supervisor_updated_at_ms) <= SUPERVISOR_MAX_AGE_MS) &&
        (cached.body.status !== 'ok' ||
          now - Number(cached.body.sampled_at_ms) <= SAMPLE_MAX_AGE_MS)
      )
        return { ...cached.body, at_ms: now }
      const health = readJson(options.healthPath)
      const source = (health?.resources ?? null) as Row | null
      const reason = resourceReason(health, source, now)
      const resources = reason === null ? source : null
      const updated = num(health?.updated_at_ms)
      const processes = updated !== null && updated >= 0 && updated <= now &&
        now - updated <= SUPERVISOR_MAX_AGE_MS
          ? (health?.processes ?? null) as Row | null : null
      const storage = storageInventory(options.dataDir, now)
      const bytes = storage.complete ? storage.total_bytes : null
      const exit = readJson(options.qwenExitSummaryPath)
      const exitDecisions = (exit?.exit_decisions ?? null) as Row | null
      const kronos = readJson(options.kronosSummaryPath)
      const kronosProcess = (resources?.kronos ?? null) as Row | null
      const body: Row = {
        schema: 'system-usage.v1',
        at_ms: now,
        cached_at_ms: now,
        cache_ms: cacheMs,
        status: reason === null ? 'ok' : 'unavailable',
        reason,
        attempted_at_ms: num(source?.attempted_at_ms),
        completed_at_ms: num(source?.completed_at_ms),
        supervisor_updated_at_ms: updated,
        scope: {
          cpu_basis: 'one_core_percent',
          memory_basis: 'summed_rss_mib_not_unique_or_gpu',
          total_scope: 'unique_pids_in_supervised_groups_or_kronos',
          group_scope: 'process_group_membership_may_overlap_not_ownership',
        },
        storage,
        cpu_pct: num(resources?.total_cpu_pct),
        rss_mb: num(resources?.total_rss_mb),
        sampled_at_ms: num(resources?.sampled_at_ms),
        cores: num(resources?.cores),
        per_process: resources?.processes ?? null,
        data_mb:
          bytes === null ? null : Math.round((bytes / 1_048_576) * 10) / 10,
        qwen: {
          running:
            (processes?.llm as Row | undefined)?.status === 'running'
              ? true
              : processes?.llm
                ? false
                : null,
          cpu_pct: num(
            (((resources?.processes ?? {}) as Row).llm as Row | undefined)
              ?.cpu_pct,
          ),
          decisions: null,
          decisions_status: 'unavailable',
          decisions_reason: 'no_bounded_source',
          exit_decisions:
            num(exitDecisions?.hold) !== null && num(exitDecisions?.close) !== null
              ? Number(exitDecisions?.hold) + Number(exitDecisions?.close) : null,
        },
        kronos: {
          running: typeof kronosProcess?.running === 'boolean'
            ? kronosProcess.running : null,
          cpu_pct: num(kronosProcess?.cpu_pct),
          rss_mb: num(kronosProcess?.rss_mb),
          trades: num(
            (((kronos?.forward as Row | undefined)?.all ?? null) as Row | null)
              ?.trades,
          ),
          decisions: forwardDecisions(kronos?.decisions),
          updated_ms: fileMtimeMs(options.kronosSummaryPath),
        },
        processes,
      }
      cached = { at: now, body }
      return body
    },
  }
}
