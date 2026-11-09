// Pruebas de ops/vps/balancita-healthcheck.sh (S5 de odd/tasks/operacion-mejoras.md) sin la VPS: bases sqlite
// reales creadas en un directorio temporal (con el esquema de futures_qwen_live.py / futures_auditor.py) y
// `systemctl`, `curl`, `timedatectl`, `df` y `free` falsos en un PATH temporal. El reloj es el real: las filas se
// fechan relativas a «ahora», así que no se falsea `date`.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  existsSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..')
const script = join(raiz, 'ops/vps/balancita-healthcheck.sh')
const MIN = 60_000
const HC_URL = 'https://hc.example/uuid-secreta'

const SQL_LIVE = `
CREATE TABLE decisions(product TEXT NOT NULL, bucket_ms INTEGER NOT NULL, t_ms INTEGER NOT NULL, decided_at_ms INTEGER NOT NULL,
  kind TEXT NOT NULL, action TEXT NOT NULL, PRIMARY KEY(product, bucket_ms));
CREATE TABLE skipped(product TEXT NOT NULL, bucket_ms INTEGER NOT NULL, t_ms INTEGER NOT NULL, at_ms INTEGER NOT NULL,
  reason TEXT NOT NULL, detail TEXT, wake_json TEXT, PRIMARY KEY(product, bucket_ms));
CREATE TABLE trades(product TEXT NOT NULL, trade_no INTEGER NOT NULL, status TEXT NOT NULL, side TEXT NOT NULL,
  entry_ms INTEGER NOT NULL, mark_ms INTEGER, opened_at_ms INTEGER, execution_error TEXT, PRIMARY KEY(product, trade_no));
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
`
const SQL_AUDITOR = `
CREATE TABLE miradas_perdidas(product TEXT NOT NULL, bucket_ms INTEGER NOT NULL, t_ms INTEGER NOT NULL,
  motivo TEXT NOT NULL, estado TEXT NOT NULL, registrada_ms INTEGER NOT NULL, version TEXT NOT NULL,
  PRIMARY KEY(product, bucket_ms));
`
const SQL_MERCADO = `
CREATE TABLE paper_futures_official_candles(product_id TEXT NOT NULL, interval_ms INTEGER NOT NULL, bucket_start INTEGER NOT NULL);
`

// `date` real, sin falsear; los demás comandos de Linux que la VPS tiene y el Mac no, sí.
const CURL = String.raw`#!/usr/bin/env bash
echo "curl $*" >> "$STUB_DIR/curl.log"
url=""; for a in "$@"; do url="$a"; done
case "$url" in
  *:8088/health) [ -z "@{STUB_LLAMA_CAIDO:-}" ] || exit 22; exit 0 ;;
  https://futures.kraken.com*)
    [ -z "@{STUB_KRAKEN_CAIDO:-}" ] || exit 28
    t=$(( $(date +%s) - @{STUB_KRAKEN_OFFSET_S:-0} )); f='+%a, %d %b %Y %H:%M:%S GMT'
    if date -u -r 0 +%s >/dev/null 2>&1; then fecha=$(LC_ALL=C date -u -r "$t" "$f"); else fecha=$(LC_ALL=C date -u -d "@$t" "$f"); fi
    printf 'HTTP/2 200 \r\ndate: %s\r\ncontent-type: text/html\r\n\r\n' "$fecha" ;;
  https://hc.example/*) echo "$*" >> "$STUB_DIR/pings.log"; [ -z "@{STUB_PING_FALLA:-}" ] || exit 22 ;;
  *) echo "curl falso: sin respuesta para $url" >&2; exit 9 ;;
esac
`
const SYSTEMCTL = String.raw`#!/usr/bin/env bash
[ "$1" = is-active ] || exit 9
[ -z "@{STUB_SERVICIO_CAIDO:-}" ]
`
const TIMEDATECTL = String.raw`#!/usr/bin/env bash
[ -z "@{STUB_NTP_SIN_COMANDO:-}" ] || exit 127
echo "NTPSynchronized=@{STUB_NTP:-yes}"
`
const DF = String.raw`#!/usr/bin/env bash
printf 'Use%%\n %s%%\n' "@{STUB_DISCO:-42}"
`
const FREE = String.raw`#!/usr/bin/env bash
echo "              total        used        free      shared  buff/cache   available"
echo "Mem:          12000        3000        1000         100        8000        @{STUB_RAM_MB:-7000}"
`

const temporales = []
const hijos = []
after(() => {
  for (const h of hijos) h.kill('SIGKILL')
  for (const d of temporales) rmSync(d, { recursive: true, force: true })
})

function sql(archivo, texto) {
  const r = spawnSync('sqlite3', [archivo], { input: texto, encoding: 'utf8' })
  assert.equal(r.status, 0, `sqlite3 ${archivo}: ${r.stderr}`)
}

/**
 * Crea el entorno y corre el script. Los tiempos son «minutos atrás» (null = sin fila / sin dato).
 * `perdidas`: minutos atrás de cada mirada con `proceso_detenido` en live.sqlite; `perdidasAuditor`: lo mismo en miradas_perdidas.
 */
async function correr({
  decision = 5,
  salto = null,
  perdidas = [],
  perdidasAuditor = null,
  abierta = { marca: 3 },
  cerradaVieja = false,
  vela = 1,
  sinLive = false,
  sinMercado = false,
  bloquear = null,
  ping = true,
  env = {},
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'healthcheck-test-'))
  temporales.push(dir)
  const bin = join(dir, 'bin')
  const datos = join(dir, 'dev-live')
  mkdirSync(bin)
  mkdirSync(join(datos, 'qwen-live'), { recursive: true })
  for (const [nombre, texto] of Object.entries({
    curl: CURL,
    systemctl: SYSTEMCTL,
    timedatectl: TIMEDATECTL,
    df: DF,
    free: FREE,
  })) {
    writeFileSync(join(bin, nombre), texto.replaceAll('@{', '${'))
    chmodSync(join(bin, nombre), 0o755)
  }
  const ahora = Date.now()
  const hace = (m) => Math.round(ahora - m * MIN)
  const live = join(datos, 'qwen-live/live.sqlite')
  const auditor = join(datos, 'qwen-live/auditor.sqlite')
  if (!sinMercado) {
    sql(
      join(datos, 'futures-market.sqlite'),
      SQL_MERCADO +
        `INSERT INTO paper_futures_official_candles VALUES('PF_ETHUSD',60000,${hace(vela)});`,
    )
  }
  if (!sinLive) {
    let s = SQL_LIVE
    if (decision !== null)
      s += `INSERT INTO decisions VALUES('PF_ETHUSD',${hace(decision) - 900000},${hace(decision)},${hace(decision)},'formula','hold');`
    if (salto !== null)
      s += `INSERT INTO skipped VALUES('PF_ETHUSD',${hace(salto) - 900000},${hace(salto)},${hace(salto)},'modelo_caido','x','{}');`
    perdidas.forEach((m, i) => {
      // product distinto por fila no hace falta: cada mirada tiene su t_ms; las que repiten t_ms usan otro producto
      s += `INSERT INTO skipped VALUES('PF_P${i}',${hace(m) - 900000},${hace(m)},${ahora},'proceso_detenido','apagado','{}');`
    })
    if (abierta)
      s += `INSERT INTO trades VALUES('PF_ETHUSD',15,'open','LONG',${hace(500)},${abierta.marca === null ? 'NULL' : hace(abierta.marca)},${hace(abierta.abierta ?? 500)},${abierta.error ? `'${abierta.error}'` : 'NULL'});`
    if (cerradaVieja)
      s += `INSERT INTO trades VALUES('PF_ETHUSD',14,'closed','LONG',${hace(900)},${hace(800)},${hace(900)},NULL);`
    sql(live, s)
  }
  if (perdidasAuditor !== null) {
    let s = SQL_AUDITOR
    perdidasAuditor.forEach((m, i) => {
      s += `INSERT INTO miradas_perdidas VALUES('PF_P${i}',${hace(m) - 900000},${hace(m)},'proceso_detenido','sin_decision',${ahora},'v1');`
    })
    sql(auditor, s)
  }
  if (bloquear) {
    // otro proceso con la base bloqueada: el chequeo no puede leerla
    const archivo = bloquear === 'live' ? live : auditor
    const tabla = bloquear === 'live' ? 'meta' : 'miradas_perdidas'
    const h = spawn('sqlite3', [archivo])
    hijos.push(h)
    h.stdin.write(
      tabla === 'meta'
        ? "BEGIN EXCLUSIVE;\nINSERT INTO meta VALUES('a','b');\n"
        : "BEGIN EXCLUSIVE;\nUPDATE miradas_perdidas SET version='v2';\n",
    )
    await new Promise((r) => setTimeout(r, 400))
  }
  const log = join(dir, 'health.log')
  const t0 = Date.now()
  const r = await new Promise((resolve) => {
    const hijo = spawn('bash', [script], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        STUB_DIR: dir,
        HC_DATA_DIR: datos,
        HC_LOG: log,
        HC_DISK_PATH: dir,
        HC_SQLITE_TIMEOUT_MS: '300',
        ...(ping ? { HC_PING_URL: HC_URL } : {}),
        ...env,
      },
    })
    let stdout = ''
    let stderr = ''
    const corte = setTimeout(() => hijo.kill('SIGKILL'), 60_000)
    hijo.stdout.on('data', (c) => (stdout += c))
    hijo.stderr.on('data', (c) => (stderr += c))
    hijo.on('close', (status) => {
      clearTimeout(corte)
      resolve({ status, stdout, stderr })
    })
  })
  if (bloquear) for (const h of hijos) h.kill('SIGKILL')
  const leer = (n) =>
    existsSync(join(dir, n)) ? readFileSync(join(dir, n), 'utf8') : ''
  const pings = leer('pings.log').trim().split('\n').filter(Boolean)
  return {
    status: r.status,
    out: r.stdout + r.stderr,
    log: leer('health.log'),
    pings,
    ms: Date.now() - t0,
    dir,
    live,
  }
}

/** El ping que recibió healthchecks.io: éxito (sin /fail) o falla con el motivo. */
function veredicto(r) {
  assert.equal(r.pings.length, 1, `un solo ping, hubo: ${r.pings.join(' | ')}`)
  const p = r.pings[0]
  if (p.includes('/fail')) {
    assert.ok(p.includes(`${HC_URL}/fail`), p)
    const m = p.match(/--data-raw (.*) https:\/\/hc\.example/)
    return { ok: false, motivo: m ? m[1] : '' }
  }
  assert.ok(p.endsWith(HC_URL), p)
  assert.ok(!p.includes('--data-raw'), p)
  return { ok: true, motivo: '' }
}

function debeFallar(r, patron) {
  const v = veredicto(r)
  assert.equal(v.ok, false, `debía fallar; log: ${r.log}`)
  assert.equal(r.status, 1, 'código de salida 1')
  assert.match(v.motivo, patron)
  assert.match(r.log, /FALLA/)
}

function debePasar(r) {
  const v = veredicto(r)
  assert.equal(v.ok, true, `no debía fallar: ${v.motivo}\nlog: ${r.log}`)
  assert.equal(r.status, 0, r.out)
  assert.match(r.log, / OK /)
}

// Los grupos corren uno tras otro (cada grupo en paralelo por dentro) para que la prueba de velocidad no compita con las demás.
describe('balancita-healthcheck.sh', { concurrency: 1 }, () => {
  describe('sintaxis', { concurrency: true }, () => {
    it('pasa bash -n', () => {
      const r = spawnSync('bash', ['-n', script], { encoding: 'utf8' })
      assert.equal(r.status, 0, r.stderr)
    })
    it('pasa shellcheck si está instalado', (t) => {
      const probe = spawnSync('shellcheck', ['--version'], { encoding: 'utf8' })
      if (probe.error || probe.status !== 0)
        return t.skip('shellcheck no está instalado')
      const r = spawnSync('shellcheck', ['-S', 'warning', script], {
        encoding: 'utf8',
      })
      assert.equal(r.status, 0, r.stdout + r.stderr)
    })
  })

  describe(
    'camino sano y chequeos de antes (se conservan)',
    { concurrency: 6 },
    () => {
      it('todo en orden → ping de éxito sin /fail, código 0 y una línea OK en el log con los valores nuevos', async () => {
        const r = await correr()
        debePasar(r)
        assert.match(r.log, /latido_min=\d+/)
        assert.match(r.log, /perdidas_1h=0/)
        assert.match(r.log, /sin_valorar_min=\d+/)
        assert.match(r.log, /reloj_s=-?\d+/)
        assert.match(r.log, /llama=ok/)
        assert.match(r.log, /vela_eth_edad_min=[01] /) // the test clock and the script may straddle a minute
      })

      it('sin HC_PING_URL no pinguea nada pero sigue escribiendo el log y devolviendo el estado', async () => {
        const r = await correr({ ping: false })
        assert.equal(r.status, 0, r.out)
        assert.equal(r.pings.length, 0)
        assert.match(r.log, / OK /)
        const f = await correr({ ping: false, vela: 30 })
        assert.equal(f.status, 1)
        assert.equal(f.pings.length, 0)
      })

      it('servicio caído, vela vieja, disco lleno y RAM baja siguen fallando, unidos por «;»', async () => {
        const r = await correr({
          vela: 15,
          env: {
            STUB_SERVICIO_CAIDO: '1',
            STUB_DISCO: '85',
            STUB_RAM_MB: '300',
          },
        })
        debeFallar(r, /balancita\.service no activo/)
        const v = veredicto(r)
        assert.match(v.motivo, /ultima vela 1m ETH de hace 1[45] min/) // minute rounding against the real clock
        assert.match(v.motivo, /disco al 85%/)
        assert.match(v.motivo, /RAM disponible 300 MB/)
        assert.equal(v.motivo.split(';').length >= 4, true, v.motivo)
      })

      it('no deja archivos de journal ni WAL junto a las bases (solo lectura)', async () => {
        const r = await correr()
        debePasar(r)
        assert.ok(!existsSync(`${r.live}-journal`))
        assert.ok(!existsSync(`${r.live}-wal`))
      })
    },
  )

  describe('velocidad', () => {
    it('rápido: el chequeo sano tarda menos de 5 s', async () => {
      const r = await correr()
      assert.ok(r.ms < 5000, `tardó ${r.ms} ms`)
    })
  })

  describe('a) latido del operador', { concurrency: 6 }, () => {
    it('una decisión de hace 19 min cuenta como latido', async () => {
      debePasar(await correr({ decision: 19 }))
    })

    it('sin decisión ni salto en más de 20 min → «operador sin latido» con los minutos', async () => {
      const r = await correr({ decision: 25 })
      debeFallar(r, /operador sin latido.*2[45] min/)
    })

    it('una fila de skipped reciente también es latido (Qwen caído o libro no disponible)', async () => {
      debePasar(await correr({ decision: 40, salto: 4 }))
    })

    it('las miradas perdidas no valen como latido: su t_ms es del pasado aunque se anotaron ahora', async () => {
      const r = await correr({ decision: 40, perdidas: [38] })
      debeFallar(r, /operador sin latido/)
    })

    it('live.sqlite sin ninguna fila de decisión ni salto → sin latido', async () => {
      const r = await correr({ decision: null, abierta: null })
      debeFallar(r, /operador sin latido/)
    })

    it('el umbral se cambia con HC_LATIDO_MAX_MIN', async () => {
      const r = await correr({
        decision: 12,
        env: { HC_LATIDO_MAX_MIN: '10' },
      })
      debeFallar(r, /operador sin latido/)
    })
  })

  describe('b) miradas perdidas en la última hora', { concurrency: 6 }, () => {
    it('una sola mirada perdida no falla', async () => {
      debePasar(await correr({ perdidas: [20] }))
    })

    it('dos miradas perdidas en la última hora → falla con el número', async () => {
      const r = await correr({ perdidas: [20, 35] })
      debeFallar(r, /2 miradas perdidas en la ultima hora/)
    })

    it('las de hace más de una hora no cuentan', async () => {
      debePasar(await correr({ perdidas: [75, 90, 120] }))
    })

    it('cuenta las de miradas_perdidas del auditor (aunque live.sqlite no las tenga)', async () => {
      const r = await correr({ perdidasAuditor: [10, 25, 40] })
      debeFallar(r, /3 miradas perdidas/)
    })

    it('la misma mirada en las dos bases cuenta una sola vez', async () => {
      debePasar(await correr({ perdidas: [20], perdidasAuditor: [20] }))
    })

    it('dos productos que perdieron la misma mirada son una mirada, no dos', async () => {
      const r = await correr({ perdidas: [20, 20] })
      debePasar(r)
      assert.match(r.log, /perdidas_1h=1/)
    })

    it('sin base del auditor, o con una vieja sin la tabla, no falla ni cambia el resultado', async () => {
      debePasar(await correr({ perdidasAuditor: null }))
      const dir = await correr({ perdidas: [20] })
      assert.match(dir.log, /perdidas_1h=1/)
    })

    it('el auditor bloqueado no falla el chequeo (solo live.sqlite es obligatoria)', async () => {
      const r = await correr({
        perdidasAuditor: [10],
        bloquear: 'auditor',
      })
      debePasar(r)
    })

    it('umbral y ventana se cambian con HC_PERDIDAS_MIN y HC_PERDIDAS_VENTANA_MIN', async () => {
      debeFallar(
        await correr({ perdidas: [20], env: { HC_PERDIDAS_MIN: '1' } }),
        /1 miradas perdidas/,
      )
      debePasar(
        await correr({
          perdidas: [20, 35],
          env: { HC_PERDIDAS_VENTANA_MIN: '30' },
        }),
      )
    })
  })

  describe(
    'c) posición abierta que no se pudo valorar',
    { concurrency: 6 },
    () => {
      it('marca de hace 20 min → bien', async () => {
        debePasar(await correr({ abierta: { marca: 20 } }))
      })

      it('marca de hace 45 min con el error de libro → falla con producto, número de operación y minutos', async () => {
        const r = await correr({
          abierta: { marca: 45, error: 'libro_no_disponible' },
        })
        debeFallar(
          r,
          /posicion PF_ETHUSD #15 sin valorar hace 4[45] min \(libro_no_disponible\)/,
        )
      })

      it('sin marca nunca, cuenta desde que se abrió', async () => {
        const r = await correr({ abierta: { marca: null, abierta: 50 } })
        debeFallar(r, /sin valorar hace (49|50|51) min/)
        debePasar(await correr({ abierta: { marca: null, abierta: 10 } }))
      })

      it('sin posiciones abiertas, o con una cerrada vieja, no hay nada que valorar', async () => {
        debePasar(await correr({ abierta: null }))
        debePasar(await correr({ abierta: null, cerradaVieja: true }))
      })

      it('el umbral se cambia con HC_SIN_VALORAR_MAX_MIN', async () => {
        debeFallar(
          await correr({
            abierta: { marca: 20 },
            env: { HC_SIN_VALORAR_MAX_MIN: '15' },
          }),
          /sin valorar/,
        )
      })
    },
  )

  describe('d) reloj de la VPS', { concurrency: 6 }, () => {
    it('sincronizado y con diferencia de 1 s contra Kraken → bien, y el log guarda la diferencia', async () => {
      const r = await correr({ env: { STUB_KRAKEN_OFFSET_S: '1' } })
      debePasar(r)
      assert.match(r.log, /reloj_s=(0|1|2)/)
    })

    it('VPS adelantada 10 s → falla con la diferencia medida', async () => {
      const r = await correr({ env: { STUB_KRAKEN_OFFSET_S: '10' } })
      debeFallar(r, /reloj de la VPS desfasado \+?(9|10|11) s/)
    })

    it('VPS atrasada 10 s → falla con la diferencia negativa', async () => {
      const r = await correr({ env: { STUB_KRAKEN_OFFSET_S: '-10' } })
      debeFallar(r, /reloj de la VPS desfasado -(9|10|11) s/)
    })

    it('NTPSynchronized=no → falla aunque la diferencia sea chica', async () => {
      const r = await correr({ env: { STUB_NTP: 'no' } })
      debeFallar(r, /reloj de la VPS sin sincronizar \(NTP\)/)
    })

    it('Kraken no contesta pero NTP dice yes → no falla (no se pudo medir)', async () => {
      const r = await correr({ env: { STUB_KRAKEN_CAIDO: '1' } })
      debePasar(r)
      assert.match(r.log, /reloj_s=NA/)
    })

    it('Kraken no contesta y NTP no → falla por NTP', async () => {
      const r = await correr({
        env: { STUB_KRAKEN_CAIDO: '1', STUB_NTP: 'no' },
      })
      debeFallar(r, /sin sincronizar/)
    })

    it('sin timedatectl se mide solo contra Kraken', async () => {
      debePasar(await correr({ env: { STUB_NTP_SIN_COMANDO: '1' } }))
      debeFallar(
        await correr({
          env: { STUB_NTP_SIN_COMANDO: '1', STUB_KRAKEN_OFFSET_S: '8' },
        }),
        /desfasado/,
      )
    })

    it('el umbral se cambia con HC_RELOJ_MAX_S', async () => {
      debePasar(
        await correr({
          env: { STUB_KRAKEN_OFFSET_S: '5', HC_RELOJ_MAX_S: '8' },
        }),
      )
    })
  })

  describe('e) Qwen caído ya no falla el ping', { concurrency: 6 }, () => {
    it('llama-server caído con todo lo demás bien → ping de éxito y el log lo anota', async () => {
      const r = await correr({ env: { STUB_LLAMA_CAIDO: '1' } })
      debePasar(r)
      assert.match(r.log, /llama=caido/)
    })

    it('con otro fallo y Qwen caído, el motivo no menciona a Qwen', async () => {
      const r = await correr({
        decision: 30,
        env: { STUB_LLAMA_CAIDO: '1' },
      })
      debeFallar(r, /operador sin latido/)
      assert.doesNotMatch(veredicto(r).motivo, /llama/)
    })
  })

  describe('bases ausentes o bloqueadas', { concurrency: 6 }, () => {
    it('falta live.sqlite → falla (es la base del operador)', async () => {
      const r = await correr({ sinLive: true })
      debeFallar(r, /live\.sqlite/)
    })

    it('live.sqlite bloqueada por otro proceso → falla con «no se pudo leer»', async () => {
      const r = await correr({ bloquear: 'live' })
      debeFallar(r, /no se pudo leer live\.sqlite/)
    })

    it('falta futures-market.sqlite → falla solo por la vela, como antes, sin romper lo demás', async () => {
      const r = await correr({ sinMercado: true })
      debeFallar(r, /no se pudo leer la ultima vela 1m ETH/)
      assert.doesNotMatch(veredicto(r).motivo, /live\.sqlite|latido/)
    })

    it('un ping que falla no cambia el resultado y queda anotado en el log', async () => {
      const r = await correr({ env: { STUB_PING_FALLA: '1' } })
      assert.equal(r.status, 0)
      assert.match(r.log, /aviso: ping a healthchecks fallo/)
    })
  })

  describe('varios fallos juntos', { concurrency: 6 }, () => {
    it('latido, perdidas, sin valorar y reloj en un solo /fail, cada uno con su motivo corto', async () => {
      const r = await correr({
        decision: 45,
        perdidas: [10, 20],
        abierta: { marca: 50, error: 'libro_obsoleto' },
        env: { STUB_KRAKEN_OFFSET_S: '9' },
      })
      debeFallar(r, /operador sin latido/)
      const m = veredicto(r).motivo
      assert.match(m, /2 miradas perdidas/)
      assert.match(m, /sin valorar/)
      assert.match(m, /desfasado/)
    })
  })
})
