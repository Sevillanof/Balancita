import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  devEnvironment,
  serverEnvironment,
  serverNodeArgs,
} from './dev-provider-env.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const children = [
  {
    name: 'vite',
    cwd: root,
    args: [resolve(root, 'node_modules/vite/bin/vite.js')],
  },
  {
    name: 'server',
    cwd: resolve(root, 'server'),
    args: serverNodeArgs([
      '--env-file-if-exists=.env',
      '--experimental-strip-types',
      '--watch',
      'src/app/index.ts',
    ]),
  },
].map(({ name, cwd, args }) => {
  const child = spawn(process.execPath, args, {
    cwd,
    stdio: ['inherit', 'pipe', 'pipe'],
    env:
      name === 'vite'
        ? devEnvironment(process.env)
        : serverEnvironment(process.env),
  })
  for (const stream of ['stdout', 'stderr']) {
    child[stream].on('data', (chunk) => {
      for (const line of chunk.toString().split(/(?<=\n)/))
        if (line) process[stream].write(`[${name}] ${line}`)
    })
  }
  return { name, child }
})

let shuttingDown = false
function shutdown(signal, code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  process.stdout.write(`[dev] ${signal}: stopping Vite and server\n`)
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
    shutdown('SIGTERM', 1)
  })
  child.on('exit', (code, signal) => {
    if (!shuttingDown) shutdown(signal ?? 'SIGTERM', code ?? 1)
  })
}
