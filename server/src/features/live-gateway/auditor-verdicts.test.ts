import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { createQwenDecisions } from './qwen-decisions.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true })
})

const MIN15 = 900_000
const MIRADAS =
  'CREATE TABLE miradas(product TEXT, bucket_ms INTEGER, accion TEXT, despues_json TEXT, veredicto_12h_json TEXT, veredicto_24h_json TEXT, veredicto_36h_json TEXT)'

/** A live base with three looks of PF_XBTUSD (buckets 0, 15 and 30 min) in a fresh folder. */
function seedLive(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'qwen-auditor-'))
  dirs.push(dir)
  const path = join(dir, 'live.sqlite')
  const db = new DatabaseSync(path)
  db.exec(`CREATE TABLE decisions(
    product TEXT, bucket_ms INTEGER, t_ms INTEGER, decided_at_ms INTEGER, action TEXT,
    confidence REAL, latency_ms INTEGER, prompt_version TEXT, reason TEXT);
    CREATE TABLE skipped(product TEXT, bucket_ms INTEGER, t_ms INTEGER, reason TEXT, detail TEXT)`)
  const insert = db.prepare(
    "INSERT INTO decisions VALUES('PF_XBTUSD',?,?,?,?,0.5,100,'4','sin_ventaja')",
  )
  for (const [bucket, action] of [
    [0, 'ESPERAR'],
    [MIN15, 'LARGO'],
    [2 * MIN15, 'ESPERAR'],
  ] as const)
    insert.run(bucket, bucket + MIN15, bucket + MIN15 + 5_000, action)
  db.close()
  return { dir, path }
}

function reportOf(path: string) {
  const result = createQwenDecisions({ liveDbPath: path }).report('PF_XBTUSD')
  if (result.status !== 'ok') throw new Error('expected ok')
  return result.decisions
}

describe('decision auditor verdicts', () => {
  it('attaches the verdicts of each look and leaves null the ones the auditor has not seen', () => {
    const { dir, path } = seedLive()
    const db = new DatabaseSync(join(dir, 'auditor.sqlite'))
    db.exec(MIRADAS)
    const insert = db.prepare('INSERT INTO miradas VALUES(?,?,?,?,?,?,?)')
    insert.run(
      'PF_XBTUSD',
      0,
      'NO_ENTRAR_portero',
      JSON.stringify({ mov_30m: 4, si_entraba_maestro_pb: 23, mfe_36h: 80 }),
      JSON.stringify({
        acerto: false,
        costo_error_pb: 23,
        regla: 'portero',
        texto: 'si entraba: +23 pb',
      }),
      JSON.stringify({ acerto: null, costo_error_pb: 0, regla: 'fija' }),
      'not json',
    )
    insert.run('PF_XBTUSD', MIN15, 'ENTRAR', null, null, null, null)
    // Another product's verdict at the same bucket must not leak in.
    insert.run('PF_ETHUSD', 2 * MIN15, 'ENTRAR', null, null, null, null)
    db.close()

    // Newest first in the report: buckets 30 (unseen), 15 (open), 0 (resolved).
    const [unseen, open, resolved] = reportOf(path)
    expect(resolved!.auditoria).toMatchObject({
      accion: 'NO_ENTRAR_portero',
      veredicto_12h: {
        acerto: false,
        costo_error_pb: 23,
        regla: 'portero',
        texto: 'si entraba: +23 pb',
      },
      // A fixed rule is not judged: acerto stays null.
      veredicto_24h: { acerto: null, texto: null },
      // A damaged value reads as no verdict.
      veredicto_36h: null,
      despues: { mov_30m: 4, si_entraba_maestro_pb: 23, mov_1h: null },
    })
    expect(open!.auditoria).toEqual({
      accion: 'ENTRAR',
      veredicto_12h: null,
      veredicto_24h: null,
      veredicto_36h: null,
      despues: null,
    })
    expect(unseen!.auditoria).toBeNull()
  })

  it('gives null auditoria without breaking the answer when there is no file', () => {
    const { path } = seedLive()
    const decisions = reportOf(path)
    expect(decisions).toHaveLength(3)
    expect(decisions.every((d) => d.auditoria === null)).toBe(true)
  })

  it('gives null auditoria when the table is missing or the file is damaged', () => {
    const noTable = seedLive()
    const db = new DatabaseSync(join(noTable.dir, 'auditor.sqlite'))
    db.exec('CREATE TABLE otra(x TEXT)')
    db.close()
    expect(reportOf(noTable.path).every((d) => d.auditoria === null)).toBe(true)

    const damaged = seedLive()
    writeFileSync(join(damaged.dir, 'auditor.sqlite'), 'not a database')
    const decisions = reportOf(damaged.path)
    expect(decisions).toHaveLength(3)
    expect(decisions.every((d) => d.auditoria === null)).toBe(true)
  })
})
