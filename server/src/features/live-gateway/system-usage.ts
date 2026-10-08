import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

type Row = Record<string, unknown>

export interface SystemUsageOptions {
  /** JSON written by the dev supervisor: `processes` health and `resources`. */
  readonly healthPath?: string
  /** Folder with the live SQLite files (their size is the saved data). */
  readonly dataDir?: string
  /** Qwen's decisions DB (opened read-only). */
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

const HOUR_MS = 3_600_000

function readJson(path: string | undefined): Row | null {
  if (!path) return null
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return value && typeof value === 'object' ? (value as Row) : null
  } catch {
    return null
  }
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Sum of the files in `dir` (SQLite, WAL and JSON), in bytes; null if unreadable. */
export function folderBytes(dir: string | undefined): number | null {
  if (!dir) return null
  let total = 0
  const walk = (path: string, depth: number): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, entry.name)
      if (entry.isDirectory()) {
        if (depth < 3) walk(full, depth + 1)
      } else if (entry.isFile()) {
        total += statSync(full).size
      }
    }
  }
  try {
    walk(dir, 0)
    return total
  } catch {
    return null
  }
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

function decisionStats(path: string | undefined, now: number): Row | null {
  if (!path) return null
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(path, { readOnly: true })
    const row = db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(written_at >= ?) AS last_hour,
                (SELECT AVG(latency_ms) FROM (SELECT latency_ms FROM paper_futures_llm_decisions ORDER BY written_at DESC LIMIT 20)) AS latency_ms
           FROM paper_futures_llm_decisions`,
      )
      .get(now - HOUR_MS) as Row
    return {
      total: num(row.total) ?? 0,
      last_hour: num(row.last_hour) ?? 0,
      avg_latency_ms: num(row.latency_ms),
    }
  } catch {
    return null
  } finally {
    db?.close()
  }
}

/**
 * What the machine pays for the app: CPU and memory of the dev processes
 * (sampled by the dev supervisor), size of the saved data, how much Qwen is
 * asked and the Kronos forward run. Cheap and cached; every piece degrades
 * to null when its source is missing.
 */
export function createSystemUsage(options: SystemUsageOptions): SystemUsage {
  const clock = options.clock ?? Date.now
  const cacheMs = options.cacheMs ?? 5_000
  let cached: { at: number; body: Row } | undefined
  return {
    report() {
      const now = clock()
      if (cached && now - cached.at < cacheMs) return cached.body
      const health = readJson(options.healthPath)
      const resources = (health?.resources ?? null) as Row | null
      const processes = (health?.processes ?? null) as Row | null
      const bytes = folderBytes(options.dataDir)
      const exit = readJson(options.qwenExitSummaryPath)
      const exitDecisions = (exit?.exit_decisions ?? null) as Row | null
      const kronos = readJson(options.kronosSummaryPath)
      const kronosProcess = (resources?.kronos ?? null) as Row | null
      const body: Row = {
        schema: 'system-usage.v1',
        at_ms: now,
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
          decisions: decisionStats(options.decisionsDbPath, now),
          exit_decisions: exitDecisions
            ? (num(exitDecisions.hold) ?? 0) + (num(exitDecisions.close) ?? 0)
            : null,
        },
        kronos: {
          running: kronosProcess ? Boolean(kronosProcess.running) : null,
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
