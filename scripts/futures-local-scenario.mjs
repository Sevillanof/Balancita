import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fixturePath = resolve(
  root,
  'server/src/features/paper-futures/fixtures/local-protection.v1.json',
)
let inputPath = fixturePath
let outputDirectory
for (let index = 2; index < process.argv.length; index += 1) {
  const flag = process.argv[index]
  const value = process.argv[++index]
  if (!value || !['--input', '--output-dir'].includes(flag))
    throw new Error(
      'Usage: node scripts/futures-local-scenario.mjs [--input path] [--output-dir new-path]',
    )
  if (flag === '--input') inputPath = resolve(value)
  else outputDirectory = resolve(value)
}

const server = await createServer({
  configFile: false,
  root,
  logLevel: 'silent',
  appType: 'custom',
  server: { middlewareMode: true },
})
try {
  const fixtureBytes = await readFile(inputPath)
  const fixture = JSON.parse(fixtureBytes.toString('utf8'))
  const { runLocalFuturesScenario } = await server.ssrLoadModule(
    '/server/src/features/paper-futures/futures-local-scenario.ts',
  )
  const report = await runLocalFuturesScenario(fixture, {
    outputDirectory,
    inputSha256: createHash('sha256').update(fixtureBytes).digest('hex'),
  })
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
} finally {
  await server.close()
}
