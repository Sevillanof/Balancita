import { spawnSync } from 'node:child_process'
import {
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

// Stale-instance sweep for `pnpm run dev`: before anything is spawned, find
// what still holds a dev port or a writer lock. A process that belongs to this
// checkout (command line or cwd under `root`) is a leftover of an earlier
// `pnpm run dev` and is stopped; anything else is reported and left alone.

function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 3000,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  return result.status === 0 ? result.stdout : ''
}

export const systemProbe = {
  /** Pids listening on a TCP port (any address). */
  listeners(port) {
    return run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'])
      .split('\n')
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0)
  },
  /** `{ pgid, command, cwd }` of a pid, or undefined when it is gone. */
  info(pid) {
    const ps = run('ps', ['-o', 'pgid=,command=', '-p', String(pid)]).trim()
    if (!ps) return undefined
    const [, pgid, command] = /^(\d+)\s+(.*)$/s.exec(ps) ?? []
    const cwd = run('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'])
      .split('\n')
      .find((line) => line.startsWith('n'))
      ?.slice(1)
    return { pgid: Number(pgid), command: command ?? '', cwd }
  },
  alive(pid) {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return error.code === 'EPERM'
    }
  },
  signal(pid, signal, group) {
    try {
      process.kill(group ? -pid : pid, signal)
    } catch {
      // already gone
    }
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

export function isOurs(info, root) {
  return (
    info !== undefined &&
    (info.command.includes(root) ||
      (info.cwd !== undefined &&
        (info.cwd === root || info.cwd.startsWith(`${root}/`))))
  )
}

function shortCommand(info) {
  const text = info.command.replaceAll(/\s+/g, ' ')
  return text.length > 90 ? `${text.slice(0, 87)}...` : text
}

/** SIGTERM (whole group when it leads one), then SIGKILL after `graceMs`. */
async function stop(pid, info, probe, graceMs) {
  const group = info.pgid === pid
  probe.signal(pid, 'SIGTERM', group)
  const deadline = Date.now() + graceMs
  while (Date.now() < deadline && probe.alive(pid)) await probe.sleep(100)
  if (probe.alive(pid)) probe.signal(pid, 'SIGKILL', group)
  const hard = Date.now() + 2000
  while (Date.now() < hard && probe.alive(pid)) await probe.sleep(50)
  return !probe.alive(pid)
}

function readPid(path, read = readFileSync) {
  try {
    const text = read(path, 'utf8').trim()
    const parsed = text.startsWith('{') ? JSON.parse(text).pid : Number(text)
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * Frees dev ports and writer locks held by leftovers of this checkout.
 * `ports`: `[{ name, port }]`. Returns `{ stopped, blockers }`: one line per
 * stopped process and one per foreign holder that must be freed by hand.
 */
export async function sweepStale({
  root,
  ports,
  liveDir,
  selfPid = process.pid,
  probe = systemProbe,
  graceMs = 4000,
  listDir = (dir) => readdirSync(dir),
  readFile = readFileSync,
}) {
  const stopped = []
  const blockers = []
  const seen = new Set([selfPid])
  const handle = async (pid, what) => {
    if (seen.has(pid)) return
    seen.add(pid)
    const info = probe.info(pid)
    if (info === undefined) return
    if (!isOurs(info, root)) {
      blockers.push(
        `${what} is held by pid ${pid}, which is not part of this checkout (${shortCommand(info)}). Stop it yourself (kill ${pid}) and run pnpm dev again.`,
      )
      return
    }
    if (await stop(pid, info, probe, graceMs))
      stopped.push(`stopped leftover pid ${pid} that held ${what}`)
    else blockers.push(`${what}: pid ${pid} did not stop; try kill -9 ${pid}.`)
  }
  // The old orchestrator first, or it would respawn the children we stop.
  const orchestrator = readPid(join(liveDir, 'dev.pid'), readFile)
  if (orchestrator !== undefined && probe.alive(orchestrator)) {
    const info = probe.info(orchestrator)
    if (info !== undefined && /dev\.mjs/.test(info.command))
      await handle(orchestrator, 'a previous pnpm dev')
  }
  let locks = []
  try {
    locks = listDir(liveDir).filter((file) => file.endsWith('.writer.lock'))
  } catch {
    // no live dir yet: nothing is locked
  }
  for (const file of locks) {
    const pid = readPid(join(liveDir, file), readFile)
    if (pid !== undefined && probe.alive(pid))
      await handle(pid, `the database lock ${file.replace('.writer.lock', '')}`)
  }
  for (const { name, port } of ports)
    for (const pid of probe.listeners(port))
      await handle(pid, `port ${port} (${name})`)
  return { stopped, blockers }
}

export function writeDevPid(liveDir, pid = process.pid) {
  try {
    writeFileSync(join(liveDir, 'dev.pid'), String(pid))
  } catch {
    // informational only
  }
}

export function removeDevPid(liveDir) {
  try {
    rmSync(join(liveDir, 'dev.pid'), { force: true })
  } catch {
    // informational only
  }
}

// A derived DB refused by its Python/Node service because the config changed
// ("... DB was written with a different config; use a new DB"). The file is
// renamed (never deleted) so the service can start a fresh one.
const MISMATCHED_DB = [
  [/verdicts DB was written with a different config/, 'futures-verdicts'],
  [
    /forecast scores DB was written with a different config/,
    'futures-forecast-scores',
  ],
  [/account DB was written with a different config/, 'futures-paper-account'],
  [
    /LLM decisions DB was written with a different config/,
    'futures-llm-decisions',
  ],
  [/news DB was written with a different config/, 'futures-news'],
]

/** Base file name (no extension) of the DB a log text says was refused. */
export function mismatchedDb(text) {
  return MISMATCHED_DB.find(([re]) => re.test(text))?.[1]
}

/**
 * Renames `<base>.sqlite` (+ -wal/-shm) to `<base>.sqlite.old-<stamp>`.
 * Returns the backup name, or undefined when there was nothing to rename.
 */
export function rotateDb(liveDir, base, now = new Date(), rename = renameSync) {
  const stamp = now.toISOString().replaceAll(/[-:]/g, '').slice(0, 15)
  let backup
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      rename(
        join(liveDir, `${base}.sqlite${suffix}`),
        join(liveDir, `${base}.sqlite.old-${stamp}${suffix}`),
      )
      if (suffix === '') backup = `${base}.sqlite.old-${stamp}`
    } catch {
      // missing file: nothing to move
    }
  }
  return backup
}
