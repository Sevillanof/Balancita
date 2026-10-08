import { execFile } from 'node:child_process'
import { cpus } from 'node:os'

/**
 * Parses `ps -Ao pid=,pgid=,pcpu=,rss=,command=` into rows. `rss` is in KiB.
 */
export function parsePs(text) {
  const rows = []
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+([\d.,]+)\s+(\d+)\s+(.*)$/.exec(line)
    if (!match) continue
    rows.push({
      pid: Number(match[1]),
      pgid: Number(match[2]),
      cpu: Number(match[3].replace(',', '.')),
      rssKb: Number(match[4]),
      command: match[5],
    })
  }
  return rows
}

const round1 = (value) => Math.round(value * 10) / 10

/**
 * CPU (percent of one core, like Activity Monitor) and memory per dev child
 * (its whole process group) plus the Kronos forward run, which lives outside
 * `pnpm dev` and is found by its command line.
 */
export function summarizeResources({
  rows,
  groups,
  kronosPattern = /kronos_lab/,
  now = Date.now(),
  cores = cpus().length,
}) {
  const processes = {}
  let totalCpu = 0
  let totalKb = 0
  for (const [name, pgid] of Object.entries(groups)) {
    const own = rows.filter((row) => row.pgid === pgid)
    const cpu = own.reduce((sum, row) => sum + row.cpu, 0)
    const kb = own.reduce((sum, row) => sum + row.rssKb, 0)
    processes[name] = { cpu_pct: round1(cpu), rss_mb: round1(kb / 1024) }
    totalCpu += cpu
    totalKb += kb
  }
  const kronos = rows.filter((row) => kronosPattern.test(row.command))
  const kronosCpu = kronos.reduce((sum, row) => sum + row.cpu, 0)
  const kronosKb = kronos.reduce((sum, row) => sum + row.rssKb, 0)
  return {
    sampled_at_ms: now,
    cores,
    total_cpu_pct: round1(totalCpu + kronosCpu),
    total_rss_mb: round1((totalKb + kronosKb) / 1024),
    processes,
    kronos: {
      running: kronos.length > 0,
      cpu_pct: round1(kronosCpu),
      rss_mb: round1(kronosKb / 1024),
    },
  }
}

/** One `ps` call; resolves to `[]` where `ps` fails or does not exist. */
export function readPs() {
  return new Promise((resolve) => {
    execFile(
      'ps',
      ['-Ao', 'pid=,pgid=,pcpu=,rss=,command='],
      { maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => resolve(error ? [] : parsePs(stdout)),
    )
  })
}
