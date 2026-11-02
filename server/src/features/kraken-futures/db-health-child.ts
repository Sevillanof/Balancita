import { backupDatabase, quickCheck } from '../../platform/sqlite-safety.ts'

// Slow health checks run here, in their own process, read-only on the live
// database: `node db-health-child.ts '{"kind":"integrity","dbPath":"..."}'`.
// Prints one JSON line: { ok, detail, sourceFailed?, file? }.
type Task =
  | { kind: 'integrity'; dbPath: string }
  | {
      kind: 'backup'
      name: string
      dbPath: string
      dir: string
      keep: number
    }

async function run(task: Task): Promise<Record<string, unknown>> {
  if (task.kind === 'integrity') return { ...quickCheck(task.dbPath) }
  return { ...(await backupDatabase(task)) }
}

try {
  console.log(
    JSON.stringify(await run(JSON.parse(process.argv[2] ?? '{}') as Task)),
  )
} catch (error) {
  console.log(
    JSON.stringify({ ok: false, detail: String(error).slice(0, 400) }),
  )
}
