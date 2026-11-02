import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import {
  backupStamp,
  copyDatabase,
  quickCheck,
  settleCopy,
} from '../../platform/sqlite-safety.ts'

// Usage: pnpm db:snapshot <file.sqlite> [--out <dest.sqlite>]
// A consistent copy of a database through SQLite's backup API, safe while the
// capture runs. Inspect, query or repair the COPY, never the live file.
const args = process.argv.slice(2)
const out = args.indexOf('--out')
// pnpm runs this from server/: relative paths are the ones typed where pnpm was called.
const here = process.env.INIT_CWD ?? process.cwd()
const typed = args.find((a, i) => !a.startsWith('--') && i !== out + 1)
const source = typed ? resolve(here, typed) : undefined
if (!source) {
  console.error('Uso: pnpm db:snapshot <archivo.sqlite> [--out <copia.sqlite>]')
  process.exit(2)
}
if (!existsSync(source)) {
  console.error(`No existe: ${source}`)
  process.exit(2)
}
const name = basename(source).replace(/\.sqlite$/, '')
const dest =
  (out >= 0 && args[out + 1]
    ? resolve(here, args[out + 1] as string)
    : undefined) ??
  join(
    basename(dirname(source)) === 'dev-live'
      ? join(dirname(dirname(source)), 'snapshots')
      : join(dirname(source), 'snapshots'),
    `${name}-${backupStamp(Date.now())}.sqlite`,
  )
if (existsSync(dest)) {
  console.error(`El destino ya existe: ${dest}`)
  process.exit(2)
}
mkdirSync(dirname(dest), { recursive: true })
await copyDatabase(source, dest)
try {
  settleCopy(dest)
} catch {
  // A damaged source gives a damaged copy; the check below says so.
}
const check = quickCheck(dest)
for (const suffix of ['-wal', '-shm'])
  rmSync(`${dest}${suffix}`, { force: true })
console.log(
  `[db:snapshot] ${source} -> ${dest}\n[db:snapshot] chequeo de la copia: ${check.ok ? 'correcto' : `FALLA (${check.detail})`}`,
)
if (!check.ok)
  console.log(
    '[db:snapshot] La base de origen está dañada: reconstruí con `pnpm db:rebuild <copia>` o restaurá server/data/backups.',
  )
process.exit(check.ok ? 0 : 1)
