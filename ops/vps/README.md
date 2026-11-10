# VPS: respaldo diario, export Parquet y alertas

Copia versionada de lo que corre en el VPS (antes vivía solo allá). Si se cambia algo acá, hay que instalarlo en el VPS.

| Archivo                                      | Instalado en                               | Qué hace                                                                                                                                                                                                                                                             |
| -------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `balancita-respaldo.sh`                      | `/usr/local/bin/`                          | 04:30 Madrid: copia cada base de `server/data/dev-live` con `VACUUM INTO` + `integrity_check` a `/home/balancita/backups/AAAA-MM-DD` (7 días), después corre `archivo_parquet nocturno` sobre esas copias hacia `/home/balancita/parquet`, y avisa a healthchecks.io |
| `balancita-respaldo.service` / `.timer`      | `/etc/systemd/system/`                     | Programa el respaldo; lee `/etc/balancita/alert.env`                                                                                                                                                                                                                 |
| `balancita-healthcheck.sh`                   | `/usr/local/bin/`                          | Cada 5 min: servicio, última vela, disco, RAM y, del operador, latido, miradas perdidas, posición sin valorar y reloj → `HC_PING_URL` (ver «Chequeo de salud» abajo). `desplegar.sh` lo instala solo                                                                 |
| `balancita-healthcheck.service` / `.timer`   | `/etc/systemd/system/`                     | Programa el chequeo                                                                                                                                                                                                                                                  |
| `systemd/balancita.service.d/llama.conf`     | `/etc/systemd/system/balancita.service.d/` | **Aplicado el 2026-11-07.** Drop-in de llama-server: 5 hilos (`LLAMA_THREADS`), `mlock` (`LLAMA_ARG_LOAD_MODE=mmap+mlock`) y `LimitMEMLOCK=infinity`                                                                                                                 |
| `desplegar.sh`                               | se corre desde el Mac, no se instala       | Despliegue único develop → main → VPS con verificaciones (ver «Desplegar» abajo)                                                                                                                                                                                     |
| `swap-2g.sh`                                 | `/usr/local/bin/`                          | **Aplicado el 2026-11-07.** Swap de 2 GB en `/swapfile` y `vm.swappiness=10`; se puede correr más de una vez                                                                                                                                                         |
| `systemd/balancita.service.d/noticias.conf`  | `/etc/systemd/system/balancita.service.d/` | **Preparado, sin aplicar.** Drop-in de noticias SIN IA: `NEWS_ENGINE=reglas` (el motor de reglas del backend; el modo solo-ficha de Qwen queda comentado para volver)                                                                                                |
| `systemd/balancita.service.d/sin-llama.conf` | `/etc/systemd/system/balancita.service.d/` | **Preparado, sin aplicar.** `DECISIONS_ENABLED=0`: el lanzador no arranca llama-server (ni `q` ni C31). Solo después de `noticias.conf`                                                                                                                              |

## Desplegar (`ops/vps/desplegar.sh`, S4 de `odd/tasks/operacion-mejoras.md`)

Un solo comando, desde el Mac y en el repo, que reproduce el despliegue que se hacía a mano. Si algo no cuadra corta con el motivo y un código de salida distinto de 0.

```
ops/vps/desplegar.sh --dry-run        # solo lecturas: cuenta gh, PR, ssh de prueba; no cambia nada
ops/vps/desplegar.sh                  # despliegue completo
ops/vps/desplegar.sh --sin-reinicio   # todo menos reiniciar (el reinicio queda pendiente y el script lo avisa)
ops/vps/desplegar.sh --dropin NOMBRE.conf     # instala un drop-in nuevo (si hay uno sin decidir, el script frena)
ops/vps/desplegar.sh --omitir NOMBRE.conf     # deja afuera, esta vez, un drop-in nuevo
```

Qué hace, en orden:

1. **gh con la cuenta Sevillanof**, solo dentro del script: `GH_TOKEN="$(gh auth token -u Sevillanof)"` exportado en el proceso, y chequea que `gh api user -q .login` sea `Sevillanof` (si no, aborta). No usa `gh auth switch`: la cuenta por defecto de gh en la máquina no cambia, y el token nunca se imprime.
2. **PR develop → main.** Reutiliza el abierto; si no hay y develop va adelantado lo crea; si main ya tiene todo develop, salta al paso de la VPS.
3. **Espera la CI** hasta 60 min (consulta cada 30 s, imprime una línea de estado cada 2 min). Mira los checks del último commit del PR y exige que existan corridas de **push y de pull_request**. Aborta (código 3) con `CONFLICTING`, cualquier check en `FAILURE`/`CANCELLED`/`TIMED_OUT`, «sin checks» pasados 10 min, o falta de uno de los dos conjuntos. Un 401 o 5xx transitorio de GitHub se reintenta 4 veces (5, 10, 15 s) y después aborta.
4. **Merge** (merge commit, sin borrar `develop`). Si el PR ya estaba mergeado, sigue.
5. **VPS** (`ssh -o BatchMode=yes root@13.140.202.221`): `cd /home/balancita/Balancita && sudo -u balancita git pull --ff-only`.
   5b. **Web:** la VPS sirve la web con `vite preview` desde `dist/`; si `dist/index.html` es más viejo que el último commit, corre `pnpm build` como balancita con `nice` (log en `/tmp/balancita-build.log`). Si falla, frena con código 5 sin reiniciar.
6. **Drop-ins** de `ops/vps/systemd/balancita.service.d/`: instala con `install -D -m 644` los que **difieren** de los instalados y hace `systemctl daemon-reload`. Un drop-in que está en el repo pero no en la VPS **no se instala solo ni se deja pasar**: el script frena (código 2) antes de instalar nada, hasta que se decida con `--dropin NOMBRE` (instalarlo) o `--omitir NOMBRE` (dejarlo afuera esta vez). Así no hay que acordarse.
   Después copia `ops/vps/balancita-healthcheck.sh` a `/usr/local/bin/` con `install -m 755` **solo si difiere** del instalado y lo anota (`Chequeo de salud: instalado…` / `…igual al instalado`); no reinicia nada por eso: el timer lanza el script de nuevo cada 5 min. Las unidades `.service` y `.timer` del chequeo **no** las toca el script (ver «Instalar»).
7. **Reinicio** de `balancita` solo si el servicio arrancó antes del último commit o drop-in, y **solo entre los minutos :16 y :27 UTC** (si está fuera de la ventana, espera). La ventana de la sección «Cuándo reiniciar» es :16-:28; el script usa :16-:27 para no acercarse a la mirada de :30.
8. **Chequeos posteriores** (a los 60 s del reinicio): `systemctl is-active` = `active`; llama-server con `VmLck` > 0 y `-t 5` (espera hasta 4 min a que aparezca); ningún `db-health-child … integrity` corriendo justo después del arranque; sin filas nuevas en la tabla `errors` de `server/data/dev-live/qwen-live/live.sqlite` (`id, at_ms, place, product, kind, detail`); sin líneas con `Traceback` en `journalctl -u balancita` desde el reinicio. Cualquier falla termina con código 4 y la lista; no se deshace nada solo (ver «Deshacer»).

Idempotente: tras un corte se puede volver a correr; lo ya hecho se salta y no reinicia si no hace falta.

Códigos de salida: 0 ok · 1 error general (por ejemplo cuenta gh equivocada) · 2 uso incorrecto · 3 PR/CI · 4 chequeos posteriores · 5 VPS (ssh, pull, drop-ins, reinicio). `ops/vps/desplegar.sh --ayuda` muestra el resumen.

### `gh` siempre con Sevillanof en este repo: `scripts/gh-sevillanof.sh`

Para comandos sueltos de `gh` (PR, CI, issues) sin cambiar la cuenta global:

```
scripts/gh-sevillanof.sh pr list --base main
scripts/gh-sevillanof.sh run list --branch develop --limit 5
source scripts/gh-sevillanof.sh && fijar_cuenta_sevillanof   # exporta GH_TOKEN solo en ese shell (así lo usa desplegar.sh)
```

Hace lo mismo que el script de despliegue: toma el token de Sevillanof, comprueba el login y recién entonces corre `gh` con los argumentos; si la cuenta no está guardada o el login no es Sevillanof, no corre nada.

### Pruebas

`scripts/desplegar.node-test.mjs` (corre en la CI con `node --test scripts/*.node-test.mjs`) ejecuta el script con `gh`, `ssh`, `date` y `sleep` falsos en un `PATH` temporal: no toca GitHub ni la VPS, y el reloj falso solo avanza con `sleep`. Cubre CI verde, rojo, conflicto, sin checks, tiempo agotado, 401/5xx, cuenta equivocada, ventana de reinicio, `--dry-run`, `--sin-reinicio`, drop-ins y cada chequeo posterior.

## Chequeo de salud (`balancita-healthcheck.sh`, S5 de `odd/tasks/operacion-mejoras.md`)

Corre cada 5 min como `balancita` (`balancita-healthcheck.timer`), siempre agrega una línea a `~/health.log` (últimas 2.000) y avisa a healthchecks.io con `HC_PING_URL` (de `/etc/balancita/alert.env`): ping de éxito si todo está bien, `<url>/fail` con el motivo corto en español si algo falla. El código de salida es 0 solo si todo está bien. Todo es de solo lectura (`sqlite3 -readonly`, consultas acotadas, espera de 2 s como máximo por base ocupada) y tarda menos de 1 s en condiciones normales (peor caso acotado: Kraken 3 s, llama-server 3 s, bases 2 s cada una).

| Chequeo                          | Falla cuando…                                                                                                                                                                                                                                                                            | Motivo en el `/fail`                                                       | Umbral (entorno, por defecto)                         |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------- |
| Servicio                         | `balancita.service` no está activo                                                                                                                                                                                                                                                       | `balancita.service no activo`                                              | —                                                     |
| Última vela 1m de ETH            | tiene 10 min o más, o no se pudo leer `futures-market.sqlite`                                                                                                                                                                                                                            | `ultima vela 1m ETH de hace N min`                                         | —                                                     |
| Disco / RAM                      | disco ≥ 80 % o RAM disponible < 500 MB                                                                                                                                                                                                                                                   | `disco al N%` / `RAM disponible N MB`                                      | —                                                     |
| **Latido del operador**          | la mirada más reciente (`max(t_ms)` de `decisions` y de `skipped` sin `proceso_detenido`) es más vieja que el umbral. El operador mira cada 15 min, así que 20 min = 1 retraso                                                                                                           | `operador sin latido (ultima mirada hace N min)`                           | `HC_LATIDO_MAX_MIN` = 20                              |
| **Miradas perdidas**             | hay ≥ umbral miradas distintas perdidas en la ventana: `skipped` con `proceso_detenido` en `live.sqlite` y/o filas de `miradas_perdidas` del auditor (una mirada cuenta una vez)                                                                                                         | `N miradas perdidas en la ultima hora`                                     | `HC_PERDIDAS_MIN` = 2, `HC_PERDIDAS_VENTANA_MIN` = 60 |
| **Posición abierta sin valorar** | la marca de valoración (`trades.mark_ms`, la última valoración con el libro; si nunca hubo, `opened_at_ms`) de una posición abierta es más vieja que el umbral. Si falla, el motivo del operador (`execution_error`, p. ej. `libro_no_disponible`, `libro_obsoleto`) va entre paréntesis | `posicion PF_ETHUSD #15 sin valorar hace N min (libro_obsoleto)`           | `HC_SIN_VALORAR_MAX_MIN` = 30                         |
| **Reloj de la VPS**              | `timedatectl show -p NTPSynchronized` dice `no`, o la diferencia contra la cabecera `Date` de `https://futures.kraken.com` pasa el umbral (positivo = VPS adelantada). Con la diferencia chica el libro se rechaza por «viejo» y el operador sigue «sano», por eso se mide               | `reloj de la VPS desfasado +N s` / `reloj de la VPS sin sincronizar (NTP)` | `HC_RELOJ_MAX_S` = 3                                  |

Detalles que conviene saber:

- **`live.sqlite` es obligatoria:** si falta o no se puede leer (bloqueada más de 2 s) falla con `no existe live.sqlite del operador` / `no se pudo leer live.sqlite del operador`. Las demás bases no: sin `auditor.sqlite` (o con una vieja sin la tabla `miradas_perdidas`) o bloqueada, esa parte cuenta 0 y no falla; si falta `futures-market.sqlite` falla solo por la vela, como antes.
- **Qwen ya no falla el ping.** `llama-server /health` caído solo queda en el log (`llama=caido`): Qwen no afecta al paper (auditoría 4.3).
- **Sin medida no hay alarma de reloj:** si Kraken no contesta, o no hay `timedatectl`, se usa lo que sí hay (`reloj_s=NA` / `ntp=NA` en el log); falla solo con una diferencia medida fuera del umbral o con NTP en `no`.
- **Una reiniciada también cuenta.** Reiniciar `balancita` fuera de la ventana :16-:28 deja una fila `proceso_detenido` por mirada saltada: con 2 o más se avisa durante la hora siguiente (con 1 no). Es lo esperado: el despliegue reinicia dentro de la ventana para no cruzar ninguna.
- **Línea del log:** `AAAA-MM-DDTHH:MM:SSZ OK|FALLA vela_eth_edad_min= latido_min= perdidas_1h= sin_valorar_min= reloj_s= ntp= llama= disco= ram_disp_mb= <motivos separados por «;»>`.
- Rutas y comandos configurables solo para pruebas: `HC_DATA_DIR`, `HC_LOG`, `HC_DISK_PATH`, `HC_LLAMA_URL`, `HC_KRAKEN_URL`, `HC_SQLITE_TIMEOUT_MS`.

Los umbrales se cambian con un `Environment=` en un drop-in del servicio (`systemctl edit balancita-healthcheck.service`) o agregando la variable a `/etc/balancita/alert.env` (el mismo archivo que ya lee la unidad; no se versiona).

### Instalar el chequeo (o actualizarlo)

`ops/vps/desplegar.sh` copia el script solo (paso 6). A mano, como root en la VPS después de `git pull`:

```
cd /home/balancita/Balancita/ops/vps
install -m 755 balancita-healthcheck.sh /usr/local/bin/
systemctl restart balancita-healthcheck.timer      # solo si cambiaron las unidades .service/.timer (con install -m 644 y daemon-reload antes)
systemctl start balancita-healthcheck.service      # prueba inmediata; el resultado queda en ~balancita/health.log
tail -n 3 /home/balancita/health.log
```

El script se ejecuta de nuevo en cada corrida del timer, así que con solo copiarlo alcanza; no hay que reiniciar `balancita`. La primera corrida puede dar `FALLA` si en la última hora hubo 2 o más miradas perdidas: se limpia sola al pasar la hora.

### Pruebas del chequeo

`scripts/healthcheck.node-test.mjs` (corre en la CI con `node --test scripts/*.node-test.mjs`; necesita el binario `sqlite3`) crea bases sqlite reales en un directorio temporal con el esquema de `futures_qwen_live.py` y `futures_auditor.py`, y pone `systemctl`, `curl`, `timedatectl`, `df` y `free` falsos en el `PATH`: no toca la VPS ni la red. Cubre cada chequeo en bien y en falla y en el borde del umbral, los umbrales cambiados por entorno, Qwen caído (el ping sigue siendo de éxito), `live.sqlite` ausente o bloqueada, auditor ausente o bloqueado, varios fallos juntos, que los chequeos de antes sigan igual y que el ping y el log salgan como siempre.

## Alerta del respaldo

`HC_PING_URL_RESPALDO` en `/etc/balancita/alert.env` (un chequeo aparte en healthchecks.io, período 1 día y gracia 2 h):

- respaldo y Parquet completos → ping de éxito;
- cualquier fallo (copia, `integrity_check` o Parquet incompleto: código 1 de `nocturno`) → `/fail` con el motivo que da `python -m archivo_parquet estado`;
- si no corre → healthchecks.io avisa al vencer el período.

Mientras el Parquet no cubra todas las bases y tablas (ver `odd/tasks/parquet-respaldo-completo.md`), este chequeo va a quedar en falla: es correcto, el respaldo Parquet está incompleto.

## Instalar (como root en el VPS, después de `git pull`)

```
cd /home/balancita/Balancita/ops/vps
install -m 755 balancita-respaldo.sh balancita-healthcheck.sh /usr/local/bin/
install -m 644 balancita-respaldo.service balancita-respaldo.timer balancita-healthcheck.service balancita-healthcheck.timer /etc/systemd/system/
systemctl daemon-reload
```

(Para solo el chequeo de salud, ver «Instalar el chequeo» arriba: `desplegar.sh` instala `balancita-healthcheck.sh` pero **no** las unidades `.service`/`.timer`; si cambian, se copian a mano como en este bloque.)

Agregar `HC_PING_URL_RESPALDO=<url del chequeo nuevo>` a `/etc/balancita/alert.env` (no se versiona: tiene la URL secreta).

## Qwen en CPU: disco, hilos, mlock y swap (T8 de `odd/tasks/noticias-y-auditor.md`, S5)

Contexto y cifras: `analisis/vps-qwen-lento/informe.md`. El VPS no tiene GPU, así que Qwen no vuelve a los 0,4 s del Mac; esto quita la competencia por el disco.

### Ya va en el código (se aplica con el despliegue normal + reinicio de `balancita`)

- **`futures-market` fuera del respaldo interno de la app.** Lo copia cada noche `balancita-respaldo.timer` (03:30 UTC). El respaldo interno (`capture-main.ts`) sigue con las demás bases. Para volver a copiarla también desde la app: `Environment=FUTURES_DB_BACKUP_MARKET=1` (por defecto apagado). El panel «Salud del sistema» deja de listar `futures-market` en la copia diaria de la app.
- **Integridad cada 6 h con 45 min de margen** (antes cada 15 min y 10 min de margen). Se cambia con `FUTURES_DB_INTEGRITY_MINUTES` (por defecto 360) y `FUTURES_DB_INTEGRITY_TIMEOUT_MINUTES` (por defecto 45). El primero tras arrancar espera 60 min (`FUTURES_DB_INTEGRITY_FIRST_DELAY_MINUTES`, antes 2 min), para no saturar el disco mientras Qwen arranca. El chequeo después de un despertar y el que se pide al ver «malformed» siguen igual.
- **`nice -n 19 ionice -c3`** para los procesos hijos de salud y respaldo de la app, solo en Linux y si `nice` e `ionice` están instalados; si no, arrancan como antes.

### Paso 2, preparado y SIN aplicar: drop-in de llama-server y swap

Como root en el VPS, después de `git pull`:

```
cd /home/balancita/Balancita/ops/vps
install -D -m 644 systemd/balancita.service.d/llama.conf /etc/systemd/system/balancita.service.d/llama.conf
install -m 755 swap-2g.sh /usr/local/bin/
/usr/local/bin/swap-2g.sh          # swap de 2 GB + vm.swappiness=10 (no reinicia nada)
systemctl daemon-reload
systemctl restart balancita        # reinicia TODO el stack, ver «Cuándo reiniciar»
```

`llama.conf` pone `LLAMA_THREADS=5` (el lanzador, `scripts/dev-provider-env.mjs`, lo pasa como `-t 5`), `LLAMA_ARG_LOAD_MODE=mmap+mlock` (este llama-server no tiene `--mlock` sino `--load-mode`; `LLAMA_ARG_MLOCK` no existe y se ignora; el lanzador le pasa el entorno entero) y `LimitMEMLOCK=infinity`. Un solo reinicio aplica los dos.

**Cuándo reiniciar:** entre los minutos :16 y :28 de cada hora, para no cruzar una mirada de :00/:15/:30/:45; si se cruza queda una fila `proceso_detenido`.

**Deshacer:** borrar el drop-in (`/etc/systemd/system/balancita.service.d/llama.conf`), `systemctl daemon-reload && systemctl restart balancita`. El swap se saca con `swapoff /swapfile`, borrando su línea de `/etc/fstab` y `/etc/sysctl.d/99-balancita.conf`.

### Medir antes y después (sin tocar al trader)

No mandar un `curl` de prueba a llama-server: tomaría un slot y desalojaría la caché de prompt del trader. Se mide del journal, con la misma llamada de 84 tokens de entrada (hoy ~16 s con la máquina ocupada; mejor marca 4 s):

```
journalctl -u balancita --since "<hora>" | grep 'prompt eval time'
```

Calcular tokens/s de entrada por hora (mediana y p90) en las 6 h anteriores y en las 6 h posteriores al despliegue, y comparar. Además, después del reinicio:

- `grep VmLck /proc/$(pgrep -f llama-server | head -1)/status` debe dejar de dar 0 (el `mlock` quedó aplicado);
- `swapon --show` y `sysctl vm.swappiness` (2 GB y 10); vigilar `vmstat 5` (`si`/`so` cerca de 0);
- `iostat -x 5` (lecturas/s de `sda`) y `/proc/pressure/io` (`full avg10`; hoy 35 %);
- `health.jsonl` y `retention.jsonl` de `server/data/dev-live`: la retención debe volver a terminar sus ciclos y la integridad ya no debe aparecer cortada.

## Noticias sin IA y llama-server apagado (T18 y T19 de `odd/tasks/noticias-y-auditor.md`, S10)

Decisión del usuario (L26): «tenemos que hacerlo sin una IA, solo BE que catalogue cada noticia entre alcista, bajista e importante». El proceso de noticias cataloga con reglas fijas (`python/balancita_engine/futures_news_reglas.py`, léxico en `config/noticias-reglas.json`): sin Qwen, sin Haiku, sin ningún modelo, sin llama-server. Detalle del léxico, de las reglas y de cómo se mide: `docs/medir-noticias.md`. **Esto está PREPARADO y SIN APLICAR: nada de esta sección se corrió en la VPS.**

Son dos pasos, en este orden y con un reinicio cada uno (`systemctl restart balancita` reinicia TODO el stack: ver «Cuándo reiniciar» arriba; o `ops/vps/desplegar.sh --dropin NOMBRE.conf`, que lo hace en la ventana segura y con chequeos).

### Paso 1: motor de reglas (`noticias.conf`)

El motor de reglas es el valor por defecto del código (`NEWS_ENGINE` vacío = `reglas`) y el lanzador deja de pasar `--analyze` al proceso de noticias aunque llama-server esté encendido. Por eso el código nuevo ya cambia el motor al desplegarse; `noticias.conf` solo lo deja explícito y documenta cómo volver.

```
cd /home/balancita/Balancita/ops/vps
install -D -m 644 systemd/balancita.service.d/noticias.conf /etc/systemd/system/balancita.service.d/noticias.conf
systemctl daemon-reload
systemctl show balancita -p Environment | tr ' ' '\n' | grep NEWS_    # NEWS_ENGINE=reglas
systemctl restart balancita
```

Después del reinicio (la base no se toca; las fichas nuevas son `card_version` 3 y las de Qwen, versión 1, quedan intactas):

```
journalctl -u balancita --since "10 min ago" | grep -E "news writing|news: ingested"     # «analysis rules engine noticias-reglas.v1 (no model)» y «cards N»
sqlite3 -readonly server/data/dev-live/futures-news.sqlite \
  "SELECT card_version, status, count(*) FROM paper_futures_news_cards GROUP BY 1,2"       # la versión 3 cubre todas las noticias
sqlite3 -readonly server/data/dev-live/futures-news.sqlite \
  "SELECT count(*) FROM paper_futures_news_items i WHERE NOT EXISTS (SELECT 1 FROM paper_futures_news_cards c WHERE c.item_hash=i.item_hash AND c.card_version=3)"   # 0
sqlite3 -readonly server/data/dev-live/futures-news.sqlite \
  "SELECT status, reason FROM paper_futures_news_briefings ORDER BY briefing_id DESC LIMIT 1"   # off|news_engine_reglas
```

En la Terminal, la tarjeta de noticias muestra el panorama «Lo más importante · 6 h» (las 3 de mayor importancia de las últimas 6 h, con su flecha de dirección) en lugar del resumen de Qwen.

**Deshacer el paso 1** (volver al motor de Qwen): como el motor de reglas es el valor por defecto, borrar el drop-in NO basta. Hay que pedir Qwen y tener llama-server encendido (sin `sin-llama.conf`):

```
printf '[Service]\nEnvironment=NEWS_ENGINE=qwen\nEnvironment=NEWS_CARDS=1\nEnvironment=NEWS_LEGACY_QUESTIONS=0\nEnvironment=NEWS_CARD_SCOPE=0\n' > /etc/systemd/system/balancita.service.d/noticias.conf
systemctl daemon-reload && systemctl restart balancita
```

Las fichas de reglas ya escritas quedan (solo-agregar) y los lectores toman siempre la versión más nueva de cada noticia: con Qwen de vuelta, las noticias que ya tienen ficha 3 siguen mostrando la de reglas; solo las nuevas reciben la de Qwen en la versión 1, que queda **debajo** de la 3 para las ya catalogadas. Si hace falta que Qwen mande otra vez, es una decisión aparte (otra `card_version`).

### Paso 2: apagar llama-server (`sin-llama.conf`, T19)

Solo cuando el paso 1 lleve un rato catalogando bien (consultas de arriba). Con `DECISIONS_ENABLED=0` el lanzador (`resolveLlamaServer`) no devuelve comando de llama-server, así que no arrancan `llm`, `q` (motor D, ya retirado) ni `qwenexit` (C31, ya apagada por su bloque `off`). Siguen: captura, gateway, noticias (reglas) y `qwenlive`.

**Qué de lo que opera depende de llama-server: nada** (comprobado en el código y en `scripts/dev.node-test.mjs`): el trader de la Terminal decide por fórmula (`decide_by: formula`: maestro y portero) y tiene la opinión del modelo apagada (`opinion_enabled: false` y `runtime.opinion_enabled: false` en `config/qwen-live.json` y en la config activa `config/terminal-activa.json`); con eso `qwenlive` ni siquiera pregunta `/health` (`_check_model` vuelve antes) y arranca aunque no haya llm (`readQwenNewsOnly`). `priority_v2`, la única vía noticia → operación, lee las respuestas viejas (`news_relevance_btc` y `news_direction` v2), que ya no se escriben desde T14: sigue inerte y no lee las fichas, ni las de Qwen ni las de reglas. El chequeo de salud (`balancita-healthcheck.sh`) ya solo anota `llama=caido` sin fallar el ping.

```
cd /home/balancita/Balancita/ops/vps
install -D -m 644 systemd/balancita.service.d/sin-llama.conf /etc/systemd/system/balancita.service.d/sin-llama.conf
systemctl daemon-reload
systemctl show balancita -p Environment | tr ' ' '\n' | grep DECISIONS_ENABLED    # DECISIONS_ENABLED=0
systemctl restart balancita        # en la ventana :16-:28 (ver «Cuándo reiniciar»)
```

`ops/vps/desplegar.sh` entiende este estado: con `DECISIONS_ENABLED=0` en el servicio exige que NO haya proceso llama-server (en vez de `VmLck` y `-t 5`). Medir después (nada de `curl` a llama-server):

```
pgrep -x llama-server || echo "apagado"                      # apagado
free -m                                                      # ~6 GB más de memoria libre que con llama-server (RSS de 6,2-6,5 GB, 4,17 GB con mlock)
systemctl is-active balancita                                # active
journalctl -u balancita --since "30 min ago" | grep -c Traceback    # 0
tail -3 ~/health.log                                         # OK (llama=caido es lo esperado)
sqlite3 -readonly server/data/dev-live/qwen-live/live.sqlite "SELECT count(*), max(at_ms) FROM errors WHERE at_ms > strftime('%s','now','-1 hour')*1000"
```

Y comprobar que las miradas del trader siguen cada 15 min y las noticias nuevas reciben su ficha 3.

**Deshacer el paso 2:** `rm /etc/systemd/system/balancita.service.d/sin-llama.conf && systemctl daemon-reload && systemctl restart balancita`. llama-server vuelve a arrancar (`llama.conf` sigue aplicado: 5 hilos y mlock). Con el modelo en el disco no hay nada que reinstalar. Cuando el paso 2 esté confirmado se pueden sacar `llama.conf` y `swap-2g.sh` (decisión aparte).

## Noticias con Qwen: ficha en modo solo-ficha (T14 de `odd/tasks/noticias-y-auditor.md`, S7) — reemplazado por las reglas

> Desde S10 esto solo corre con `NEWS_ENGINE=qwen` (ver arriba): el motor por defecto es el de reglas, sin modelo. Se conserva para poder volver. Con `NEWS_ENGINE=qwen`, `NEWS_CARDS` y las otras dos variables funcionan como se describe aquí.

Autorizado por el usuario en L17 («Si, pasala a la VPS»). Detalle de las preguntas, de quién lee qué y de lo que cambia: `docs/medir-noticias.md`. Son tres variables del proceso de noticias, que el lanzador hereda del servicio:

| Variable                  | Con el valor del drop-in                                   | Sin definir / vacía         |
| ------------------------- | ---------------------------------------------------------- | --------------------------- |
| `NEWS_CARDS=1`            | pide la ficha (tipo, fuerza 0-3, dirección, alcance)       | apagada                     |
| `NEWS_LEGACY_QUESTIONS=0` | no pregunta `news_relevance_btc` v2 ni `news_direction` v2 | las pregunta (como hoy)     |
| `NEWS_CARD_SCOPE=0`       | no pregunta alcance / «ya pasó» (3 preguntas por noticia)  | la pregunta (4 por noticia) |

`NEWS_LEGACY_QUESTIONS=0` sin `NEWS_CARDS=1` y con Qwen encendido es un error de configuración (el proceso de noticias sale con «configuration error»): no se queda sin analizar en silencio. También existen `--no-legacy-questions` y `--no-card-scope`. Los valores `0`, `false`, `no` y `off` apagan; cualquier otro (o vacío) deja el valor por defecto.

### Antes de instalar (hace falta saber)

- Costo: son 3 preguntas (tipo ~320 tokens, fuerza ~269, dirección ~98) y un recap sale tras la primera. Proyección del informe (`analisis/qwen-preguntas/informe.md`, no medida en la VPS): ~31 s por noticia a 20,7 tok/s y ~150 s a 4,2 tok/s, contra ~13 s / ~59 s de las dos preguntas de hoy. Con ~92 noticias por día cabe, pero el ciclo de noticias queda ocupado mientras pregunta (el presupuesto por ciclo sigue siendo `--max-analyses-per-poll`, 20 llamadas).
- Las filas viejas y sus consumidores: `priority_v2` (config `terminal-activa.json`) deja de tener noticias para leer; hoy nunca disparó (0 de 404 noticias con relevancia `high`). El trader no cambia de decisión por esto; ver «Quién lee las preguntas viejas» en `docs/medir-noticias.md`.

### Instalar (como root en el VPS, después de `git pull`)

```
cd /home/balancita/Balancita/ops/vps
install -D -m 644 systemd/balancita.service.d/noticias.conf /etc/systemd/system/balancita.service.d/noticias.conf
systemctl daemon-reload
systemctl show balancita -p Environment | tr ' ' '\n' | grep NEWS_    # las tres variables
systemctl restart balancita        # reinicia TODO el stack, ver «Cuándo reiniciar» arriba
```

Si se instala junto con `llama.conf`, un solo `restart` aplica los dos. Después del reinicio (la base de noticias no se toca; la tabla de fichas se crea sola):

```
journalctl -u balancita --since "10 min ago" | grep -E "news writing|news: ingested"     # «analysis on (card:news_card_type,...)» y «cards N»
sqlite3 -readonly server/data/dev-live/futures-news.sqlite \
  "SELECT status, count(*), sum(scope IS NULL) FROM paper_futures_news_cards GROUP BY 1"
sqlite3 -readonly server/data/dev-live/futures-news.sqlite \
  "SELECT question_id, count(*) FROM paper_futures_news_analysis WHERE analyzed_at > strftime('%s','now','-1 hour')*1000 GROUP BY 1"
```

Deben aparecer solo `news_card_type`, `news_card_strength` y `news_card_direction` entre las respuestas nuevas, y las fichas con `scope` nulo.

### Deshacer

Con `NEWS_ENGINE=qwen`: quitar `NEWS_LEGACY_QUESTIONS`/`NEWS_CARD_SCOPE`/`NEWS_CARDS` del drop-in y reiniciar; las filas escritas quedan como historia (solo-agregar) y nada se migra. Para volver a las dos preguntas viejas conservando la ficha, dejar solo `Environment=NEWS_CARDS=1`; para apagar también la ficha, sacar las tres líneas. Las noticias que quedaron sin las dos preguntas viejas durante el modo solo-ficha no se las preguntan después de deshacer (fuera de la ventana de reintento se marcan `skipped_stale`), y `priority_v2` solo vuelve a ver noticias nuevas.
