import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { devChildSpecs } from './dev-provider-env.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// Optional backends: when one fails the others (and the app) keep running.
const optionalChildren = new Set(['mock', 'capture', 'live'])
mkdirSync(resolve(root, 'server/data/dev-live'), { recursive: true })
const children = devChildSpecs({ root, env: process.env }).map(
  ({ name, cwd, args, env }) => {
    const child = spawn(process.execPath, args, {
      cwd,
      stdio: ['inherit', 'pipe', 'pipe'],
      env,
    })
    for (const stream of ['stdout', 'stderr']) {
      child[stream].on('data', (chunk) => {
        for (const line of chunk.toString().split(/(?<=\n)/))
          if (line) process[stream].write(`[${name}] ${line}`)
      })
    }
    return { name, child }
  },
)

let shuttingDown = false
function shutdown(signal, code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  process.stdout.write(`[dev] ${signal}: stopping all dev processes\n`)
  for (const { child } of children)
    if (child.exitCode === null) child.kill(signal)
  const force = setTimeout(() => {
    for (const { child } of children)
      if (child.exitCode === null) child.kill('SIGKILL')
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
for (const { name, child } of children) {
  child.on('error', (error) => {
    process.stderr.write(`[${name}] failed to start: ${error.message}\n`)
    if (!optionalChildren.has(name)) shutdown('SIGTERM', 1)
  })
  child.on('exit', (code, signal) => {
    if (shuttingDown) return
    if (optionalChildren.has(name)) {
      process.stderr.write(
        `[dev] ${name} exited (${signal ?? code}); the other processes keep running. ${name === 'mock' ? 'The MOCK source' : name === 'capture' ? 'Live market capture (new candles)' : 'The Real source'} will be unavailable until you restart pnpm run dev.\n`,
      )
      return
    }
    shutdown(signal ?? 'SIGTERM', code ?? 1)
  })
}
