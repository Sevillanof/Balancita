import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const usage =
  'Usage: node scripts/futures-local-terminal.mjs [--api-port 8787] [--ui-port 5174] [--output-dir new-path] [--interrupt-after-stage partial-fill|1-4] | --resume --output-dir existing-path [--interrupt-after-stage ...]'

process.on('uncaughtException', (error) => {
  // Expected resume refusals print one line; unexpected errors keep their stack.
  const refusal =
    error instanceof Error &&
    (error.message.startsWith('Refusing to resume') ||
      error.message.startsWith('--resume requires'))
  process.stderr.write(
    `${refusal ? error.message : error instanceof Error ? error.stack : error}\n`,
  )
  process.exit(1)
})

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = parseArguments(process.argv.slice(2))
const apiPort = args.apiPort ?? 8787
const uiPort = args.uiPort ?? 5174
if (apiPort < 1024 || apiPort > 65_535 || uiPort < 1024 || uiPort > 65_535)
  throw new Error('Ports must be between 1024 and 65535.')
if (apiPort === uiPort) throw new Error('API and UI ports must be different.')

const vite = await createServer({
  root,
  server: {
    host: '127.0.0.1',
    port: uiPort,
    strictPort: true,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${apiPort}`,
        ws: true,
      },
    },
  },
})
let terminal
try {
  const { startLocalFuturesTerminal } = await vite.ssrLoadModule(
    '/server/src/features/paper-futures/futures-local-terminal.ts',
  )
  terminal = await startLocalFuturesTerminal({
    port: apiPort,
    outputDirectory: args.outputDirectory,
    resume: args.resume === true,
    interruptAfterStage: args.interruptAfterStage,
    uiOrigin: `http://127.0.0.1:${uiPort}`,
    onLog: (line) => process.stdout.write(`${line}\n`),
  })
  await vite.listen()
  process.stdout.write(`Terminal http://127.0.0.1:${uiPort}/terminal\n`)
  process.stdout.write(
    `API http://127.0.0.1:${apiPort} · output ${terminal.outputDirectory}\n`,
  )
  process.stdout.write(
    'MOCK · mercado simulado · zero funding in fixture; no public/private market connection or real orders. Press Ctrl-C to stop.\n',
  )
  const interruption = await Promise.race([
    new Promise((resolveStop) => {
      process.once('SIGINT', () => resolveStop(undefined))
      process.once('SIGTERM', () => resolveStop(undefined))
    }),
    terminal.interrupted,
  ])
  if (interruption) {
    // Let the stream deliver the visible interruption status before exiting.
    await new Promise((resolveLinger) => setTimeout(resolveLinger, 1_000))
    process.stdout.write(
      `INTERRUPTED after ${interruption.stage}; state kept in ${terminal.outputDirectory}. Resume: node scripts/futures-local-terminal.mjs --resume --output-dir ${terminal.outputDirectory}\n`,
    )
    process.exitCode = 75
  }
} finally {
  await vite.close()
  if (terminal) await terminal.close()
  // An open browser stream socket can keep the event loop alive after close.
  if (process.exitCode === 75) process.exit(75)
}

function parseArguments(values) {
  const parsed = {}
  for (let index = 0; index < values.length; index += 1) {
    const flag = values[index]
    if (flag === '--help') {
      process.stdout.write(`${usage}\n`)
      process.exit(0)
    }
    if (flag === '--resume') {
      parsed.resume = true
      continue
    }
    const value = values[++index]
    if (
      !value ||
      ![
        '--api-port',
        '--ui-port',
        '--output-dir',
        '--interrupt-after-stage',
      ].includes(flag)
    )
      throw new Error(usage)
    if (flag === '--api-port') parsed.apiPort = Number(value)
    else if (flag === '--ui-port') parsed.uiPort = Number(value)
    else if (flag === '--interrupt-after-stage')
      parsed.interruptAfterStage = value
    else parsed.outputDirectory = resolve(value)
  }
  if (parsed.resume && !parsed.outputDirectory)
    throw new Error(
      '--resume requires --output-dir <existing output directory>',
    )
  return parsed
}
