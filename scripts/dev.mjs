import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  describeChildExit,
  devChildSpecs,
  planStartup,
  resolvePython,
  signalChild,
} from './dev-provider-env.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// Optional backends: when one fails the others (and the app) keep running.
const optionalChildren = new Set([
  'mock',
  'capture',
  'live',
  'verdict',
  'paper',
])
// Refuse to start on a busy port: a stale dev stack would otherwise keep
// serving the browser while the new child dies with EADDRINUSE.
const plan = await planStartup()
if (!plan.start) {
  for (const message of plan.messages) process.stderr.write(`${message}\n`)
  process.stderr.write('[dev] nothing was started.\n')
  process.exit(plan.exitCode)
}
mkdirSync(resolve(root, 'server/data/dev-live'), { recursive: true })
// Resolve Python once, before spawning: without it the verdict and paper
// services are skipped and the gateway reports the engine as unavailable.
const python = resolvePython({ env: process.env })
if (python.command === undefined)
  process.stderr.write(`[dev] ${python.message}\n`)
else
  process.stdout.write(
    `[dev] Python for verdict/paper: ${[python.command, ...python.prefixArgs].join(' ')} (${python.version})\n`,
  )
const useGroups = process.platform !== 'win32'
const children = devChildSpecs({
  root,
  env: process.env,
  python:
    python.command === undefined ? { unavailable: python.failure } : python,
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
        `[dev] ${name} exited (${signal ?? code}); the other processes keep running. ${name === 'mock' ? 'The MOCK source' : name === 'capture' ? 'Live market capture (new candles)' : name === 'verdict' ? 'The verdict service (new verdicts)' : name === 'paper' ? 'Paper execution (new paper fills)' : 'The Real source'} will be unavailable until you restart pnpm run dev.\n`,
      )
      return
    }
    shutdown(signal ?? 'SIGTERM', code ?? 1)
  })
}
