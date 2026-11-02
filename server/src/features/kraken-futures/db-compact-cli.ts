import { existsSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { backupStamp } from '../../platform/sqlite-safety.ts'
import {
  compactCopy,
  COMPACT_FREE_RATIO,
} from '../../platform/sqlite-compact.ts'

// Uso: pnpm db:compact <copia.sqlite> [--out <compacta.sqlite>]
// Compacta una COPIA (nunca la base viva) con VACUUM INTO a un archivo nuevo y la verifica.
// Para reemplazar la base viva: docs/operacion-base-de-datos.md, «Compactar», con `pnpm dev` PARADO.
const args = process.argv.slice(2)
const out = args.indexOf('--out')
const here = process.env.INIT_CWD ?? process.cwd()
const typed = args.find((a, i) => !a.startsWith('--') && i !== out + 1)
const source = typed ? resolve(here, typed) : undefined
if (!source) {
  console.error('Uso: pnpm db:compact <copia.sqlite> [--out <compacta.sqlite>]')
  process.exit(2)
}
if (!existsSync(source)) {
  console.error(`No existe: ${source}`)
  process.exit(2)
}
if (resolve(source).split('/').includes('dev-live')) {
  console.error(
    'Esa es la base viva (dev-live). Hacé primero una copia con `pnpm db:snapshot` y compactá la copia.',
  )
  process.exit(2)
}
const target =
  out >= 0 && args[out + 1]
    ? resolve(here, args[out + 1] as string)
    : join(
        dirname(source),
        `${basename(source).replace(/\.sqlite$/, '')}.compact-${backupStamp(Date.now())}.sqlite`,
      )
const report = compactCopy(source, target)
const pct = Math.round(report.free.freeRatio * 100)
console.log(
  `[db:compact] ${source}: ${pct} % de espacio libre (${Math.round(report.free.freeBytes / 1024 ** 2)} MiB reutilizables)${report.free.freeRatio >= COMPACT_FREE_RATIO ? ' → conviene compactar' : ' → todavía no hace falta'}`,
)
console.log(
  `[db:compact] ${report.ok ? 'listo' : 'FALLA'}: ${report.detail}${report.ok ? `\n[db:compact] ${target}: ${Math.round(report.sourceBytes / 1024 ** 2)} MiB → ${Math.round(report.targetBytes / 1024 ** 2)} MiB` : ''}`,
)
process.exit(report.ok ? 0 : 1)
