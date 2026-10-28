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
// Last, every process of the system is looked at: the Python/Node children that
// open no port and leave no lock (forward, carry, qwenlive...) would otherwise
// survive an orchestrator that died without cleaning up and run twice.

function run(command, args, maxBuffer) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 3000,
    stdio: ['ignore', 'pipe', 'ignore'],
    ...(maxBuffer === undefined ? {} : { maxBuffer }),
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
  /**
   * Every process as `{ pid, pgid, elapsedSec, command }` (`elapsedSec` is
   * undefined when ps did not give a readable `etime`). Empty on win32.
   */
  processes(platform = process.platform) {
    if (platform === 'win32') return []
    return run(
      'ps',
      ['-axww', '-o', 'pid=,pgid=,etime=,command='],
      32 * 1024 * 1024,
    )
      .split('\n')
      .flatMap((line) => {
        const [, pid, pgid, etime, command] =
          /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*\S)\s*$/.exec(line) ?? []
        return pid === undefined
          ? []
          : [
              {
                pid: Number(pid),
                pgid: Number(pgid),
                elapsedSec: parseEtime(etime),
                command,
              },
            ]
      })
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

/** Seconds from a `ps` etime (`[[dd-]hh:]mm:ss`), or undefined. */
export function parseEtime(text) {
  const [, days, hours, minutes, seconds] =
    /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(text ?? '') ?? []
  return seconds === undefined
    ? undefined
    : (Number(days ?? 0) * 24 + Number(hours ?? 0)) * 3600 +
        Number(minutes) * 60 +
        Number(seconds)
}

function formatElapsed(sec) {
  if (sec === undefined) return undefined
  if (sec < 60) return `${sec}s`
  const minutes = Math.floor(sec / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24)
    return `${hours}h${minutes % 60 === 0 ? '' : `${minutes % 60}m`}`
  return `${Math.floor(hours / 24)}d${hours % 24 === 0 ? '' : `${hours % 24}h`}`
}

function escapeRegExp(text) {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Ours = the command line names `root` as a whole path (so `/repo` does not
 * match `/repo-old/...`) or the cwd is `root` or under it.
 */
export function isOurs(info, root) {
  if (info === undefined) return false
  const inCommand = new RegExp(
    `(?<![^\\s"'=:])${escapeRegExp(root)}(?=[/\\s"':]|$)`,
  )
  return (
    inCommand.test(info.command) ||
    (info.cwd !== undefined &&
      (info.cwd === root || info.cwd.startsWith(`${root}/`)))
  )
}

// What the dev children look like in `ps`: [dev name, executable, argument].
// The executable is checked on the first word so that an editor or a
// `grep futures_forward` inside the repo is never taken for a child. The
// Python modules come from `devChildSpecs`; the server entrypoints are the
// relative paths it passes to node (cwd `server/`), so the checkout is
// decided afterwards by command line or cwd.
const PYTHON_MODULES = [
  ['q', 'futures_llm_decisions'],
  ['qwenlive', 'futures_qwen_live'],
  ['qwenexit', 'futures_qwen_exit'],
  ['verdict', 'futures_verdicts'],
  ['forward', 'futures_forward'],
  ['carry', 'futures_carry'],
  ['strategies', 'futures_strategy_registry'],
]
const NODE_ENTRYPOINTS = [
  ['capture', 'src/app/capture-main.ts'],
  ['positioning', 'src/features/positioning-collector/collector-main.ts'],
  ['live', 'src/app/gateway-main.ts'],
]

/** Dev name of the child a ps command line is, or undefined. */
export function devChildName(command) {
  const words = command.trim().split(/\s+/)
  const exe = (words[0] ?? '').split('/').pop().toLowerCase()
  const rest = ` ${words.slice(1).join(' ')} `
  if (/^python[\d.]*$/.test(exe)) {
    for (const [name, module] of PYTHON_MODULES)
      if (new RegExp(`\\s-m\\s+balancita_engine\\.${module}\\s`).test(rest))
        return name
    return undefined
  }
  if (exe === 'node' || exe === 'tsx') {
    for (const [name, entry] of NODE_ENTRYPOINTS)
      if (rest.includes(` ${entry} `)) return name
    return /node_modules\/vite\/bin\/vite\.js\s/.test(rest) ? 'vite' : undefined
  }
  if (exe === 'llama-server') return 'llm'
  if (exe === 'taskpolicy' && /\sllama-server\s/.test(rest)) return 'llm'
  return undefined
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
  platform = process.platform,
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
  // Last: dev children that hold no port and no lock (see the header). Only
  // processes of this checkout are touched, and none of them is reported when
  // it blocks nothing: another checkout's forward is not our business.
  if (platform !== 'win32') {
    const all = probe.processes()
    const selfGroup =
      all.find((entry) => entry.pid === selfPid)?.pgid ??
      probe.info(selfPid)?.pgid
    // Group leaders first: stopping a leader takes its group down with it.
    const candidates = all
      .filter((entry) => entry.pid !== selfPid && entry.pgid !== selfGroup)
      .sort((a, b) => Number(b.pid === b.pgid) - Number(a.pid === a.pgid))
    for (const entry of candidates) {
      const name = devChildName(entry.command)
      if (name === undefined || seen.has(entry.pid)) continue
      if (!probe.alive(entry.pid)) continue
      // The Python/Node children run from `server/` with relative paths: the
      // command line often lacks `root`, so the cwd decides.
      const info = isOurs(entry, root)
        ? entry
        : (() => {
            const found = probe.info(entry.pid)
            return isOurs(found, root) ? { ...entry, ...found } : undefined
          })()
      if (info === undefined) continue
      seen.add(entry.pid)
      const elapsed = formatElapsed(entry.elapsedSec)
      const label = elapsed === undefined ? name : `${name}, running ${elapsed}`
      if (await stop(entry.pid, info, probe, graceMs))
        stopped.push(
          `stopped leftover pid ${entry.pid} (${label}) from an earlier pnpm dev`,
        )
      else
        blockers.push(
          `leftover ${name}: pid ${entry.pid} did not stop; try kill -9 ${entry.pid}.`,
        )
    }
  }
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
  [/account DB was written with a different config/, 'futures-paper-account'],
  [
    /LLM decisions DB was written with a different config/,
    'futures-llm-decisions',
  ],
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
