import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

// Slow health checks run here, in their own process, read-only on the live
// database: `node db-health-child.ts '{"kind":"integrity","dbPath":"..."}'`.
// Prints one JSON line: { ok, detail }.
type Task =
  | { kind: 'integrity'; dbPath: string }
  | { kind: 'backup'; dbPath: string; dir: string; keep: number }

const BACKUP = /^futures-market-\d{8}-\d{6}\.sqlite$/

function quickCheck(path: string): string[] {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    db.exec('PRAGMA busy_timeout=5000')
    return (
      db.prepare('PRAGMA quick_check(10)').all() as { quick_check: string }[]
    ).map((row) => row.quick_check)
  } finally {
    db.close()
  }
}

function run(task: Task): { ok: boolean; detail: string } {
  if (task.kind === 'integrity') {
    const rows = quickCheck(task.dbPath)
    return rows.length === 1 && rows[0] === 'ok'
      ? { ok: true, detail: 'quick_check ok' }
      : { ok: false, detail: `quick_check: ${rows.join(' | ').slice(0, 400)}` }
  }
  mkdirSync(task.dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)
  const out = join(task.dir, `futures-market-${stamp.replace('T', '-')}.sqlite`)
  const db = new DatabaseSync(task.dbPath, { readOnly: true })
  try {
    db.exec('PRAGMA busy_timeout=5000')
    db.exec(`VACUUM INTO '${out.replaceAll("'", "''")}'`)
  } finally {
    db.close()
  }
  const rows = quickCheck(out)
  if (rows.length !== 1 || rows[0] !== 'ok') {
    rmSync(out, { force: true })
    return {
      ok: false,
      detail: `backup failed its own check: ${rows.join(' | ').slice(0, 300)}`,
    }
  }
  const old = readdirSync(task.dir)
    .filter((name) => BACKUP.test(name))
    .sort()
    .slice(0, -Math.max(1, task.keep))
  for (const name of old) rmSync(join(task.dir, name), { force: true })
  return {
    ok: true,
    detail: `backup ${out} (${Math.round(statSync(out).size / 1024 ** 2)} MiB), kept ${Math.max(1, task.keep)}`,
  }
}

try {
  console.log(JSON.stringify(run(JSON.parse(process.argv[2] ?? '{}') as Task)))
} catch (error) {
  console.log(
    JSON.stringify({ ok: false, detail: String(error).slice(0, 400) }),
  )
}
