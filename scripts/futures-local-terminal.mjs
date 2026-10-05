import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

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
  await new Promise((resolveStop) => {
    process.once('SIGINT', resolveStop)
    process.once('SIGTERM', resolveStop)
  })
} finally {
  await vite.close()
  if (terminal) await terminal.close()
}

function parseArguments(values) {
  const parsed = {}
  for (let index = 0; index < values.length; index += 1) {
    const flag = values[index]
    if (flag === '--help') {
      process.stdout.write(
        'Usage: node scripts/futures-local-terminal.mjs [--api-port 8787] [--ui-port 5174] [--output-dir new-path]\n',
      )
      process.exit(0)
    }
    const value = values[++index]
    if (!value || !['--api-port', '--ui-port', '--output-dir'].includes(flag))
      throw new Error(
        'Usage: node scripts/futures-local-terminal.mjs [--api-port 8787] [--ui-port 5174] [--output-dir new-path]',
      )
    if (flag === '--api-port') parsed.apiPort = Number(value)
    else if (flag === '--ui-port') parsed.uiPort = Number(value)
    else parsed.outputDirectory = resolve(value)
  }
  return parsed
}
