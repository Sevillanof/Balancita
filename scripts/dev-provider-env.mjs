import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { createServer } from 'node:net'
import { delimiter, join } from 'node:path'
import { parseEnv } from 'node:util'

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
 * Finds the Python for the verdict (C), paper (D) and scores (E) services, once, before
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

export const DEFAULT_LLAMA_PORT = 8088

/** Port of the optional `llama-server` child (`LLAMA_PORT`, default 8088). */
export function llamaPort(env) {
  const port = Number(env.LLAMA_PORT)
  return Number.isInteger(port) && port > 0 && port < 65536
    ? port
    : DEFAULT_LLAMA_PORT
}

function readIfPresent(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * Environment for the dev children: `<root>/.env` < `<root>/.env.local` <
 * real `env` (the real environment always wins). Missing or unreadable files
 * are skipped; `read(path)` returns the text or `undefined` and is injectable.
 */
export function loadDevEnv({ root, env, read = readIfPresent }) {
  const merged = {}
  for (const name of ['.env', '.env.local']) {
    const text = read(`${root}/${name}`)
    if (text === undefined) continue
    try {
      Object.assign(merged, parseEnv(text))
    } catch {
      // a malformed file must not block startup
    }
  }
  return { ...merged, ...env }
}

// Families in order of preference: Qwen3.5-4B first, then Qwen3-4B.
const QWEN_MODELS = [/qwen3\.5[-_ ]?4b/i, /qwen3[-_ ]?4b/i]
// Partial downloads never end in `.gguf` (`.part`, `.downloadInProgress`,
// `.crdownload`, `.incomplete`), so requiring the extension excludes them.
const QUANT_PREFERENCE = [/q8_0/i, /q6_k/i]

function defaultModelFs() {
  return {
    readdir: (dir) =>
      readdirSync(dir, { withFileTypes: true }).map((entry) => ({
        name: entry.name,
        // symlinks (Hugging Face snapshots) are resolved by `isFile`
        directory: entry.isDirectory(),
      })),
    isFile: (path) => {
      try {
        const info = statSync(path)
        return info.isFile() && info.size > 0
      } catch {
        return false
      }
    },
  }
}

/** Known directories and how many directory levels below them to look. */
function modelSearchRoots({ env, home, platform }) {
  const hfHome = (env.HF_HOME ?? '').trim() || join(home, '.cache/huggingface')
  const hub = (env.HF_HUB_CACHE ?? '').trim() || join(hfHome, 'hub')
  const llamaCache =
    (env.LLAMA_CACHE ?? '').trim() ||
    (platform === 'darwin'
      ? join(home, 'Library/Caches/llama.cpp')
      : join(home, '.cache/llama.cpp'))
  return [
    { dir: llamaCache, depth: 0 },
    { dir: join(hub, 'models--unsloth--Qwen3.5-4B-GGUF'), depth: 2 },
    // HF hub layout: models--<org>--<repo>/snapshots/<commit>/<file>.gguf
    { dir: join(hub, 'models--Qwen--Qwen3-4B-GGUF'), depth: 2 },
    { dir: join(hub, 'models--unsloth--Qwen3-4B-GGUF'), depth: 2 },
    { dir: join(home, '.lmstudio/models'), depth: 2 },
    { dir: join(home, '.cache/lm-studio/models'), depth: 2 },
    { dir: join(home, 'models'), depth: 2 },
    { dir: join(home, 'Downloads'), depth: 1 },
  ]
}

/**
 * Looks for a local Qwen3.5-4B or Qwen3-4B GGUF in the known cache and download
 * directories (bounded depth, never a full disk walk). Skips `mmproj` files,
 * partial downloads and empty files. Prefers Qwen3.5-4B over Qwen3-4B, then Q8_0, then Q6_K, then any other
 * quant; ties go to the earlier directory. Returns the path or `undefined`;
 * never throws.
 */
export function findQwenModel({
  env = process.env,
  home = homedir(),
  platform = process.platform,
  fs = defaultModelFs(),
} = {}) {
  const candidates = []
  const walk = (dir, depth, order) => {
    let entries
    try {
      entries = fs.readdir(dir)
    } catch {
      return
    }
    for (const { name, directory } of entries) {
      const path = join(dir, name)
      if (directory) {
        if (depth > 0) walk(path, depth - 1, order)
        continue
      }
      if (!/\.gguf$/i.test(name) || /mmproj/i.test(name) || !fs.isFile(path))
        continue
      const family = QWEN_MODELS.findIndex((re) => re.test(name))
      if (family === -1) continue
      const quant = QUANT_PREFERENCE.findIndex((re) => re.test(name))
      candidates.push({
        path,
        family,
        rank: quant === -1 ? QUANT_PREFERENCE.length : quant,
        order,
      })
    }
  }
  modelSearchRoots({ env, home, platform }).forEach(({ dir, depth }, order) =>
    walk(dir, depth, order),
  )
  candidates.sort(
    (a, b) =>
      a.family - b.family ||
      a.rank - b.rank ||
      a.order - b.order ||
      a.path.localeCompare(b.path),
  )
  return candidates[0]?.path
}

/**
 * Model arguments for llama-server and the one `[dev]` line naming the
 * source: `LLAMA_MODEL_PATH` (-m), `LLAMA_HF` (-hf, only when the user sets
 * it), else a discovered local file (-m). With none of them there are no
 * `args` and nothing is ever downloaded: llm and q do not start.
 * `findModel` is injectable and only called when neither variable is set.
 */
export function resolveLlamaModel({ env, findModel = () => undefined }) {
  const modelPath = (env.LLAMA_MODEL_PATH ?? '').trim()
  if (modelPath)
    return {
      args: ['-m', modelPath],
      message: `[dev] llm model: ${modelPath} (LLAMA_MODEL_PATH)`,
    }
  const hf = (env.LLAMA_HF ?? '').trim()
  if (hf)
    return {
      args: ['-hf', hf],
      message: `[dev] llm model: -hf ${hf} (LLAMA_HF, set explicitly; llama-server runs with --offline so it only uses its local cache)`,
    }
  const found = findModel()
  if (found)
    return {
      args: ['-m', found],
      message: `[dev] llm model: found ${found} (pin another with LLAMA_MODEL_PATH in .env.local)`,
    }
  return {
    args: undefined,
    message:
      '[dev] llm model: no local Qwen3.5-4B or Qwen3-4B GGUF found; llm and q will not start (nothing is downloaded). Set LLAMA_MODEL_PATH=/path/to/model.gguf in .env.local.',
  }
}

/**
 * Decides whether the optional `llm` (llama-server) and `q` children start:
 * only when `DECISIONS_ENABLED` is not `0` and the `llama-server` binary runs
 * from PATH. Never throws and never blocks startup: returns `{ command }` or
 * `{ message }` (one line for `[dev]`).
 */
export function resolveLlamaServer({ env, run = defaultRun }) {
  if ((env.DECISIONS_ENABLED ?? '').trim() === '0')
    return {
      message:
        'LLM decisions are off (DECISIONS_ENABLED=0); llm and q will not start.',
    }
  const result = run('llama-server', ['--version'])
  if (result.error)
    return {
      message:
        'llama-server was not found on PATH; llm and q (LLM decisions) will not start. Install llama.cpp (brew install llama.cpp) or set DECISIONS_ENABLED=0 to silence this.',
    }
  return { command: 'llama-server' }
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
  // Env-driven ports (the optional llm child): `[{ name, port, host }]`.
  extra = [],
} = {}) {
  const conflicts = []
  const targets = [
    ...names.map((name) => ({
      name,
      port: DEV_PORTS[name],
      host: DEV_PORT_HOSTS[name] ?? '127.0.0.1',
    })),
    ...extra,
  ]
  for (const { name, port, host } of targets) {
    if (port === undefined) continue
    if (!(await probe(port, host)))
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
 *   DB, sole writer of the latter),
 * - scores: Python forecast scorer E (market + verdicts DBs read-only -> scores
 *   DB, sole writer of the latter),
 * - llm (optional): `llama-server` on loopback, only with a resolved binary,
 * - q (optional): Python LLM decisions Q (market + verdicts DBs read-only ->
 *   decisions DB, sole writer of the latter), started together with llm.
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
  // `{ command }` from `resolveLlamaServer`; absent/`null` leaves llm and q out.
  llm = null,
  // Injectable local-model search (`findQwenModel`); none found by default so
  // the function stays pure.
  findModel = () => undefined,
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
  const scoresDb = liveDb('futures-forecast-scores.sqlite')
  const decisionsDb = liveDb('futures-llm-decisions.sqlite')
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
    ...(python?.command && llm?.command ? llmChildren() : []),
  ]

  function llmChildren() {
    const port = String(llamaPort(env))
    const model = resolveLlamaModel({ env, findModel }).args
    if (!model) return []
    return [
      {
        name: 'llm',
        command: llm.command,
        cwd: root,
        args: [
          ...model,
          // The model runs fully offline: never reach the network.
          '--offline',
          '--host',
          '127.0.0.1',
          '--port',
          port,
          '-c',
          (env.LLAMA_CTX ?? '').trim() || '8192',
          '-np',
          (env.LLAMA_PARALLEL ?? '').trim() || '2',
          '--no-mmproj',
          '--no-webui',
        ],
        env: { ...env },
      },
      {
        name: 'q',
        command: python.command,
        cwd: serverCwd,
        args: [
          ...python.prefixArgs,
          '-m',
          'balancita_engine.futures_llm_decisions',
          '--market-db',
          marketDb,
          '--verdicts-db',
          verdictsDb,
          '--decisions-db',
          decisionsDb,
        ],
        env: {
          ...env,
          LLAMA_PORT: port,
          PYTHONPATH: [`${root}/python`, env.PYTHONPATH]
            .filter(Boolean)
            .join(delimiter),
        },
      },
    ]
  }

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
      {
        name: 'scores',
        command: python.command,
        cwd: serverCwd,
        args: [
          ...python.prefixArgs,
          '-m',
          'balancita_engine.futures_forecast_scores',
          '--market-db',
          marketDb,
          '--verdicts-db',
          verdictsDb,
          '--scores-db',
          scoresDb,
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
