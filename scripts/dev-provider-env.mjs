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

export const DEV_PORTS = { vite: 5173, server: 8787, mock: 8788, live: 8789 }

const SERVER_ARGS = [
  '--env-file-if-exists=.env',
  '--experimental-strip-types',
  '--watch',
  'src/app/index.ts',
]
const GATEWAY_ARGS = [
  '--env-file-if-exists=.env',
  '--experimental-strip-types',
  '--watch',
  'src/app/gateway-main.ts',
]
// No --watch: capture is the sole market-DB writer; never restart it on edits.
const CAPTURE_ARGS = [
  '--env-file-if-exists=.env',
  '--experimental-strip-types',
  'src/app/capture-main.ts',
]

/**
 * Pure description of the `pnpm run dev` children:
 * - server: legacy services (FUTURES_MODE forced empty so `.env` cannot change it),
 * - mock: scripted MOCK futures API only,
 * - capture: Kraken public WS -> live market DB (sole writer, no HTTP/engine),
 * - live: read-only gateway on 8789 tailing that DB (no collector, no engine).
 * `DEV_LIVE_SINGLE_PROCESS=1` restores the old single-process paper_live child
 * (collector + engine + HTTP in one process) as a rollback path.
 */
export function devChildSpecs({
  root,
  env,
  allowedFlags = process.allowedNodeEnvironmentFlags,
}) {
  const serverCwd = `${root}/server`
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
      args: serverNodeArgs(SERVER_ARGS, allowedFlags),
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
  if (env.DEV_LIVE_SINGLE_PROCESS === '1')
    return [
      ...common,
      {
        name: 'live',
        cwd: serverCwd,
        args: serverNodeArgs(SERVER_ARGS, allowedFlags),
        env: {
          ...serverEnvironment(env),
          PORT: String(DEV_PORTS.live),
          FUTURES_MODE: 'paper_live',
          FUTURES_DB_PATH: liveDb('futures-paper.sqlite'),
          FUTURES_MARKET_DB_PATH: liveDb('futures-market.sqlite'),
          MARKET_DB_PATH: liveDb('market.sqlite'),
          SIMULATIONS_REPORT_PATH: liveDb('simulations-report.json'),
        },
      },
    ]
  const marketDb = liveDb('futures-market.sqlite')
  return [
    ...common,
    {
      name: 'capture',
      cwd: serverCwd,
      args: serverNodeArgs(CAPTURE_ARGS, allowedFlags),
      env: {
        ...serverEnvironment(env),
        FUTURES_MODE: '',
        FUTURES_MARKET_DB_PATH: marketDb,
      },
    },
    {
      name: 'live',
      cwd: serverCwd,
      args: serverNodeArgs(GATEWAY_ARGS, allowedFlags),
      env: {
        ...serverEnvironment(env),
        PORT: String(DEV_PORTS.live),
        FUTURES_MODE: '',
        FUTURES_MARKET_DB_PATH: marketDb,
      },
    },
  ]
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
