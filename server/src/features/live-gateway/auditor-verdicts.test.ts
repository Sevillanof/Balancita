import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { readAuditorTrades } from './auditor-verdicts.ts'
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

describe('decision auditor verdicts per operation', () => {
  const ROWS =
    'CREATE TABLE miradas(product TEXT, bucket_ms INTEGER, t_ms INTEGER, accion TEXT, trade_no INTEGER, veredicto_12h_json TEXT, veredicto_24h_json TEXT, veredicto_36h_json TEXT)'
  const v = (acerto: boolean | null, texto: string | null = null) =>
    JSON.stringify({ acerto, costo_error_pb: 0, regla: 'r', texto })

  /** Operation 7 fully judged, 8 judged only at 12 h and still open, 9 never seen. */
  function seedAudit() {
    const { dir, path } = seedLive()
    const db = new DatabaseSync(join(dir, 'auditor.sqlite'))
    db.exec(ROWS)
    const insert = db.prepare('INSERT INTO miradas VALUES(?,?,?,?,?,?,?,?)')
    let bucket = 0
    const add = (
      product: string,
      accion: string,
      tradeNo: number | null,
      v12: string | null,
      v24: string | null,
      v36: string | null,
    ) => {
      bucket += MIN15
      insert.run(
        product,
        bucket,
        bucket + MIN15,
        accion,
        tradeNo,
        v12,
        v24,
        v36,
      )
    }
    add(
      'PF_XBTUSD',
      'ENTRAR',
      7,
      v(true, 'si entraba: +9 pb'),
      v(true),
      v(false, 'si entraba: −12 pb'),
    )
    add('PF_XBTUSD', 'MANTENER', 7, v(true), null, null)
    add('PF_XBTUSD', 'MANTENER', 7, v(false), v(true), null)
    add('PF_XBTUSD', 'MANTENER', 7, null, null, null)
    add('PF_XBTUSD', 'SALIR_vuelta', 7, v(false, 'quedaban +41 pb'), null, null)
    add(
      'PF_XBTUSD',
      'ENTRAR_noticias',
      8,
      v(true, 'si entraba: +5 pb'),
      null,
      null,
    )
    add('PF_XBTUSD', 'MANTENER', 8, null, null, null)
    add('PF_XBTUSD', 'NO_ENTRAR_portero', null, v(true), null, null)
    // The same operation number of another product must not leak in.
    add('PF_ETHUSD', 'ENTRAR', 7, v(true, 'otro'), null, null)
    db.close()
    return path
  }

  it('summarises entry, exit and held looks of each operation with the longest horizon', () => {
    const audits = readAuditorTrades(seedAudit(), 'PF_XBTUSD', [7, 8, 9])!
    expect([...audits.keys()].sort()).toEqual([7, 8])
    expect(audits.get(7)).toMatchObject({
      entrada: { acerto: false, texto: 'si entraba: −12 pb' },
      entrada_horizonte: '36h',
      entrada_accion: 'ENTRAR',
      salida: { acerto: false, texto: 'quedaban +41 pb' },
      salida_horizonte: '12h',
      salida_accion: 'SALIR_vuelta',
      // Judged holds: 24 h (true) over 12 h (false) wins, the unjudged one is left out.
      mantener: { aciertos: 2, total: 2 },
      miradas: 5,
    })
    // Still open: only the 12 h entry verdict, no exit look yet.
    expect(audits.get(8)).toMatchObject({
      entrada: { acerto: true },
      entrada_horizonte: '12h',
      entrada_accion: 'ENTRAR_noticias',
      salida: null,
      salida_horizonte: null,
      salida_accion: null,
      mantener: { aciertos: 0, total: 0 },
      miradas: 2,
    })
  })

  it('reads as no audit without a file, a table or operations, in one query', () => {
    const { path } = seedLive()
    expect(readAuditorTrades(path, 'PF_XBTUSD', [1])).toBeNull()
    expect(readAuditorTrades(undefined, 'PF_XBTUSD', [1])).toBeNull()
    expect(readAuditorTrades(seedAudit(), 'PF_XBTUSD', [])!.size).toBe(0)
  })

  it('attaches the audit to the operations the gateway serves', () => {
    const path = seedAudit()
    const db = new DatabaseSync(path)
    db.exec(`CREATE TABLE trades(product TEXT, trade_no INTEGER, status TEXT, side TEXT, entry_ms INTEGER,
      exit_ms INTEGER, entry_px TEXT, exit_px TEXT, qty TEXT, notional_usd TEXT, leverage TEXT, margin_usd TEXT,
      gross_usd TEXT, fees_usd TEXT, funding_usd TEXT, funding_status TEXT, net_usd TEXT, net_now_usd TEXT,
      closed_by TEXT, exit_reason TEXT, hold_min INTEGER, mark_px REAL, mark_ms INTEGER)`)
    const insert = db.prepare(
      "INSERT INTO trades(product, trade_no, status, side, entry_ms) VALUES('PF_XBTUSD',?,?,'SHORT',?)",
    )
    insert.run(7, 'closed', 1_000)
    insert.run(9, 'open', 2_000)
    db.close()
    const result = createQwenDecisions({ liveDbPath: path }).trades('PF_XBTUSD')
    if (result.status !== 'ok') throw new Error('expected ok')
    const byNo = new Map(result.trades.map((t) => [t.trade_no, t.auditoria]))
    expect(byNo.get(7)).toMatchObject({ entrada_horizonte: '36h', miradas: 5 })
    expect(byNo.get(9)).toBeNull()
  })

  it('serves null auditoria on every operation when the auditor file is damaged', () => {
    const path = seedAudit()
    writeFileSync(join(dirname(path), 'auditor.sqlite'), 'not a database')
    const db = new DatabaseSync(path)
    db.exec(`CREATE TABLE trades(product TEXT, trade_no INTEGER, status TEXT, side TEXT, entry_ms INTEGER,
      exit_ms INTEGER, entry_px TEXT, exit_px TEXT, qty TEXT, notional_usd TEXT, leverage TEXT, margin_usd TEXT,
      gross_usd TEXT, fees_usd TEXT, funding_usd TEXT, funding_status TEXT, net_usd TEXT, net_now_usd TEXT,
      closed_by TEXT, exit_reason TEXT, hold_min INTEGER, mark_px REAL, mark_ms INTEGER)`)
    db.exec(
      "INSERT INTO trades(product, trade_no, status, side, entry_ms) VALUES('PF_XBTUSD',7,'closed','SHORT',1000)",
    )
    db.close()
    const result = createQwenDecisions({ liveDbPath: path }).trades('PF_XBTUSD')
    if (result.status !== 'ok') throw new Error('expected ok')
    expect(result.trades).toHaveLength(1)
    expect(result.trades[0]!.auditoria).toBeNull()
  })
})
