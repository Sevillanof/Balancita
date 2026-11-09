// Pruebas de ops/vps/desplegar.sh y scripts/gh-sevillanof.sh con `gh`, `ssh`, `date` y `sleep` falsos en un PATH
// temporal: no tocan GitHub, la VPS ni el reloj real. El reloj falso avanza solo cuando el script llama a `sleep`.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..')
const desplegar = join(raiz, 'ops/vps/desplegar.sh')
const envoltorio = join(raiz, 'scripts/gh-sevillanof.sh')
const TOKEN = 'ghp_FAKE_TOKEN_SECRET'

const realDate = spawnSync('bash', ['-c', 'command -v date'], {
  encoding: 'utf8',
}).stdout.trim()

const GH = String.raw`#!/usr/bin/env bash
d="$STUB_DIR"
echo "gh $* [GH_TOKEN=@{GH_TOKEN:+puesto}]" >> "$d/calls.log"
cnt() { local f="$d/cnt-$1" n=0; [ -f "$f" ] && n=$(cat "$f"); n=$((n+1)); echo "$n" > "$f"; echo "$n"; }
case "$1 $2" in
  "auth token") [ -z "@{STUB_NO_ACCOUNT:-}" ] || exit 1; echo "ghp_FAKE_TOKEN_SECRET"; exit 0 ;;
  "api user")
    [ "@{GH_TOKEN:-}" = ghp_FAKE_TOKEN_SECRET ] || { echo "HTTP 401" >&2; exit 1; }
    echo "@{STUB_LOGIN:-Sevillanof}"; exit 0 ;;
esac
if [ -n "@{STUB_FAIL_401:-}" ] && [ "$1 $2" = "pr list" ]; then echo "HTTP 401: Bad credentials" >&2; exit 1; fi
if [ -n "@{STUB_FLAKY:-}" ] && [ "$1 $2" = "pr view" ] && [[ "$*" == *mergeable* ]]; then
  n=$(cnt flaky); if [ "$n" -le "$STUB_FLAKY" ]; then echo "HTTP 502: Bad Gateway" >&2; exit 1; fi
fi
case "$1 $2" in
  "pr list") if [ -f "$d/pr_creado" ] || [ -n "@{STUB_PR_ABIERTO:-}" ]; then echo 42; fi ;;
  "pr create") touch "$d/pr_creado"; echo "https://github.com/x/y/pull/42" ;;
  "pr merge") [ -z "@{STUB_MERGE_FALLA:-}" ] || { echo "merge bloqueado" >&2; exit 1; }; touch "$d/mergeado" ;;
  "pr view")
    if [[ "$*" == *mergeable* ]]; then echo "@{STUB_MERGEABLE:-MERGEABLE}"
    elif [[ "$*" == *'map(tostring)'* ]]; then
      n=$(cnt ci); IFS=',' read -ra seq <<<"@{STUB_CI_SEQ:-5 0 0}"
      i=$((n-1)); [ "$i" -lt "@{#seq[@]}" ] || i=$((@{#seq[@]}-1)); echo "@{seq[$i]}"
    elif [[ "$*" == *'join(", ")'* ]]; then echo "python (3), node"
    elif [[ "$*" == *headRefOid* ]]; then echo "abc123"
    elif [[ "$*" == *state* ]]; then if [ -f "$d/mergeado" ]; then echo MERGED; else echo "@{STUB_PR_ESTADO:-OPEN}"; fi
    fi ;;
  "run list") echo "@{STUB_EVENTOS:-pull_request,push}" ;;
  api\ repos*) echo "@{STUB_ADELANTE:-3}" ;;
  *) echo "gh falso: sin respuesta para $*" >&2; exit 9 ;;
esac
`

const SSH = String.raw`#!/usr/bin/env bash
d="$STUB_DIR"
cmd="@{@: -1}"
echo "$cmd" >> "$d/ssh.log"
echo "@{*:1:$#-1}" >> "$d/ssh.opts"
[ -z "@{STUB_SSH_CAIDO:-}" ] || { echo "ssh: connect timed out" >&2; exit 255; }
case "$cmd" in
  true) ;;
  *"git pull"*) [ -z "@{STUB_PULL_FALLA:-}" ] || { echo "fatal: Not possible to fast-forward" ; exit 1; }; printf 'Updating a..b\nFast-forward\n' ;;
  *balancita-healthcheck.sh*) [ -z "@{STUB_HC_FALLA:-}" ] || { echo "install: cannot create" >&2; exit 1; }; echo "@{STUB_HC:-igual}" ;;
  *"cmp -s"*) printf '%b' "@{STUB_DROPINS:-llama.conf distinto\n}" ;;
  install\ -D*) ;;
  *daemon-reload*) ;;
  *ActiveEnterTimestamp*) echo "@{STUB_NECESITA:-si}" ;;
  *"systemctl restart"*) date -u +%H:%M > "$d/reinicio.at" ;;
  *"systemctl is-active"*) echo "@{STUB_ACTIVO:-active}" ;;
  *llama-server*) echo "@{STUB_LLAMA:-pid=123 vmlck_kb=4300000 hilos5=si}" ;;
  *health-child*) printf '%s' "@{STUB_INTEGRIDAD:-}" ;;
  *sqlite3*) printf '%s' "@{STUB_ERRORES:-}" ;;
  *journalctl*) echo "@{STUB_TRACEBACKS:-0}" ;;
  *) echo "ssh falso: sin respuesta para $cmd" >&2; exit 9 ;;
esac
`

const DATE = String.raw`#!/usr/bin/env bash
read -r clock < "$STUB_DIR/reloj"
fmt=""; for a in "$@"; do case "$a" in +*) fmt="@{a#+}" ;; esac; done
[ "$fmt" != "%s" ] || { echo "$clock"; exit 0; }
if "$REAL_DATE" -u -r 0 +%s >/dev/null 2>&1; then exec "$REAL_DATE" -u -r "$clock" "+$fmt"; fi
exec "$REAL_DATE" -u -d "@$clock" "+$fmt"
`

const SLEEP = String.raw`#!/usr/bin/env bash
echo "sleep $1" >> "$STUB_DIR/sleep.log"
read -r clock < "$STUB_DIR/reloj"
echo $(( clock + $1 )) > "$STUB_DIR/reloj"
`

const temporales = []
after(() => {
  for (const d of temporales) rmSync(d, { recursive: true, force: true })
})

function epoch(hhmm, seg = 0) {
  const [h, m] = hhmm.split(':').map(Number)
  return Math.floor(Date.UTC(2026, 10, 9, h, m, seg) / 1000)
}

/** Prepara stubs y corre el script. `inicio` = hora UTC falsa 'HH:MM'. Devuelve resultado y lecturas del estado. */
async function correr(
  args = [],
  { inicio = '10:20', env = {}, script = desplegar } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'desplegar-test-'))
  temporales.push(dir)
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  for (const [nombre, texto] of Object.entries({
    gh: GH,
    ssh: SSH,
    date: DATE,
    sleep: SLEEP,
  })) {
    writeFileSync(join(bin, nombre), texto.replaceAll('@{', '${'))
    chmodSync(join(bin, nombre), 0o755)
  }
  writeFileSync(join(dir, 'reloj'), String(epoch(inicio)))
  const r = await new Promise((resolve) => {
    const hijo = spawn('bash', [script, ...args], {
      env: {
        ...process.env,
        GH_TOKEN: '',
        PATH: `${bin}:${process.env.PATH}`,
        STUB_DIR: dir,
        REAL_DATE: realDate,
        ...env,
      },
    })
    let stdout = ''
    let stderr = ''
    const reloj = setTimeout(() => hijo.kill('SIGKILL'), 120_000)
    hijo.stdout.on('data', (c) => (stdout += c))
    hijo.stderr.on('data', (c) => (stderr += c))
    hijo.on('close', (status) => {
      clearTimeout(reloj)
      resolve({ status, stdout, stderr })
    })
  })
  const leer = (n) =>
    existsSync(join(dir, n)) ? readFileSync(join(dir, n), 'utf8') : ''
  return {
    status: r.status,
    out: r.stdout,
    err: r.stderr,
    todo: r.stdout + r.stderr,
    gh: leer('calls.log'),
    ssh: leer('ssh.log'),
    sleeps: leer('sleep.log'),
    reinicio: leer('reinicio.at').trim(),
    reloj: Number(leer('reloj')),
    dir,
  }
}

const ghLlamo = (r, texto) => r.gh.split('\n').some((l) => l.includes(texto))
const sshLlamo = (r, texto) => r.ssh.split('\n').some((l) => l.includes(texto))

describe('desplegar', { concurrency: 8 }, () => {
  describe('desplegar.sh: sintaxis', { concurrency: true }, () => {
    it('pasa bash -n (script y envoltorio)', async () => {
      for (const f of [desplegar, envoltorio]) {
        const r = spawnSync('bash', ['-n', f], { encoding: 'utf8' })
        assert.equal(r.status, 0, r.stderr)
      }
    })

    it('pasa shellcheck si está instalado', (t) => {
      const probe = spawnSync('shellcheck', ['--version'], { encoding: 'utf8' })
      if (probe.error || probe.status !== 0)
        return t.skip('shellcheck no está instalado')
      const r = spawnSync(
        'shellcheck',
        ['-x', '-S', 'warning', desplegar, envoltorio],
        { encoding: 'utf8' },
      )
      assert.equal(r.status, 0, r.stdout + r.stderr)
    })
  })

  describe('desplegar.sh: camino feliz', { concurrency: true }, () => {
    it('CI verde → crea el PR, mergea, hace pull, instala el drop-in distinto y reinicia dentro de la ventana', async () => {
      const r = await correr(['--omitir', 'noticias.conf'], {
        inicio: '10:20',
        env: {
          STUB_CI_SEQ: '2 2 0,2 1 0,2 0 0',
          STUB_DROPINS: 'llama.conf distinto\\nnoticias.conf nuevo\\n',
        },
      })
      assert.equal(r.status, 0, r.todo)
      assert.ok(ghLlamo(r, 'pr create'), 'crea el PR')
      assert.ok(ghLlamo(r, 'pr merge 42'), 'mergea el PR')
      const iMerge = r.gh.indexOf('pr merge')
      assert.ok(
        iMerge > r.gh.indexOf('pr view 42'),
        'mergea después de mirar la CI',
      )
      // orden en la VPS: pull → drop-ins → daemon-reload → reinicio → chequeos
      const orden = [
        'git pull --ff-only',
        'cmp -s',
        'install -D -m 644',
        'daemon-reload',
        'systemctl restart balancita',
        'is-active',
      ]
      const posiciones = orden.map((t) => r.ssh.indexOf(t))
      assert.ok(
        posiciones.every((p) => p >= 0),
        `faltan pasos: ${posiciones}`,
      )
      assert.deepEqual(
        [...posiciones].sort((a, b) => a - b),
        posiciones,
        'orden de los pasos',
      )
      assert.match(
        r.ssh,
        /install -D -m 644 \S+\/llama\.conf \/etc\/systemd\/system\/balancita\.service\.d\/llama\.conf/,
      )
      assert.doesNotMatch(
        r.ssh,
        /install -D[^\n]*noticias\.conf/,
        'un drop-in nuevo no se instala solo',
      )
      assert.match(r.out, /noticias\.conf: nuevo, omitido a pedido/)
      const minuto = Number(r.reinicio.split(':')[1])
      assert.ok(minuto >= 16 && minuto <= 27, `reinicio a las ${r.reinicio}`)
      assert.match(r.out, /Despliegue completo\./)
      for (const ok of [
        'active',
        'VmLck 4300000 kB',
        '-t 5',
        'integridad',
        'errores',
        'Traceback',
      ]) {
        assert.ok(r.out.includes(ok), `falta el chequeo «${ok}»:\n${r.out}`)
      }
    })

    it('usa la cuenta Sevillanof solo con GH_TOKEN del proceso, nunca imprime el token y no cambia la cuenta global', async () => {
      const r = await correr([], { env: { STUB_PR_ABIERTO: '1' } })
      assert.equal(r.status, 0, r.todo)
      assert.ok(ghLlamo(r, 'auth token -u Sevillanof'))
      assert.ok(ghLlamo(r, 'api user -q .login [GH_TOKEN=puesto]'), r.gh)
      const llamadas = r.gh
        .split(/\n(?=gh )/)
        .filter((l) => l.startsWith('gh pr'))
      assert.ok(
        llamadas.length > 0 &&
          llamadas.every((l) => l.includes('[GH_TOKEN=puesto]')),
        r.gh,
      )
      assert.ok(
        !r.todo.includes(TOKEN),
        'el token no debe aparecer en la salida',
      )
      assert.ok(!r.gh.includes(TOKEN))
      assert.ok(
        !ghLlamo(r, 'auth switch') &&
          !ghLlamo(r, 'auth login') &&
          !ghLlamo(r, 'auth logout'),
      )
    })

    it('reutiliza el PR abierto en vez de crear otro', async () => {
      const r = await correr([], { env: { STUB_PR_ABIERTO: '1' } })
      assert.equal(r.status, 0, r.todo)
      assert.ok(!ghLlamo(r, 'pr create'))
      assert.match(r.out, /Ya hay un PR develop → main abierto: #42/)
    })

    it('imprime una línea de estado cada 2 minutos mientras espera la CI', async () => {
      // 10 lecturas pendientes con sondeo de 30 s = 5 minutos de espera
      const pendiente = Array(10).fill('3 2 0').join(',') + ',3 0 0'
      const r = await correr([], {
        inicio: '10:20',
        env: { STUB_PR_ABIERTO: '1', STUB_CI_SEQ: pendiente },
      })
      assert.equal(r.status, 0, r.todo)
      const lineas = r.out
        .split('\n')
        .filter((l) => l.includes('Esperando la CI del PR #42'))
      assert.ok(
        lineas.length >= 2 && lineas.length <= 4,
        `líneas de estado: ${lineas.length}\n${r.out}`,
      )
      assert.match(lineas[0], /2 de 3 checks pendientes/)
    })
  })

  describe('desplegar.sh: PR y CI', { concurrency: true }, () => {
    for (const [nombre, env, mensaje] of [
      [
        'CI en rojo',
        { STUB_CI_SEQ: '3 1 1' },
        /CI del PR #42 está en rojo.*python \(3\), node/,
      ],
      [
        'conflicto con main',
        { STUB_MERGEABLE: 'CONFLICTING' },
        /tiene conflictos con main/,
      ],
    ]) {
      it(`${nombre} → aborta con código 3, sin mergear y sin tocar la VPS`, async () => {
        const r = await correr([], { env: { STUB_PR_ABIERTO: '1', ...env } })
        assert.equal(r.status, 3, r.todo)
        assert.match(r.err, mensaje)
        assert.ok(!ghLlamo(r, 'pr merge'))
        assert.equal(r.ssh, '', 'no hubo ni un ssh')
      })
    }

    it('sin checks de CI → aborta pasado el tiempo de gracia', async () => {
      const r = await correr([], {
        env: {
          STUB_PR_ABIERTO: '1',
          STUB_CI_SEQ: '0 0 0',
          DESPLIEGUE_SIN_CHECKS_SEG: '90',
        },
      })
      assert.equal(r.status, 3, r.todo)
      assert.match(r.err, /no tiene checks de CI/)
      assert.ok(!ghLlamo(r, 'pr merge'))
      assert.equal(r.ssh, '')
    })

    it('verde pero falta uno de los dos conjuntos (push / pull_request) → aborta', async () => {
      const r = await correr([], {
        env: {
          STUB_PR_ABIERTO: '1',
          STUB_EVENTOS: 'push',
          DESPLIEGUE_SIN_CHECKS_SEG: '90',
        },
      })
      assert.equal(r.status, 3, r.todo)
      assert.match(r.err, /faltan checks de CI: solo hay corridas de 'push'/)
      assert.ok(!ghLlamo(r, 'pr merge'))
    })

    it('CI que no termina en 60 min (aquí 5 min) → aborta sin mergear', async () => {
      const r = await correr([], {
        env: {
          STUB_PR_ABIERTO: '1',
          STUB_CI_SEQ: '3 2 0',
          DESPLIEGUE_CI_MAX_SEG: '300',
        },
      })
      assert.equal(r.status, 3, r.todo)
      assert.match(r.err, /no terminó en 5 min/)
      assert.ok(!ghLlamo(r, 'pr merge'))
    })

    it('la espera por defecto llega hasta 60 minutos', async () => {
      const r = await correr([], {
        env: { STUB_PR_ABIERTO: '1', STUB_CI_SEQ: '3 2 0' },
      })
      assert.equal(r.status, 3, r.todo)
      assert.match(r.err, /no terminó en 60 min/)
      assert.ok(r.reloj - epoch('10:20') >= 3600)
    })

    it('un 502 transitorio se reintenta y el despliegue sigue', async () => {
      const r = await correr([], {
        env: { STUB_PR_ABIERTO: '1', STUB_FLAKY: '2' },
      })
      assert.equal(r.status, 0, r.todo)
      assert.match(r.err, /gh falló \(intento 2 de 4: HTTP 502/)
    })

    it('un 401 que no se arregla se reintenta unas veces y aborta con el motivo', async () => {
      const r = await correr([], { env: { STUB_FAIL_401: '1' } })
      assert.equal(r.status, 3, r.todo)
      assert.match(r.err, /falló 4 veces seguidas: HTTP 401/)
      assert.equal(
        r.gh.split('\n').filter((l) => l.startsWith('gh pr list')).length,
        4,
      )
      assert.ok(!ghLlamo(r, 'pr merge'))
    })

    it('si el merge es rechazado por GitHub aborta y no toca la VPS', async () => {
      const r = await correr([], {
        env: { STUB_PR_ABIERTO: '1', STUB_MERGE_FALLA: '1' },
      })
      assert.notEqual(r.status, 0)
      assert.equal(r.ssh, '')
    })
  })

  describe('desplegar.sh: cuenta de GitHub', { concurrency: true }, () => {
    it('si la cuenta activa no es Sevillanof, aborta antes de cualquier operación', async () => {
      const r = await correr([], { env: { STUB_LOGIN: 'fransevillano' } })
      assert.equal(r.status, 1, r.todo)
      assert.match(
        r.err,
        /la cuenta activa es 'fransevillano' y tiene que ser 'Sevillanof'/,
      )
      assert.ok(!ghLlamo(r, 'pr '))
      assert.equal(r.ssh, '')
      assert.ok(!r.todo.includes(TOKEN))
    })

    it('si gh no tiene guardada la cuenta Sevillanof, aborta', async () => {
      const r = await correr([], { env: { STUB_NO_ACCOUNT: '1' } })
      assert.equal(r.status, 1, r.todo)
      assert.match(r.err, /no tiene guardada la cuenta Sevillanof/)
      assert.equal(r.ssh, '')
    })

    it('un GH_TOKEN heredado del entorno no se usa: el script lo reemplaza por el de Sevillanof', async () => {
      const r = await correr([], {
        env: { GH_TOKEN: 'token-de-otra-cuenta', STUB_PR_ABIERTO: '1' },
      })
      assert.equal(r.status, 0, r.todo)
      assert.ok(!r.todo.includes('token-de-otra-cuenta'))
    })

    describe('scripts/gh-sevillanof.sh', () => {
      it('corre gh con el token de Sevillanof y reenvía los argumentos', async () => {
        const r = await correr(['pr', 'list', '--base', 'main'], {
          script: envoltorio,
          env: { STUB_PR_ABIERTO: '1' },
        })
        assert.equal(r.status, 0, r.todo)
        assert.match(r.gh, /gh pr list --base main \[GH_TOKEN=puesto\]/)
        assert.ok(!r.todo.includes(TOKEN))
        assert.ok(!ghLlamo(r, 'auth switch'))
      })

      it('con otra cuenta activa se niega a correr el comando', async () => {
        const r = await correr(['pr', 'list'], {
          script: envoltorio,
          env: { STUB_LOGIN: 'otra' },
        })
        assert.equal(r.status, 1, r.todo)
        assert.match(r.err, /tiene que ser 'Sevillanof'/)
        assert.ok(!ghLlamo(r, 'pr list'))
      })
    })
  })

  describe('desplegar.sh: ventana de reinicio', { concurrency: true }, () => {
    it('dentro de :16-:27 reinicia enseguida, sin esperar', async () => {
      const r = await correr([], {
        inicio: '10:20',
        env: { STUB_PR_ABIERTO: '1', STUB_CI_SEQ: '2 0 0' },
      })
      assert.equal(r.status, 0, r.todo)
      assert.doesNotMatch(r.out, /Fuera de la ventana/)
      assert.match(r.out, /Estamos en la ventana de reinicio \(minuto :2\d UTC/)
      assert.equal(r.reinicio, '10:20')
    })

    for (const inicio of ['10:30', '10:05', '10:28', '10:15']) {
      it(`fuera de la ventana (${inicio}) espera y reinicia entre :16 y :27`, async () => {
        const r = await correr([], {
          inicio,
          env: { STUB_PR_ABIERTO: '1', STUB_CI_SEQ: '2 0 0' },
        })
        assert.equal(r.status, 0, r.todo)
        assert.match(r.out, /Fuera de la ventana de reinicio/)
        const minuto = Number(r.reinicio.split(':')[1])
        assert.ok(minuto >= 16 && minuto <= 27, `reinicio a las ${r.reinicio}`)
        assert.ok(r.sleeps.length > 0)
      })
    }

    it('--sin-reinicio no reinicia, no espera la ventana y avisa que queda pendiente', async () => {
      const r = await correr(['--sin-reinicio'], {
        inicio: '10:40',
        env: { STUB_PR_ABIERTO: '1', STUB_CI_SEQ: '2 0 0' },
      })
      assert.equal(r.status, 0, r.todo)
      assert.ok(ghLlamo(r, 'pr merge 42'), 'igual mergea')
      assert.ok(sshLlamo(r, 'git pull --ff-only'), 'igual hace pull')
      assert.ok(!sshLlamo(r, 'systemctl restart'))
      assert.ok(!sshLlamo(r, 'is-active'))
      assert.doesNotMatch(r.out, /Fuera de la ventana/)
      assert.match(r.out, /balancita NO se reinició y queda pendiente/)
    })
  })

  describe('desplegar.sh: --dry-run', { concurrency: true }, () => {
    it('no crea PR, no mergea, no toca la VPS más que un ssh de prueba y no espera', async () => {
      const r = await correr(['--dry-run'], {
        inicio: '10:40',
        env: { STUB_PR_ABIERTO: '' },
      })
      assert.equal(r.status, 0, r.todo)
      assert.ok(!ghLlamo(r, 'pr create') && !ghLlamo(r, 'pr merge'))
      assert.deepEqual(r.ssh.trim().split('\n'), ['true'])
      assert.equal(r.sleeps, '', 'no duerme')
      assert.equal(r.reinicio, '')
      assert.match(r.out, /\[dry-run\] crearía el PR develop → main/)
      assert.match(r.out, /\[dry-run\] en la VPS: git pull --ff-only/)
      assert.match(r.out, /Fin del dry-run: no se cambió nada/)
    })

    it('con un PR abierto lo reporta pero no espera la CI ni mergea', async () => {
      const r = await correr(['--dry-run'], {
        env: { STUB_PR_ABIERTO: '1', STUB_CI_SEQ: '3 2 0' },
      })
      assert.equal(r.status, 0, r.todo)
      assert.match(r.out, /\[dry-run\] esperaría la CI del PR #42/)
      assert.ok(!ghLlamo(r, 'pr merge') && !ghLlamo(r, 'statusCheckRollup'))
      assert.deepEqual(r.ssh.trim().split('\n'), ['true'])
    })

    it('--dry-run con la cuenta equivocada también aborta', async () => {
      const r = await correr(['--dry-run'], { env: { STUB_LOGIN: 'otra' } })
      assert.equal(r.status, 1, r.todo)
    })
  })

  describe('desplegar.sh: VPS y drop-ins', { concurrency: true }, () => {
    it('un drop-in nuevo sin decidir frena con código 2, sin instalar ni reiniciar', async () => {
      const r = await correr([], {
        env: {
          STUB_PR_ABIERTO: '1',
          STUB_CI_SEQ: '2 0 0',
          STUB_DROPINS: 'llama.conf distinto\\nnoticias.conf nuevo\\n',
        },
      })
      assert.equal(r.status, 2, r.todo)
      assert.match(r.err + r.out, /noticias\.conf/)
      assert.match(r.err + r.out, /--dropin NOMBRE.*--omitir NOMBRE/)
      assert.doesNotMatch(r.ssh, /install -D/)
      assert.doesNotMatch(r.ssh, /systemctl restart/)
    })

    it('lee el último commit en la VPS como balancita (root ve el repo como «dubious ownership» y daba 0)', async () => {
      const r = await correr([], {
        env: { STUB_PR_ABIERTO: '1', STUB_CI_SEQ: '2 0 0' },
      })
      assert.equal(r.status, 0, r.todo)
      assert.match(
        r.ssh,
        /ActiveEnterTimestamp[^\n]*sudo -u balancita git -C \S+ log -1 --format=%ct/,
      )
      assert.match(r.ssh, /ActiveEnterTimestamp[^\n]*echo error/)
    })

    it('si la VPS no puede decir la fecha del último commit, frena con código 5 sin reiniciar', async () => {
      const r = await correr([], {
        env: {
          STUB_PR_ABIERTO: '1',
          STUB_CI_SEQ: '2 0 0',
          STUB_NECESITA: 'error',
        },
      })
      assert.equal(r.status, 5, r.todo)
      assert.doesNotMatch(r.ssh, /systemctl restart/)
    })

    it('--dropin instala también un drop-in nuevo', async () => {
      const r = await correr(['--dropin', 'noticias.conf'], {
        env: {
          STUB_PR_ABIERTO: '1',
          STUB_CI_SEQ: '2 0 0',
          STUB_DROPINS: 'llama.conf distinto\\nnoticias.conf nuevo\\n',
        },
      })
      assert.equal(r.status, 0, r.todo)
      assert.match(
        r.ssh,
        /install -D -m 644 \S+\/noticias\.conf \S+\/noticias\.conf/,
      )
    })

    it('con los drop-ins iguales no instala ni hace daemon-reload', async () => {
      const r = await correr([], {
        env: {
          STUB_PR_ABIERTO: '1',
          STUB_CI_SEQ: '2 0 0',
          STUB_DROPINS: 'llama.conf igual\\n',
        },
      })
      assert.equal(r.status, 0, r.todo)
      assert.ok(!sshLlamo(r, 'install -D') && !sshLlamo(r, 'daemon-reload'))
    })

    it('copia el chequeo de salud a /usr/local/bin si cambió: después de los drop-ins, antes del reinicio, sin reiniciar nada por eso', async () => {
      const r = await correr(['--sin-reinicio'], {
        env: {
          STUB_PR_ABIERTO: '1',
          STUB_CI_SEQ: '2 0 0',
          STUB_HC: 'instalado',
          STUB_NECESITA: 'no',
        },
      })
      assert.equal(r.status, 0, r.todo)
      assert.match(
        r.ssh,
        /install -m 755 \S+\/ops\/vps\/balancita-healthcheck\.sh \/usr\/local\/bin\/balancita-healthcheck\.sh/,
      )
      assert.match(
        r.ssh,
        /cmp -s \S+balancita-healthcheck\.sh \/usr\/local\/bin\/balancita-healthcheck\.sh/,
      )
      assert.ok(
        r.ssh.indexOf('git pull') < r.ssh.indexOf('balancita-healthcheck.sh'),
      )
      assert.ok(!sshLlamo(r, 'systemctl restart'))
      assert.match(
        r.out,
        /Chequeo de salud: instalado en \/usr\/local\/bin\/balancita-healthcheck\.sh/,
      )
    })

    it('con el chequeo de salud igual al instalado solo lo dice (el comando remoto copia solo si difiere)', async () => {
      const r = await correr([], {
        env: { STUB_PR_ABIERTO: '1', STUB_CI_SEQ: '2 0 0', STUB_HC: 'igual' },
      })
      assert.equal(r.status, 0, r.todo)
      assert.match(r.out, /Chequeo de salud: igual al instalado/)
    })

    it('si no se puede instalar el chequeo de salud aborta con código 5 antes de reiniciar', async () => {
      const r = await correr([], {
        env: { STUB_PR_ABIERTO: '1', STUB_CI_SEQ: '2 0 0', STUB_HC_FALLA: '1' },
      })
      assert.equal(r.status, 5, r.todo)
      assert.match(r.err, /no pude instalar el chequeo de salud/)
      assert.ok(!sshLlamo(r, 'systemctl restart'))
    })

    it('--dry-run no copia el chequeo de salud', async () => {
      const r = await correr(['--dry-run'], { env: { STUB_PR_ABIERTO: '1' } })
      assert.equal(r.status, 0, r.todo)
      assert.ok(!sshLlamo(r, 'balancita-healthcheck'))
    })

    it('git pull que no avanza rápido aborta con código 5 y sin reiniciar', async () => {
      const r = await correr([], {
        env: {
          STUB_PR_ABIERTO: '1',
          STUB_CI_SEQ: '2 0 0',
          STUB_PULL_FALLA: '1',
        },
      })
      assert.equal(r.status, 5, r.todo)
      assert.match(r.err, /git pull --ff-only falló en la VPS/)
      assert.ok(!sshLlamo(r, 'systemctl restart'))
    })

    it('ssh caído → reintenta y aborta con código 5 y el motivo', async () => {
      const r = await correr([], {
        env: {
          STUB_PR_ABIERTO: '1',
          STUB_CI_SEQ: '2 0 0',
          STUB_SSH_CAIDO: '1',
        },
      })
      assert.equal(r.status, 5, r.todo)
      assert.match(
        r.err,
        /no pude conectar por ssh a root@13\.140\.202\.221 \(4 intentos\)/,
      )
    })

    it('usa ssh en BatchMode contra la VPS configurada', async () => {
      const r = await correr([], {
        env: { STUB_PR_ABIERTO: '1', STUB_CI_SEQ: '2 0 0' },
      })
      assert.equal(r.status, 0, r.todo)
      const opciones = readFileSync(join(r.dir, 'ssh.opts'), 'utf8')
        .trim()
        .split('\n')
      assert.ok(opciones.length > 0)
      for (const o of opciones)
        assert.equal(
          o,
          '-o BatchMode=yes -o ConnectTimeout=15 root@13.140.202.221',
        )
    })

    it('idempotente: sin PR, main al día y servicio ya arrancado después del último commit → no hace nada', async () => {
      const r = await correr([], {
        env: {
          STUB_ADELANTE: '0',
          STUB_NECESITA: 'no',
          STUB_DROPINS: 'llama.conf igual\\n',
        },
      })
      assert.equal(r.status, 0, r.todo)
      assert.ok(!ghLlamo(r, 'pr create') && !ghLlamo(r, 'pr merge'))
      assert.ok(!sshLlamo(r, 'systemctl restart'))
      assert.match(r.out, /main ya contiene todo develop/)
      assert.match(r.out, /no hace falta reiniciar/)
    })

    it('opción desconocida o --dropin con ruta → código 2 sin llamar a nada', async () => {
      for (const args of [
        ['--nope'],
        ['--dropin', '../x.conf'],
        ['--dropin'],
      ]) {
        const r = await correr(args)
        assert.equal(r.status, 2, r.todo)
        assert.equal(r.gh, '')
        assert.equal(r.ssh, '')
      }
    })

    it('--ayuda imprime el uso y sale 0', async () => {
      const r = await correr(['--ayuda'])
      assert.equal(r.status, 0, r.todo)
      assert.match(r.out, /desplegar\.sh \[--dry-run\] \[--sin-reinicio\]/)
      assert.equal(r.gh, '')
    })
  })

  describe('desplegar.sh: chequeos posteriores', { concurrency: true }, () => {
    const base = { STUB_PR_ABIERTO: '1', STUB_CI_SEQ: '2 0 0' }
    for (const [nombre, env, mensaje] of [
      [
        'servicio no activo',
        { STUB_ACTIVO: 'failed' },
        /balancita no está active \(is-active dice 'failed'\)/,
      ],
      [
        'VmLck en 0',
        { STUB_LLAMA: 'pid=9 vmlck_kb=0 hilos5=si' },
        /VmLck 0 \(mlock no aplicado\)/,
      ],
      [
        'llama-server sin -t 5',
        { STUB_LLAMA: 'pid=9 vmlck_kb=4300000 hilos5=no' },
        /sin '-t 5'/,
      ],
      [
        'integridad corriendo tras el arranque',
        { STUB_INTEGRIDAD: 'node db-health-child integrity-check\n' },
        /chequeo de integridad corriendo justo después del arranque/,
      ],
      [
        'errores nuevos en qwen-live',
        { STUB_ERRORES: '1 maestro PF_XBTUSD timeout lento\n' },
        /errores nuevos en qwen-live\/live\.sqlite.*maestro/,
      ],
      [
        'Traceback en el journal',
        { STUB_TRACEBACKS: '3' },
        /3 línea\(s\) con Traceback/,
      ],
    ]) {
      it(`${nombre} → código 4 y el motivo`, async () => {
        const r = await correr([], {
          env: { ...base, ...env, DESPLIEGUE_LLAMA_SEG: '30' },
        })
        assert.equal(r.status, 4, r.todo)
        assert.match(r.err, mensaje)
        assert.match(r.err, /fallaron 1 chequeo\(s\) posteriores/)
      })
    }

    it('llama-server que todavía no aparece se espera y, si nunca aparece, falla', async () => {
      const r = await correr([], {
        env: { ...base, STUB_LLAMA: 'sin-proceso', DESPLIEGUE_LLAMA_SEG: '45' },
      })
      assert.equal(r.status, 4, r.todo)
      assert.match(r.err, /no hay proceso llama-server después de 45 s/)
      assert.match(r.out, /llama-server todavía no está corriendo/)
    })

    it('el comando de procesos no se encuentra a sí mismo (patrón [d]b-health-child y comm exacto)', async () => {
      const r = await correr([], { env: base })
      assert.equal(r.status, 0, r.todo)
      assert.match(r.ssh, /grep '\[d\]b-health-child\.\*integrity'/)
      assert.match(r.ssh, /\$2==\\"llama-server\\"|\$2=="llama-server"/)
    })
  })
})
