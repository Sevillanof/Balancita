import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'
import { serverNodeArgs } from './dev-provider-env.mjs'

export function serverLauncherArgs(mode, allowedFlags) {
  if (mode !== 'dev' && mode !== 'start')
    throw new Error(`Unsupported server mode: ${mode}`)

  return serverNodeArgs(
    [
      '--env-file-if-exists=.env',
      '--experimental-strip-types',
      ...(mode === 'dev' ? ['--watch'] : []),
      'src/app/index.ts',
    ],
    allowedFlags,
  )
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const mode = process.argv[2]
  const serverRoot = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../server',
  )
  const child = spawn(process.execPath, serverLauncherArgs(mode), {
    cwd: serverRoot,
    stdio: 'inherit',
  })

  let receivedSignal
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      receivedSignal = signal
      child.kill(signal)
    })
  }

  child.once('error', (error) => {
    process.stderr.write(`[server] failed to start: ${error.message}\n`)
    process.exitCode = 1
  })

  child.once('exit', (code, signal) => {
    process.exitCode = receivedSignal
      ? 128 + (receivedSignal === 'SIGINT' ? 2 : 15)
      : (code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1))
  })
}
