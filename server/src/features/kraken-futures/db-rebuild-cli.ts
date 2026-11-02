import { existsSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { backupStamp } from '../../platform/sqlite-safety.ts'
import {
  describeRebuild,
  rebuildDatabase,
} from '../../platform/sqlite-rebuild.ts'

// Usage: pnpm db:rebuild <copy.sqlite> [--out <new.sqlite>] [--keep-partial]
// Builds a healthy database from a damaged COPY (see `pnpm db:snapshot`),
// table by table; a table that cannot be read is discarded and the rest is kept.
const args = process.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
// pnpm runs this from server/: relative paths are the ones typed where pnpm was called.
const here = process.env.INIT_CWD ?? process.cwd()
const typed = args.find(
  (a, i) => !a.startsWith('--') && args[i - 1] !== '--out',
)
const source = typed ? resolve(here, typed) : undefined
if (!source || !existsSync(source)) {
  console.error(
    'Uso: pnpm db:rebuild <copia.sqlite> [--out <nueva.sqlite>] [--keep-partial]',
  )
  process.exit(2)
}
if (existsSync(`${source}.writer.lock`)) {
  console.error(
    'Esa base tiene un writer activo (.writer.lock): hacé una copia con `pnpm db:snapshot` y reconstruí la copia.',
  )
  process.exit(2)
}
const outArg = flag('--out')
const dest =
  (outArg ? resolve(here, outArg) : undefined) ??
  source.replace(/\.sqlite$/, '') + `.rebuilt-${backupStamp(Date.now())}.sqlite`
const report = rebuildDatabase(source, dest, {
  keepPartial: args.includes('--keep-partial'),
})
writeFileSync(`${dest}.report.json`, `${JSON.stringify(report, null, 2)}\n`)
console.log(describeRebuild(report))
console.log(`[db:rebuild] informe: ${dest}.report.json`)
process.exit(report.integrity.ok ? 0 : 1)
