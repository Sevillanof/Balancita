import { createHash } from 'node:crypto'
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { compactCopy, freeSpace } from '../../platform/sqlite-compact.ts'
import { createRetentionRunner } from '../kraken-futures/retention-runner.ts'
import { evaluateArchiveGate } from './archive-gate.ts'
import {
  createArchivePruner,
  makeBackupGuard,
  recentWakeFromState,
  runArchiveCycle,
} from './archive-pruner.ts'
import {
  EXCLUDED_TABLES,
  MIN_FORMAT_VERSION,
  POSITIONING_TABLES,
  type ArchiveTableSpec,
} from './archive-tables.ts'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 11, 20) // 20-dic-2026
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'balancita-archive-'))
  dirs.push(dir)
  return dir
}

// Tabla diaria de prueba (las reales de posicionamiento son mensuales): ventana 14 días.
const daily: ArchiveTableSpec = {
  table: 'evts',
  sqliteTable: 'evts',
  base: 'b',
  timeColumn: 't',
  granularity: 'day',
  retentionMs: 14 * DAY,
  minFormatVersion: MIN_FORMAT_VERSION,
}
const day = (n: number): string =>
  new Date(NOW - n * DAY).toISOString().slice(0, 10)
const dayStart = (n: number): number => Date.parse(`${day(n)}T00:00:00Z`)

interface Fixture {
  archive: string
  db: DatabaseSync
  manifest: Record<string, unknown>[]
}
/** Base con `rows` filas por cada uno de los días `days` (hace N días) y un archivo con manifiesto confirmado para cada uno. */
function fixture(days: number[], rows = 5): Fixture {
  const root = tmp()
  const archive = join(root, 'archivo')
  mkdirSync(join(archive, 'b', 'evts'), { recursive: true })
  const db = new DatabaseSync(join(root, 'live.sqlite'))
  db.exec(
    'CREATE TABLE evts(id INTEGER PRIMARY KEY, t INTEGER NOT NULL, v TEXT)',
  )
  const manifest: Record<string, unknown>[] = []
  for (const n of days) {
    for (let i = 0; i < rows; i += 1)
      db.prepare('INSERT INTO evts(t, v) VALUES(?, ?)').run(
        dayStart(n) + i,
        'x',
      )
    const bytes = Buffer.from(`parquet-${n}`)
    const rel = `b/evts/anio=2026/dia=${day(n)}.parquet`
    mkdirSync(join(archive, 'b', 'evts', 'anio=2026'), { recursive: true })
    writeFileSync(join(archive, rel), bytes)
    manifest.push({
      base: 'b',
      tabla: 'evts',
      dia: day(n),
      ruta: rel,
      filas: rows,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      verificacion_ida_vuelta: true,
      formato_version: MIN_FORMAT_VERSION,
    })
  }
  const f = { archive, db, manifest }
  writeManifest(f)
  return f
}
function writeManifest(f: Fixture): void {
  writeFileSync(
    join(f.archive, 'manifiesto.jsonl'),
    f.manifest.map((e) => JSON.stringify(e)).join('\n') + '\n',
  )
}
const count = (db: DatabaseSync, n: number): number =>
  Number(
    (
      db
        .prepare('SELECT COUNT(*) AS c FROM evts WHERE t>=? AND t<?')
        .get(dayStart(n), dayStart(n) + DAY) as { c: number }
    ).c,
  )
const gate = (f: Fixture, extra: object = {}) =>
  evaluateArchiveGate({
    archiveDir: f.archive,
    specs: [daily],
    now: NOW,
    countRows: (_s, a, b) =>
      Number(
        (
          f.db
            .prepare('SELECT COUNT(*) AS c FROM evts WHERE t>=? AND t<?')
            .get(a, b) as { c: number }
        ).c,
      ),
    ...extra,
  })
const days = (r: Awaited<ReturnType<typeof gate>>): string[] =>
  r.deletable.map((p) => p.day).sort()
const reasons = (r: Awaited<ReturnType<typeof gate>>): string =>
  r.blocked.map((b) => b.reason).join('|')

describe('archive gate', () => {
  it('deletes only confirmed days outside the retention window plus 1 day of margin', async () => {
    const f = fixture([40, 16, 15, 14, 3])
    const r = await gate(f)
    // ventana 14 d + 1 d de margen: el día de hace 15 días termina hace 14 d → todavía no; el de 16 sí.
    expect(days(r)).toEqual([day(40), day(16)].sort())
    expect(reasons(r)).toContain('ventana de retención')
  })

  it('blocks when the manifest is missing, unreadable or has a bad line', async () => {
    const f = fixture([40])
    rmSync(join(f.archive, 'manifiesto.jsonl'))
    expect((await gate(f)).ok).toBe(false)
    appendFileSync(join(f.archive, 'manifiesto.jsonl'), '{no json\n')
    const r = await gate(f)
    expect(r.ok).toBe(false)
    expect(r.deletable).toEqual([])
  })

  it('requires verificacion_ida_vuelta=true and formato_version at least the minimum', async () => {
    const f = fixture([40, 41, 42])
    delete f.manifest[0]!.verificacion_ida_vuelta
    f.manifest[1]!.formato_version = MIN_FORMAT_VERSION - 1
    delete f.manifest[2]!.formato_version
    writeManifest(f)
    const r = await gate(f)
    expect(r.deletable).toEqual([])
    expect(r.blocked).toHaveLength(3)
    // las líneas de las fases 1 y 2 no traen ninguno de los dos campos: no se pueden borrar hasta reexportarse
    f.manifest.forEach((e) => {
      delete e.verificacion_ida_vuelta
      delete e.formato_version
    })
    writeManifest(f)
    expect((await gate(f)).deletable).toEqual([])
  })

  it('blocks a different sha256, a different size and a missing file', async () => {
    const f = fixture([40, 41, 42])
    writeFileSync(join(f.archive, f.manifest[0]!.ruta as string), 'parquet-XX') // mismo largo, otro contenido
    writeFileSync(join(f.archive, f.manifest[1]!.ruta as string), 'corto')
    rmSync(join(f.archive, f.manifest[2]!.ruta as string))
    const r = await gate(f)
    expect(r.deletable).toEqual([])
    expect(reasons(r)).toContain('sha256 distinto')
    expect(reasons(r)).toContain('tamaño distinto')
    expect(reasons(r)).toContain('no existe')
  })

  it('blocks a day when the database has more rows than the archive, allows fewer', async () => {
    const f = fixture([40, 41])
    f.db
      .prepare('INSERT INTO evts(t, v) VALUES(?, ?)')
      .run(dayStart(40) + 100, 'extra')
    f.db
      .prepare('DELETE FROM evts WHERE t>=? AND t<? AND id%2=0')
      .run(dayStart(41), dayStart(41) + DAY)
    const r = await gate(f)
    expect(days(r)).toEqual([day(41)])
    expect(reasons(r)).toContain('más filas')
  })

  it('rejects paths that escape the archive, repeated periods and incomplete lines', async () => {
    const f = fixture([40, 41, 42])
    f.manifest[0]!.ruta = '../fuera.parquet'
    f.manifest.push({ ...f.manifest[1]! })
    delete f.manifest[2]!.sha256
    writeManifest(f)
    const r = await gate(f)
    expect(r.deletable).toEqual([])
  })

  it('in strict mode also needs confirmado_fuera from respaldo-estado.jsonl (last line wins)', async () => {
    const f = fixture([40, 41])
    expect(days(await gate(f, { requireOffsite: true }))).toEqual([])
    const [a, b] = f.manifest.map((e) => e.ruta)
    writeFileSync(
      join(f.archive, 'respaldo-estado.jsonl'),
      [
        { archivo: a, confirmado_fuera: true },
        { archivo: b, confirmado_fuera: true },
        { archivo: b, confirmado_fuera: false },
      ]
        .map((x) => JSON.stringify(x))
        .join('\n') + '\n',
    )
    expect(days(await gate(f, { requireOffsite: true }))).toEqual([day(40)])
    expect(days(await gate(f))).toEqual([day(40), day(41)].sort())
  })

  it('caches hashes by mtime and honours the time cap', async () => {
    const f = fixture([40, 41])
    const cache = new Map<string, string>()
    expect(days(await gate(f, { cache }))).toHaveLength(2)
    expect(cache.size).toBe(2)
    // sin caché y sin tiempo: queda pendiente, no se borra
    let t = 0
    const r = await gate(f, { hashBudgetMs: 0, clock: () => (t += 10) })
    expect(r.deletable).toEqual([])
    expect(reasons(r)).toContain('pendiente')
  })
})

function pruner(
  f: Fixture,
  over: Partial<Parameters<typeof createArchivePruner>[0]> = {},
) {
  const records: Record<string, unknown>[] = []
  const p = createArchivePruner({
    db: f.db,
    archiveDir: f.archive,
    specs: [daily],
    mode: 'delete',
    clock: () => NOW,
    backupOk: () => ({ ok: true, reason: 'ok' }),
    record: (e) => records.push(e),
    ...over,
  })
  return { p, records }
}

describe('archive pruner', () => {
  it('deletes only confirmed days outside the window, in small steps, and logs each step', async () => {
    const f = fixture([40, 3], 7)
    // el día 3 está archivado pero dentro de la ventana
    const { p, records } = pruner(f)
    await p.prepare()
    let steps = 0
    for (;;) {
      const r = p.step(3)
      steps += 1
      if (r.done) break
    }
    expect(steps).toBeGreaterThan(2)
    expect(count(f.db, 40)).toBe(0)
    expect(count(f.db, 3)).toBe(7)
    const deletes = records.filter((r) => r.kind === 'archive-delete')
    expect(deletes.every((r) => r.table === 'evts' && r.day === day(40))).toBe(
      true,
    )
    expect(deletes.reduce((n, r) => n + (r.deleted as number), 0)).toBe(7)
  })

  it('is idempotent and resumes after an interruption', async () => {
    const f = fixture([40], 10)
    const first = pruner(f)
    await first.p.prepare()
    first.p.step(4) // se interrumpe a mitad
    expect(count(f.db, 40)).toBe(6)
    const second = pruner(f) // proceso nuevo: sin memoria
    await second.p.prepare()
    while (!second.p.step(4).done);
    expect(count(f.db, 40)).toBe(0)
    const third = pruner(f)
    await third.p.prepare()
    expect(third.p.step(4)).toEqual({ deleted: 0, done: true })
  })

  it('dry-run reports what it would delete and deletes nothing', async () => {
    const f = fixture([40], 6)
    const { p, records } = pruner(f, { mode: 'dry-run' })
    await p.prepare()
    expect(p.step(100)).toEqual({ deleted: 0, done: true })
    expect(count(f.db, 40)).toBe(6)
    expect(records.find((r) => r.kind === 'archive-dry-run')).toMatchObject({
      day: day(40),
      rows: 6,
    })
  })

  it('does nothing when off', async () => {
    const f = fixture([40])
    const { p } = pruner(f, { mode: 'off' })
    await p.prepare()
    expect(p.step(100)).toEqual({ deleted: 0, done: true })
    expect(count(f.db, 40)).toBe(5)
  })

  it('does not delete without a good recent backup', async () => {
    const f = fixture([40])
    const { p, records } = pruner(f, {
      backupOk: () => ({ ok: false, reason: 'no hay copia diaria' }),
    })
    await p.prepare()
    expect(p.step(100).deleted).toBe(0)
    expect(count(f.db, 40)).toBe(5)
    expect(JSON.stringify(records)).toContain('sin copia previa buena')
  })

  it('does not delete on a doubt (missing manifest, extra rows, hash mismatch)', async () => {
    const f = fixture([40])
    f.db
      .prepare('INSERT INTO evts(t, v) VALUES(?, ?)')
      .run(dayStart(40) + 99, 'extra')
    const { p } = pruner(f)
    await p.prepare()
    expect(p.step(100).deleted).toBe(0)
    rmSync(join(f.archive, 'manifiesto.jsonl'))
    const again = pruner(f)
    await again.p.prepare()
    expect(again.p.step(100).deleted).toBe(0)
    expect(count(f.db, 40)).toBe(6)
  })

  it('never touches a table that has a delete trigger (immutable)', async () => {
    const f = fixture([40])
    f.db.exec(
      "CREATE TRIGGER evts_no_delete BEFORE DELETE ON evts BEGIN SELECT RAISE(ABORT, 'immutable'); END",
    )
    const { p, records } = pruner(f)
    await p.prepare()
    expect(p.step(100).deleted).toBe(0)
    expect(count(f.db, 40)).toBe(5)
    expect(JSON.stringify(records)).toContain('inmutable por trigger')
  })

  it('news are excluded and never in the deletable set', () => {
    expect(EXCLUDED_TABLES.news_items).toMatch(/NO se borran nunca/)
    expect(EXCLUDED_TABLES.news_analysis).toMatch(/NO se borran nunca/)
    const names = POSITIONING_TABLES.map((t) => t.table)
    expect(names.some((n) => n.startsWith('news'))).toBe(false)
    expect(names.sort()).toEqual(['positioning', 'premium'])
  })

  it('runArchiveCycle respects its time budget and canRun', async () => {
    const f = fixture([40], 50)
    const { p } = pruner(f)
    let t = 0
    const r = await runArchiveCycle(p, {
      batch: 1,
      budgetMs: 25,
      now: () => (t += 10),
      yieldLoop: async () => {},
    })
    expect(r.steps).toBeLessThan(5)
    expect(r.done).toBe(false)
    const blocked = await runArchiveCycle(p, { canRun: () => false })
    expect(blocked.steps).toBe(0)
  })
})

describe('retention runner with the archive hook', () => {
  const store = {
    trimRawEvents: () => ({ deleted: 0, slimmed: 0, done: true, batches: 1 }),
  }
  const policy = { tickerRetentionMs: 1, eventRetentionMs: 1, rawKeepMs: 1 }

  it('runs archive steps after the trim is done, inside the same cycle, in bounded steps', async () => {
    const f = fixture([40], 30)
    const { p } = pruner(f)
    const runner = createRetentionRunner({
      store,
      policy,
      archive: p,
      startBatch: 100,
      yieldLoop: async () => {},
    })
    const cycle = await runner.run()
    expect(cycle?.archived).toBe(30)
    expect(cycle?.done).toBe(true)
    expect(count(f.db, 40)).toBe(0)
  })

  it('does not delete when canRun is false (backup in progress, damaged database, wake-up)', async () => {
    const f = fixture([40], 30)
    const { p } = pruner(f)
    const runner = createRetentionRunner({
      store,
      policy,
      archive: p,
      canRun: () => false,
    })
    expect(await runner.run()).toBeUndefined()
    expect(count(f.db, 40)).toBe(30)
  })

  it('without the hook the cycle is unchanged', async () => {
    const runner = createRetentionRunner({
      store,
      policy,
      yieldLoop: async () => {},
    })
    const cycle = await runner.run()
    expect(cycle).toBeDefined()
    expect('archived' in (cycle as object)).toBe(false)
  })
})

describe('backup guard and wake', () => {
  it('needs a recent daily copy and a healthy database', () => {
    const dir = tmp()
    const stamp = (ms: number) =>
      new Date(ms)
        .toISOString()
        .replace(/[-:]/g, '')
        .slice(0, 15)
        .replace('T', '-')
    const guard = (over: object = {}) =>
      makeBackupGuard({
        backupDir: dir,
        name: 'positioning',
        clock: () => NOW,
        ...over,
      })()
    expect(guard().ok).toBe(false) // sin copias
    const header = Buffer.alloc(1024)
    header.write('SQLite format 3\0', 0, 'latin1')
    writeFileSync(
      join(dir, `positioning-${stamp(NOW - 40 * 3_600_000)}.sqlite`),
      header,
    )
    expect(guard().reason).toMatch(/30 h/)
    writeFileSync(
      join(dir, `positioning-${stamp(NOW - 5 * 3_600_000)}.sqlite`),
      header,
    )
    expect(guard().ok).toBe(true)
    const state = join(dir, 'state.json')
    writeFileSync(state, JSON.stringify({ damaged: 'positioning.sqlite' }))
    expect(guard({ statePath: state }).ok).toBe(false)
    writeFileSync(
      state,
      JSON.stringify({ damaged: null, wake: { at: NOW - 60_000 } }),
    )
    expect(guard({ statePath: state }).ok).toBe(true)
    expect(recentWakeFromState(state, NOW)).toBe(true)
    expect(recentWakeFromState(state, NOW + 20 * 60_000)).toBe(false)
  })
})

describe('db compact', () => {
  it('compacts a copy into a new file, verifies it and reports free space', () => {
    const dir = tmp()
    const src = join(dir, 'copy.sqlite')
    const db = new DatabaseSync(src)
    db.exec('CREATE TABLE a(id INTEGER PRIMARY KEY, v TEXT)')
    for (let i = 0; i < 2000; i += 1)
      db.prepare('INSERT INTO a(v) VALUES(?)').run('x'.repeat(200))
    db.exec('DELETE FROM a WHERE id > 200')
    expect(freeSpace(db).freeRatio).toBeGreaterThan(0.3)
    db.close()
    const target = join(dir, 'compact.sqlite')
    const report = compactCopy(src, target)
    expect(report.ok).toBe(true)
    expect(report.targetBytes).toBeLessThan(report.sourceBytes)
    expect(report.counts.a).toBe(200)
    expect(() => compactCopy(src, target)).toThrow(/ya existe/)
  })
})
