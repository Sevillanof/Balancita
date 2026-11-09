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
      // An auditor file written before the direction existed has no such column: null, not «no auditor».
      direccion: null,
      // ...and one written before the training record has no `propuestas` table: no proposal.
      propuesta: null,
    })
    expect(unseen!.auditoria).toBeNull()
  })

  it('attaches the direction at 4, 12 and 24 h of each look when the auditor wrote it', () => {
    const { dir, path } = seedLive()
    const db = new DatabaseSync(join(dir, 'auditor.sqlite'))
    db.exec(`${MIRADAS.slice(0, -1)}, direccion_json TEXT)`)
    const insert = db.prepare('INSERT INTO miradas VALUES(?,?,?,?,?,?,?,?)')
    const direction = JSON.stringify({
      lado: -1,
      '4h': { mov_pb: 100, a_favor_pb: -100, acerto: false },
      '12h': { mov_pb: -40, a_favor_pb: 40, acerto: true },
      '24h': null,
    })
    insert.run(
      'PF_XBTUSD',
      0,
      'NO_ENTRAR_maestro',
      null,
      null,
      null,
      null,
      direction,
    )
    insert.run('PF_XBTUSD', MIN15, 'ENTRAR', null, null, null, null, 'not json')
    insert.run(
      'PF_XBTUSD',
      2 * MIN15,
      'ENTRAR',
      null,
      null,
      null,
      null,
      JSON.stringify({ lado: null, '4h': { mov_pb: 'x', acerto: 'si' } }),
    )
    db.close()

    const [odd, damaged, resolved] = reportOf(path)
    expect(resolved!.auditoria!.direccion).toEqual({
      lado: -1,
      '4h': { mov_pb: 100, a_favor_pb: -100, acerto: false },
      '12h': { mov_pb: -40, a_favor_pb: 40, acerto: true },
      '24h': null,
    })
    // The verdicts stay as they were.
    expect(resolved!.auditoria).toMatchObject({
      accion: 'NO_ENTRAR_maestro',
      veredicto_12h: null,
      despues: null,
    })
    expect(damaged!.auditoria!.direccion).toBeNull()
    // Wrong types read as null fields, never as invented numbers.
    expect(odd!.auditoria!.direccion).toEqual({
      lado: null,
      '4h': { mov_pb: null, a_favor_pb: null, acerto: null },
      '12h': null,
      '24h': null,
    })
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

describe('decision auditor training record', () => {
  const PROPUESTAS = `CREATE TABLE propuestas(product TEXT, bucket_ms INTEGER, lado INTEGER, inicio_episodio INTEGER,
    estado TEXT, motivo_bloqueo TEXT, detalle_bloqueo TEXT, trade_no INTEGER, neto_pb REAL, motivo_salida TEXT,
    horas REAL, resuelto_ms INTEGER)`

  it('attaches the entry proposal of each look with its block reason and its counterfactual label', () => {
    const { dir, path } = seedLive()
    const db = new DatabaseSync(join(dir, 'auditor.sqlite'))
    db.exec(MIRADAS)
    const looks = db.prepare('INSERT INTO miradas VALUES(?,?,?,?,?,?,?)')
    for (const bucket of [0, MIN15, 2 * MIN15])
      looks.run('PF_XBTUSD', bucket, 'NO_ENTRAR_regla', null, null, null, null)
    db.exec(PROPUESTAS)
    const insert = db.prepare(
      'INSERT INTO propuestas VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
    )
    insert.run(
      'PF_XBTUSD',
      0,
      1,
      1,
      'bloqueada',
      'lugares_ocupados',
      null,
      null,
      41.5,
      'maestro_vuelta',
      3,
      99,
    )
    insert.run(
      'PF_XBTUSD',
      MIN15,
      -1,
      0,
      'bloqueada',
      'otro',
      'saldo_insuficiente',
      null,
      null,
      null,
      null,
      null,
    )
    // The same bucket of another product must not leak in.
    insert.run(
      'PF_ETHUSD',
      2 * MIN15,
      1,
      1,
      'abierta',
      null,
      null,
      5,
      null,
      null,
      null,
      null,
    )
    db.close()

    const [none, open, resolved] = reportOf(path)
    expect(resolved!.auditoria!.propuesta).toEqual({
      lado: 1,
      inicio_episodio: true,
      estado: 'bloqueada',
      motivo_bloqueo: 'lugares_ocupados',
      detalle_bloqueo: null,
      trade_no: null,
      neto_pb: 41.5,
      motivo_salida: 'maestro_vuelta',
      horas: 3,
      resuelta: true,
    })
    expect(open!.auditoria!.propuesta).toMatchObject({
      lado: -1,
      inicio_episodio: false,
      motivo_bloqueo: 'otro',
      detalle_bloqueo: 'saldo_insuficiente',
      neto_pb: null,
      resuelta: false,
    })
    expect(none!.auditoria!.propuesta).toBeNull()
  })

  it('attaches the real result of each closed operation, even one no look names', () => {
    const { dir, path } = seedLive()
    const db = new DatabaseSync(join(dir, 'auditor.sqlite'))
    db.exec(`CREATE TABLE miradas(product TEXT, bucket_ms INTEGER, t_ms INTEGER, accion TEXT, trade_no INTEGER,
      veredicto_12h_json TEXT, veredicto_24h_json TEXT, veredicto_36h_json TEXT);
      CREATE TABLE resultados_operacion(product TEXT, trade_no INTEGER, neto_pb REAL, neto_usd REAL,
      motivo_cierre TEXT, motivo_salida TEXT, entry_px REAL, exit_px REAL, mfe_hl_pb REAL, mae_hl_pb REAL,
      resultado_ms INTEGER)`)
    const insert = db.prepare(
      'INSERT INTO resultados_operacion VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    )
    insert.run(
      'PF_XBTUSD',
      7,
      80.5,
      0.8,
      'formula',
      'maestro_vuelta',
      100,
      101,
      300,
      -100,
      5,
    )
    insert.run(
      'PF_XBTUSD',
      8,
      -12,
      -0.1,
      'tiempo',
      null,
      100,
      99.9,
      4,
      -20,
      null,
    )
    // The same operation number of another product must not leak in.
    insert.run('PF_ETHUSD', 7, 1, 1, 'x', 'x', 1, 1, 1, -1, 1)
    db.close()

    const audits = readAuditorTrades(path, 'PF_XBTUSD', [7, 8, 9])!
    expect(audits.get(7)!.resultado).toEqual({
      neto_pb: 80.5,
      neto_usd: 0.8,
      motivo_cierre: 'formula',
      motivo_salida: 'maestro_vuelta',
      entry_px: 100,
      exit_px: 101,
      mfe_hl_pb: 300,
      mae_hl_pb: -100,
      final: true,
    })
    expect(audits.get(7)).toMatchObject({ miradas: 0, entrada: null })
    expect(audits.get(8)!.resultado).toMatchObject({
      neto_pb: -12,
      motivo_salida: null,
      final: false,
    })
    expect(audits.has(9)).toBe(false)
  })

  it('leaves the result null when the auditor has no such table', () => {
    const { dir, path } = seedLive()
    const db = new DatabaseSync(join(dir, 'auditor.sqlite'))
    db.exec(`CREATE TABLE miradas(product TEXT, bucket_ms INTEGER, t_ms INTEGER, accion TEXT, trade_no INTEGER,
      veredicto_12h_json TEXT, veredicto_24h_json TEXT, veredicto_36h_json TEXT)`)
    db.exec(
      "INSERT INTO miradas VALUES('PF_XBTUSD',0,1,'ENTRAR',7,NULL,NULL,NULL)",
    )
    db.close()
    expect(
      readAuditorTrades(path, 'PF_XBTUSD', [7])!.get(7)!.resultado,
    ).toBeNull()
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
      // This auditor file has no `operaciones` table: no measure, nothing else changes.
      operacion: null,
    })
  })

  it('attaches the direction and MAE/MFE of each operation, even one no look names', () => {
    const path = seedAudit()
    const db = new DatabaseSync(join(dirname(path), 'auditor.sqlite'))
    db.exec(`CREATE TABLE operaciones(product TEXT, trade_no INTEGER, lado INTEGER, direccion_json TEXT,
      mfe_pb REAL, mae_pb REAL, hasta_ms INTEGER, resuelto_ms INTEGER)`)
    const insert = db.prepare('INSERT INTO operaciones VALUES(?,?,?,?,?,?,?,?)')
    insert.run(
      'PF_XBTUSD',
      7,
      -1,
      JSON.stringify({
        lado: -1,
        '4h': { mov_pb: 23, a_favor_pb: -23, acerto: false },
        '12h': null,
        '24h': null,
      }),
      152.3,
      -37.5,
      5_000,
      null,
    )
    // Operation 12: measured, but the auditor saw no look naming it.
    insert.run('PF_XBTUSD', 12, 1, null, 0, -329.5, 9_000, 77)
    // The same operation number of another product must not leak in.
    insert.run('PF_ETHUSD', 8, 1, null, 1, -1, 1, 1)
    db.close()

    const audits = readAuditorTrades(path, 'PF_XBTUSD', [7, 8, 12])!
    expect([...audits.keys()].sort((a, b) => a - b)).toEqual([7, 8, 12])
    expect(audits.get(7)).toMatchObject({
      entrada_horizonte: '36h',
      miradas: 5,
      operacion: {
        lado: -1,
        direccion: {
          lado: -1,
          '4h': { mov_pb: 23, a_favor_pb: -23, acerto: false },
          '12h': null,
        },
        mfe_pb: 152.3,
        mae_pb: -37.5,
        hasta_ms: 5_000,
        resuelta: false,
      },
    })
    expect(audits.get(8)!.operacion).toBeNull()
    expect(audits.get(12)).toMatchObject({
      entrada: null,
      salida: null,
      miradas: 0,
      operacion: {
        lado: 1,
        direccion: null,
        mfe_pb: 0,
        mae_pb: -329.5,
        resuelta: true,
      },
    })
  })

  it('attaches the maker shadow of each operation (entry and exit apart), even one no look names', () => {
    const path = seedAudit()
    const db = new DatabaseSync(join(dirname(path), 'auditor.sqlite'))
    db.exec(`CREATE TABLE sombra_maker(product TEXT, trade_no INTEGER, leg TEXT, motivo_salida TEXT, lado INTEGER,
      orden TEXT, t_oficial_ms INTEGER, precio_oficial REAL, comision_oficial_usd REAL, comision_oficial_tipo TEXT,
      cantidad REAL, notional_oficial_usd REAL, libro_ms INTEGER, limite_px REAL, estado TEXT, motivo_sin_datos TEXT,
      llenado_ms INTEGER, llenado_px REAL, cinta_px REAL, espera_ms INTEGER, comision_sombra_usd REAL,
      comision_sombra_tipo TEXT, delta_usd REAL, delta_pb REAL, modelo TEXT, costos_id TEXT, resuelto_ms INTEGER,
      version TEXT)`)
    const insert = db.prepare(
      'INSERT INTO sombra_maker VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    )
    const leg = (
      product: string,
      tradeNo: number,
      name: 'entry' | 'exit',
      over: Record<string, string | number | null> = {},
    ) => {
      const row = {
        motivo_salida: name === 'exit' ? 'vuelta' : null,
        lado: 1,
        orden: name === 'entry' ? 'compra' : 'venta',
        t_oficial_ms: 1_000,
        precio_oficial: 2250.1,
        comision_oficial_usd: 0.225,
        comision_oficial_tipo: 'taker',
        cantidad: 0.2,
        notional_oficial_usd: 450.02,
        libro_ms: 995,
        limite_px: 2250,
        estado: 'maker',
        motivo_sin_datos: null,
        llenado_ms: 1_090,
        llenado_px: 2250,
        cinta_px: null,
        espera_ms: 90,
        comision_sombra_usd: 0.09,
        comision_sombra_tipo: 'maker',
        delta_usd: 0.155,
        delta_pb: 3.44,
        modelo: 'sombra-maker.v1',
        costos_id: 'kraken-futures-costs.v2',
        resuelto_ms: 5_000,
        version: 'auditor.v1',
        ...over,
      }
      insert.run(product, tradeNo, name, ...Object.values(row))
    }
    leg('PF_XBTUSD', 7, 'entry')
    leg('PF_XBTUSD', 7, 'exit', {
      estado: 'maker_mercado',
      llenado_px: 2249.8,
      cinta_px: 2249.76,
      comision_sombra_tipo: 'taker',
      delta_pb: -10.2,
      delta_usd: -0.46,
      espera_ms: 900_000,
    })
    // Operation 8: the entry had no book snapshot; nothing is guessed.
    leg('PF_XBTUSD', 8, 'entry', {
      estado: 'sin_datos',
      motivo_sin_datos: 'sin_libro',
      limite_px: null,
      libro_ms: null,
      llenado_ms: null,
      llenado_px: null,
      espera_ms: null,
      comision_sombra_usd: null,
      comision_sombra_tipo: null,
      delta_usd: null,
      delta_pb: null,
    })
    // Operation 12: a shadow row but no look names it.
    leg('PF_XBTUSD', 12, 'exit', { motivo_salida: 'agotado' })
    // The same operation number of another product must not leak in.
    leg('PF_ETHUSD', 8, 'exit', { estado: 'maker_mercado' })
    db.close()

    const audits = readAuditorTrades(path, 'PF_XBTUSD', [7, 8, 12, 9])!
    expect(audits.get(7)!.sombra).toEqual({
      entrada: {
        estado: 'maker',
        motivo_sin_datos: null,
        motivo_salida: null,
        orden: 'compra',
        t_oficial_ms: 1_000,
        precio_oficial: 2250.1,
        comision_oficial_usd: 0.225,
        comision_oficial_tipo: 'taker',
        limite_px: 2250,
        llenado_ms: 1_090,
        llenado_px: 2250,
        cinta_px: null,
        espera_ms: 90,
        comision_sombra_usd: 0.09,
        comision_sombra_tipo: 'maker',
        delta_usd: 0.155,
        delta_pb: 3.44,
        modelo: 'sombra-maker.v1',
      },
      salida: expect.objectContaining({
        estado: 'maker_mercado',
        motivo_salida: 'vuelta',
        orden: 'venta',
        cinta_px: 2249.76,
        comision_sombra_tipo: 'taker',
        delta_pb: -10.2,
        espera_ms: 900_000,
      }),
    })
    expect(audits.get(8)!.sombra).toEqual({
      entrada: expect.objectContaining({
        estado: 'sin_datos',
        motivo_sin_datos: 'sin_libro',
        limite_px: null,
        llenado_px: null,
        delta_usd: null,
        delta_pb: null,
      }),
      salida: null,
    })
    expect(audits.get(12)).toMatchObject({
      miradas: 0,
      sombra: { entrada: null, salida: { motivo_salida: 'agotado' } },
    })
    expect(audits.has(9)).toBe(false)
    // Everything the audit carried before is untouched.
    expect(audits.get(7)).toMatchObject({
      entrada_horizonte: '36h',
      miradas: 5,
      operacion: null,
      resultado: null,
    })
  })

  it('leaves the shadow null when the auditor has no such table or the row is damaged', () => {
    const path = seedAudit()
    expect(readAuditorTrades(path, 'PF_XBTUSD', [7])!.get(7)!.sombra).toBeNull()
    const db = new DatabaseSync(join(dirname(path), 'auditor.sqlite'))
    db.exec(
      `CREATE TABLE sombra_maker(product TEXT, trade_no INTEGER, leg TEXT, estado TEXT, delta_pb REAL)`,
    )
    db.exec(
      "INSERT INTO sombra_maker VALUES('PF_XBTUSD',7,'entry','maker','no es un numero')",
    )
    db.exec("INSERT INTO sombra_maker VALUES('PF_XBTUSD',7,'raro',NULL,1)")
    db.close()
    // Columns the table does not have read as null; a leg name nobody knows is ignored; a text where a number goes is null.
    expect(readAuditorTrades(path, 'PF_XBTUSD', [7])!.get(7)!.sombra).toEqual({
      entrada: expect.objectContaining({
        estado: 'maker',
        delta_pb: null,
        llenado_px: null,
        orden: null,
      }),
      salida: null,
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

  it('serves the maker shadow inside the audit of the operations the gateway serves', () => {
    const path = seedAudit()
    const audit = new DatabaseSync(join(dirname(path), 'auditor.sqlite'))
    audit.exec(
      `CREATE TABLE sombra_maker(product TEXT, trade_no INTEGER, leg TEXT, estado TEXT, delta_pb REAL)`,
    )
    audit.exec(
      "INSERT INTO sombra_maker VALUES('PF_XBTUSD',7,'exit','maker',3.5)",
    )
    audit.close()
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
    expect(result.trades[0]!.auditoria!.sombra).toMatchObject({
      entrada: null,
      salida: { estado: 'maker', delta_pb: 3.5 },
    })
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
