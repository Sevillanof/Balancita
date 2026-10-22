import { execFile } from 'node:child_process'
import { cpus } from 'node:os'

function validateRows(rows) {
  if (!Array.isArray(rows)) throw new Error('malformed_output')
  const seen = new Set()
  for (const row of rows) {
    // Kernel/system rows may legitimately have PID or PGID zero.
    if (!row || !Number.isSafeInteger(row.pid) || row.pid < 0 ||
        !Number.isSafeInteger(row.pgid) || row.pgid < 0 ||
        !Number.isFinite(row.cpu) || row.cpu < 0 ||
        !Number.isSafeInteger(row.rssKb) || row.rssKb < 0 ||
        typeof row.command !== 'string' || seen.has(row.pid))
      throw new Error('malformed_output')
    seen.add(row.pid)
  }
  return rows
}

/** Parses ps rows (RSS in KiB); a partial/malformed snapshot is not a sample. */
export function parsePs(text) {
  const rows = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+(?:[.,]\d+)?)\s+(\d+)\s+(.*)$/.exec(line)
    if (!match) throw new Error('malformed_output')
    rows.push({
      pid: Number(match[1]),
      pgid: Number(match[2]),
      cpu: Number(match[3].replace(',', '.')),
      rssKb: Number(match[4]),
      command: match[5],
    })
  }
  return validateRows(rows)
}

const round1 = (value) => {
  const rounded = Math.round(value * 10) / 10
  if (!Number.isFinite(rounded)) throw new Error('malformed_output')
  return rounded
}
const scope = {
  cpu_basis: 'one_core_percent',
  memory_basis: 'summed_rss_mib_not_unique_or_gpu',
  total_scope: 'unique_pids_in_supervised_groups_or_kronos',
  group_scope: 'process_group_membership_may_overlap_not_ownership',
}
const metrics = (rows) => ({
  cpu_pct: round1(rows.reduce((sum, row) => sum + row.cpu, 0)),
  rss_mb: round1(rows.reduce((sum, row) => sum + row.rssKb, 0) / 1024),
})

/** Groups may overlap; only the union of matching PIDs contributes to totals. */
export function summarizeResources({
  rows,
  groups,
  kronosPattern = /kronos_lab/,
  now = Date.now(),
  cores = cpus().length,
}) {
  validateRows(rows)
  const processes = {}
  const groupPidCounts = {}
  const included = new Map()
  for (const [name, pgid] of Object.entries(groups)) {
    const own = rows.filter((row) => row.pgid === pgid)
    processes[name] = metrics(own)
    groupPidCounts[name] = own.length
    for (const row of own) included.set(row.pid, row)
  }
  // Clone to avoid stateful /g or /y patterns changing membership on each test.
  const pattern = new RegExp(kronosPattern.source, kronosPattern.flags.replace(/[gy]/g, ''))
  const kronos = rows.filter((row) => pattern.test(row.command))
  for (const row of kronos) included.set(row.pid, row)
  const total = metrics([...included.values()])
  return {
    status: 'ok',
    reason: null,
    sampled_at_ms: now,
    cores,
    ...scope,
    total_cpu_pct: total.cpu_pct,
    total_rss_mb: total.rss_mb,
    total_pid_count: included.size,
    group_pid_counts: groupPidCounts,
    processes,
    kronos: { running: kronos.length > 0, ...metrics(kronos) },
  }
}

/** One bounded ps call. Commands stay in transient rows; errors use fixed reasons. */
export function readPs({ exec = execFile } = {}) {
  return new Promise((resolve) => {
    exec(
      'ps',
      ['-Ao', 'pid=,pgid=,pcpu=,rss=,command='],
      { maxBuffer: 8 * 1024 * 1024, timeout: 2000 },
      (error, stdout) => {
        if (error) {
          resolve({ status: 'unavailable', reason: error.killed ? 'timeout' : 'collector_error' })
          return
        }
        try {
          resolve({ status: 'ok', rows: parsePs(stdout) })
        } catch {
          resolve({ status: 'unavailable', reason: 'malformed_output' })
        }
      },
    )
  })
}

/** Failure replaces the sample with nulls, never stale values or measured zeros. */
export async function collectResources({
  groups,
  collect = readPs,
  clock = Date.now,
  cores = cpus().length,
  kronosPattern,
}) {
  const attemptedAt = clock()
  let sample
  try {
    sample = await collect()
  } catch {
    sample = { status: 'unavailable', reason: 'collector_error' }
  }
  const completedAt = clock()
  const times = { attempted_at_ms: attemptedAt, completed_at_ms: completedAt }
  if (sample?.status === 'ok') {
    try {
      return {
        ...summarizeResources({
          rows: sample.rows, groups, cores, kronosPattern, now: completedAt,
        }),
        ...times,
      }
    } catch {
      sample = { status: 'unavailable', reason: 'malformed_output' }
    }
  }
  const reason = sample?.status === 'unavailable'
    ? (['timeout', 'malformed_output'].includes(sample.reason) ? sample.reason : 'collector_error')
    : 'malformed_output'
  return {
    status: 'unavailable',
    reason,
    ...times,
    sampled_at_ms: null,
    cores,
    ...scope,
    total_cpu_pct: null,
    total_rss_mb: null,
    total_pid_count: null,
    group_pid_counts: Object.fromEntries(Object.keys(groups).map((name) => [name, null])),
    processes: Object.fromEntries(Object.keys(groups).map((name) => [
      name, { cpu_pct: null, rss_mb: null },
    ])),
    // Null preserves unknown running status in legacy consumers using Boolean(running).
    kronos: null,
  }
}
