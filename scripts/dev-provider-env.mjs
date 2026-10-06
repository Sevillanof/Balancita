import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { delimiter } from 'node:path'

export function devEnvironment(environment) {
  return {
    ...environment,
    VITE_MARKET_DATA_PROVIDER:
      environment.VITE_MARKET_DATA_PROVIDER || 'kraken',
  }
}

export function serverEnvironment(environment) {
  return {
    ...environment,
    BALANCITA_ROOT_DEV_SERVER: 'true',
  }
}

export function serverNodeArgs(
  args,
  allowedFlags = process.allowedNodeEnvironmentFlags,
) {
  return allowedFlags.has('--use-system-ca')
    ? ['--use-system-ca', ...args]
    : args
}

export const MIN_PYTHON = [3, 9]
// The market, verdicts and account tables are STRICT (SQLite 3.37); window
// functions need 3.25.
export const MIN_SQLITE = [3, 37]
const PROBE_CODE =
  'import sys,sqlite3;print(sys.version_info[0],sys.version_info[1],sqlite3.sqlite_version)'

function defaultRun(command, args) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
  })
}

function atLeast(actual, minimum) {
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] !== minimum[index]) return actual[index] > minimum[index]
  }
  return true
}

/** Checks one interpreter; returns its version text or why it does not qualify. */
function probePython({ command, prefixArgs }, run) {
  const result = run(command, [...prefixArgs, '-c', PROBE_CODE])
  if (result.error || result.status !== 0)
    return { reason: 'not found or not runnable' }
  const match = /^(\d+) (\d+) (\d+)\.(\d+)\.(\d+)/.exec(
    String(result.stdout ?? '').trim(),
  )
  if (!match) return { reason: 'does not look like Python' }
  const [python, sqlite] = [
    [Number(match[1]), Number(match[2])],
    [Number(match[3]), Number(match[4])],
  ]
  const version = `Python ${python.join('.')}, SQLite ${match[3]}.${match[4]}.${match[5]}`
  if (!atLeast(python, MIN_PYTHON))
    return { reason: `${version}: Python ${MIN_PYTHON.join('.')}+ required` }
  if (!atLeast(sqlite, MIN_SQLITE))
    return {
      reason: `${version}: SQLite ${MIN_SQLITE.join('.')}+ required (STRICT tables)`,
      sqliteTooOld: true,
    }
  return { version }
}

/**
 * Finds the Python for the verdict (C) and paper (D) services, once, before
 * spawning. `BALANCITA_PYTHON` (a single executable path or name) is honored
 * first and never falls back; otherwise `python3`, `python` and, on Windows,
 * `py -3`. Returns `{ command, prefixArgs, version }` or `{ message, failure }`, where
 * `failure` is `sqlite_too_old` when a Python was found but only its SQLite
 * is too old, else `not_found`.
 */
export function resolvePython({
  env,
  platform = process.platform,
  run = defaultRun,
}) {
  const explicit = (env.BALANCITA_PYTHON ?? '').trim()
  const candidates = explicit
    ? [{ command: explicit, prefixArgs: [] }]
    : [
        { command: 'python3', prefixArgs: [] },
        { command: 'python', prefixArgs: [] },
        ...(platform === 'win32'
          ? [{ command: 'py', prefixArgs: ['-3'] }]
          : []),
      ]
  const tried = []
  let sqliteTooOld = false
  for (const candidate of candidates) {
    const outcome = probePython(candidate, run)
    if (outcome.version) return { ...candidate, version: outcome.version }
    if (outcome.sqliteTooOld) sqliteTooOld = true
    const label = [candidate.command, ...candidate.prefixArgs].join(' ')
    tried.push(`${label} (${outcome.reason})`)
  }
  const target = explicit
    ? `BALANCITA_PYTHON=${explicit}`
    : `tried ${tried.map((entry) => entry.split(' (')[0]).join(', ')}`
  return {
    failure: sqliteTooOld ? 'sqlite_too_old' : 'not_found',
    message: `Python ${MIN_PYTHON.join('.')}+ not found (${target}; ${tried.join('; ')}). The verdict and paper services will not start. Install Python ${MIN_PYTHON.join('.')}+ with SQLite ${MIN_SQLITE.join('.')}+ (python.org or Homebrew on macOS) or set BALANCITA_PYTHON to its executable.`,
  }
}

/** Env value telling the gateway whether C and D can run. */
function pythonStatus(python) {
  if (python?.command) return 'available'
  return python?.unavailable === 'sqlite_too_old'
    ? 'sqlite_too_old'
    : 'unavailable'
}

export const DEV_PORTS = { vite: 5173, server: 8787, mock: 8788, live: 8789 }
// Hosts the children bind to: server, gateway and mock use 127.0.0.1 (HOST
// defaults to it); vite uses its default `localhost`. Vite HMR shares the
// vite port, so there is no separate 24678 listener to check.
const DEV_PORT_HOSTS = { vite: 'localhost' }

/** Default probe: resolves true when `port` can be bound on `host`. */
export function canListen(port, host) {
  return new Promise((resolveProbe) => {
    const probe = createServer()
    probe.once('error', () => resolveProbe(false))
    probe.listen(port, host, () => probe.close(() => resolveProbe(true)))
  })
}

/**
 * Checks every dev port before anything is spawned. `probe(port, host)` is
 * injectable. Returns `{ ok, conflicts: [{ name, port, message }] }`.
 */
export async function checkDevPorts({
  names = Object.keys(DEV_PORTS),
  probe = canListen,
} = {}) {
  const conflicts = []
  for (const name of names) {
    const port = DEV_PORTS[name]
    if (port === undefined) continue
    if (!(await probe(port, DEV_PORT_HOSTS[name] ?? '127.0.0.1')))
      conflicts.push({
        name,
        port,
        message: `[dev] port ${port} (${name}) is already in use, probably by a stale pnpm run dev; the browser would talk to that old process. Free it with: lsof -ti tcp:${port} | xargs kill`,
      })
  }
  return { ok: conflicts.length === 0, conflicts }
}

/**
 * Startup decision: `{ start: false, exitCode: 1, messages }` on any port
 * conflict (nothing is spawned), else `{ start: true }`.
 */
export async function planStartup(options) {
  const { ok, conflicts } = await checkDevPorts(options)
  return ok
    ? { start: true, messages: [] }
    : { start: false, exitCode: 1, messages: conflicts.map((c) => c.message) }
}

/** Message for a child that exited while the stack is running. */
export function describeChildExit({ name, code, signal, sawAddrInUse }) {
  const port = DEV_PORTS[name === 'vite' ? 'vite' : name]
  const base = `[dev] ${name} exited (${signal ?? code})`
  return sawAddrInUse
    ? `${base}: EADDRINUSE${port ? ` on port ${port}` : ''}. Another process holds that port, so the browser may be talking to it instead of this checkout. Free it with: lsof -ti tcp:${port ?? '<port>'} | xargs kill`
    : base
}

/**
 * Signals a child. On POSIX children are spawned `detached` (own process
 * group), so the negative pid reaches grandchildren too (`node --watch`
 * workers, vite's esbuild); win32 keeps plain `child.kill`.
 */
export function signalChild(
  child,
  signal,
  { platform = process.platform, killGroup = process.kill } = {},
) {
  if (platform !== 'win32' && child.pid !== undefined) {
    try {
      killGroup(-child.pid, signal)
      return
    } catch {
      // group already gone: fall through to the direct kill
    }
  }
  try {
    child.kill(signal)
  } catch {
    // already exited
  }
}

// Node's `--env-file-if-exists` tolerates a missing file, but combined with
// `--watch` the watcher then tries to watch the missing path and crashes with
// `ENOENT: no such file or directory, watch '.../server/.env'` (Node 22). The
// flag is therefore added only when the file exists (see `withEnvFile`).
const ENV_FILE_FLAG = '--env-file-if-exists=.env'

const SERVER_ARGS = [
  '--experimental-strip-types',
  '--watch',
  'src/app/index.ts',
]
const GATEWAY_ARGS = [
  '--experimental-strip-types',
  '--watch',
  'src/app/gateway-main.ts',
]
// No --watch: capture is the sole market-DB writer; never restart it on edits.
const CAPTURE_ARGS = ['--experimental-strip-types', 'src/app/capture-main.ts']

/**
 * Pure description of the `pnpm run dev` children:
 * - server: legacy services (FUTURES_MODE forced empty so `.env` cannot change it),
 * - mock: scripted MOCK futures API only,
 * - capture: Kraken public WS -> live market DB (sole writer, no HTTP/engine),
 * - live: read-only gateway on 8789 tailing that DB plus the paper account and
 *   verdicts DBs (no collector, no engine),
 * - verdict: Python verdict service C (market DB read-only -> verdicts DB, sole
 *   writer of the latter; its own `command` instead of node),
 * - paper: Python paper execution D (market + verdicts DBs read-only -> account
 *   DB, sole writer of the latter).
 */
export function devChildSpecs({
  root,
  env,
  allowedFlags = process.allowedNodeEnvironmentFlags,
  // `{ command, prefixArgs }` from `resolvePython`; `null` or
  // `{ unavailable: 'sqlite_too_old' }` when none qualifies (no verdict/paper
  // children; the gateway is told).
  python = { command: 'python3', prefixArgs: [] },
  // Injectable so the function stays pure; `.env` is looked up in `server/`.
  exists = existsSync,
}) {
  const serverCwd = `${root}/server`
  const hasEnvFile = exists(`${serverCwd}/.env`)
  const nodeArgs = (args) => [
    ...(hasEnvFile ? [ENV_FILE_FLAG] : []),
    ...serverNodeArgs(args, allowedFlags),
  ]
  const liveDb = (name) => `./data/dev-live/${name}`
  const common = [
    {
      name: 'vite',
      cwd: root,
      args: [`${root}/node_modules/vite/bin/vite.js`],
      env: devEnvironment(env),
    },
    {
      name: 'server',
      cwd: serverCwd,
      args: nodeArgs(SERVER_ARGS),
      env: {
        ...serverEnvironment(env),
        PORT: String(DEV_PORTS.server),
        FUTURES_MODE: '',
      },
    },
    {
      name: 'mock',
      cwd: root,
      args: [
        `${root}/scripts/futures-local-terminal.mjs`,
        '--api-only',
        '--api-port',
        String(DEV_PORTS.mock),
      ],
      env: { ...env },
    },
  ]
  const marketDb = liveDb('futures-market.sqlite')
  const verdictsDb = liveDb('futures-verdicts.sqlite')
  const accountDb = liveDb('futures-paper-account.sqlite')
  return [
    ...common,
    {
      name: 'capture',
      cwd: serverCwd,
      args: nodeArgs(CAPTURE_ARGS),
      env: {
        ...serverEnvironment(env),
        FUTURES_MODE: '',
        FUTURES_MARKET_DB_PATH: marketDb,
      },
    },
    {
      name: 'live',
      cwd: serverCwd,
      args: nodeArgs(GATEWAY_ARGS),
      env: {
        ...serverEnvironment(env),
        PORT: String(DEV_PORTS.live),
        FUTURES_MODE: '',
        FUTURES_MARKET_DB_PATH: marketDb,
        // Read-only views of C's verdicts and D's account for the terminal.
        FUTURES_VERDICTS_DB_PATH: verdictsDb,
        FUTURES_PAPER_ACCOUNT_DB_PATH: accountDb,
        BALANCITA_PYTHON_STATUS: pythonStatus(python),
      },
    },
    ...(python?.command ? pythonChildren() : []),
  ]

  function pythonChildren() {
    return [
      {
        name: 'verdict',
        command: python.command,
        cwd: serverCwd,
        args: [
          ...python.prefixArgs,
          '-m',
          'balancita_engine.futures_verdicts',
          '--market-db',
          marketDb,
          '--verdicts-db',
          verdictsDb,
        ],
        env: {
          ...env,
          PYTHONPATH: [`${root}/python`, env.PYTHONPATH]
            .filter(Boolean)
            .join(delimiter),
        },
      },
      {
        name: 'paper',
        command: python.command,
        cwd: serverCwd,
        args: [
          ...python.prefixArgs,
          '-m',
          'balancita_engine.futures_paper_execution',
          '--market-db',
          marketDb,
          '--verdicts-db',
          verdictsDb,
          '--account-db',
          accountDb,
        ],
        env: {
          ...env,
          PYTHONPATH: [`${root}/python`, env.PYTHONPATH]
            .filter(Boolean)
            .join(delimiter),
        },
      },
    ]
  }
}

// Futures backends accept only loopback origins on the terminal stream; the
// browser origin (localhost or 127.0.0.1 with the Vite port) is normalised so
// both hostnames work through the dev proxy.
const devBackendOrigin = 'http://localhost'

function prefixedBackend(prefix, port) {
  return {
    target: `http://127.0.0.1:${port}`,
    ws: true,
    rewrite: (path) => path.replace(new RegExp(`^${prefix}`), '/api'),
    configure: (proxy) => {
      proxy.on('proxyReqWs', (proxyRequest) =>
        proxyRequest.setHeader('origin', devBackendOrigin),
      )
    },
  }
}

/** Vite dev proxy. Longer prefixes first: Vite uses the first matching key. */
export function devProxyConfig() {
  return {
    '/api-mock': prefixedBackend('/api-mock', DEV_PORTS.mock),
    '/api-live': prefixedBackend('/api-live', DEV_PORTS.live),
    '/api': { target: `http://127.0.0.1:${DEV_PORTS.server}`, ws: true },
  }
}
