import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  describeChildExit,
  devChildSpecs,
  findQwenModel,
  llamaPort,
  loadDevEnv,
  planStartup,
  resolveLlamaModel,
  resolveLlamaServer,
  resolvePython,
  signalChild,
} from './dev-provider-env.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// <root>/.env.local and <root>/.env feed the dev children; the real
// environment wins over both.
const env = loadDevEnv({ root, env: process.env })
// Optional backends: when one fails the others (and the app) keep running.
const optionalChildren = new Set([
  'mock',
  'capture',
  'live',
  'verdict',
  'paper',
  'scores',
  'news',
  'llm',
  'q',
])
const exitLabels = {
  mock: 'The MOCK source',
  capture: 'Live market capture (new candles)',
  verdict: 'The verdict service (new verdicts)',
  paper: 'Paper execution (new paper fills)',
  scores: 'The forecast scorer (new forecast scores)',
  news: 'The news process (new news items and analyses)',
  llm: 'The llama-server model (new LLM decisions)',
  q: 'The LLM decision service (new LLM decisions)',
}
// The optional model: never blocks startup, one [dev] line when it is skipped.
const llama = resolveLlamaServer({ env })
const python = resolvePython({ env })
// Resolved once: no local model means no llm and no q (nothing is downloaded).
const llmModel =
  llama.command !== undefined && python.command !== undefined
    ? resolveLlamaModel({ env, findModel: findQwenModel })
    : undefined
const llmEnabled = llmModel?.args !== undefined
if (llama.command === undefined)
  process.stdout.write(`[dev] ${llama.message}\n`)
else if (python.command === undefined)
  process.stdout.write(
    '[dev] llm and q need Python as well, which was not found; they will not start.\n',
  )
// Refuse to start on a busy port: a stale dev stack would otherwise keep
// serving the browser while the new child dies with EADDRINUSE. The llm port
// is only checked when that child will really start.
const plan = await planStartup({
  extra: llmEnabled
    ? [{ name: 'llm', port: llamaPort(env), host: '127.0.0.1' }]
    : [],
})
if (!plan.start) {
  for (const message of plan.messages) process.stderr.write(`${message}\n`)
  process.stderr.write('[dev] nothing was started.\n')
  process.exit(plan.exitCode)
}
mkdirSync(resolve(root, 'server/data/dev-live'), { recursive: true })
// Resolve Python once, before spawning: without it the verdict and paper
// services are skipped and the gateway reports the engine as unavailable.
if (python.command === undefined)
  process.stderr.write(`[dev] ${python.message}\n`)
else
  process.stdout.write(
    `[dev] Python for verdict/paper/scores: ${[python.command, ...python.prefixArgs].join(' ')} (${python.version})\n`,
  )
// One search, one line.
let llmModelPath
if (llmModel) {
  llmModelPath = llmModel.args?.[0] === '-m' ? llmModel.args[1] : undefined
  process.stdout.write(`${llmModel.message}\n`)
}
const useGroups = process.platform !== 'win32'
const children = devChildSpecs({
  root,
  env,
  python:
    python.command === undefined ? { unavailable: python.failure } : python,
  llm: llama,
  findModel: () => llmModelPath,
}).map(({ name, command, cwd, args, env }) => {
  const child = spawn(command ?? process.execPath, args, {
    cwd,
    // POSIX: own process group so shutdown reaches grandchildren (no orphans);
    // stdin is not inherited because a background group reading the tty would
    // be stopped. win32 keeps the previous behavior.
    stdio: [useGroups ? 'ignore' : 'inherit', 'pipe', 'pipe'],
    detached: useGroups,
    env,
  })
  const state = { sawAddrInUse: false }
  for (const stream of ['stdout', 'stderr']) {
    child[stream].on('data', (chunk) => {
      if (chunk.toString().includes('EADDRINUSE')) state.sawAddrInUse = true
      for (const line of chunk.toString().split(/(?<=\n)/))
        if (line) process[stream].write(`[${name}] ${line}`)
    })
  }
  return { name, child, state }
})

let shuttingDown = false
function shutdown(signal, code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  process.stdout.write(`[dev] ${signal}: stopping all dev processes\n`)
  for (const { child } of children)
    if (child.exitCode === null) signalChild(child, signal)
  const force = setTimeout(() => {
    for (const { child } of children)
      if (child.exitCode === null) signalChild(child, 'SIGKILL')
  }, 5000)
  force.unref()
  Promise.all(
    children.map(
      ({ child }) =>
        new Promise((resolveExit) => {
          if (child.exitCode !== null || child.signalCode !== null)
            return resolveExit()
          child.once('exit', resolveExit)
        }),
    ),
  ).then(() => {
    clearTimeout(force)
    process.exitCode = code
  })
}

for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => shutdown(signal))
for (const { name, child, state } of children) {
  child.on('error', (error) => {
    process.stderr.write(`[${name}] failed to start: ${error.message}\n`)
    if (!optionalChildren.has(name)) shutdown('SIGTERM', 1)
  })
  child.on('exit', (code, signal) => {
    if (shuttingDown) return
    if (state.sawAddrInUse)
      process.stderr.write(
        `${describeChildExit({ name, code, signal, sawAddrInUse: true })}\n`,
      )
    if (optionalChildren.has(name)) {
      process.stderr.write(
        `[dev] ${name} exited (${signal ?? code}); the other processes keep running. ${exitLabels[name] ?? 'The Real source'} will be unavailable until you restart pnpm run dev.\n`,
      )
      return
    }
    shutdown(signal ?? 'SIGTERM', code ?? 1)
  })
}
