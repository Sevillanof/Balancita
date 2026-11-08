# VPS: respaldo diario, export Parquet y alertas

Copia versionada de lo que corre en el VPS (antes vivía solo allá). Si se cambia algo acá, hay que instalarlo en el VPS.

| Archivo                                     | Instalado en                               | Qué hace                                                                                                                                                                                                                                                             |
| ------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `balancita-respaldo.sh`                     | `/usr/local/bin/`                          | 04:30 Madrid: copia cada base de `server/data/dev-live` con `VACUUM INTO` + `integrity_check` a `/home/balancita/backups/AAAA-MM-DD` (7 días), después corre `archivo_parquet nocturno` sobre esas copias hacia `/home/balancita/parquet`, y avisa a healthchecks.io |
| `balancita-respaldo.service` / `.timer`     | `/etc/systemd/system/`                     | Programa el respaldo; lee `/etc/balancita/alert.env`                                                                                                                                                                                                                 |
| `balancita-healthcheck.sh`                  | `/usr/local/bin/`                          | Cada 5 min: servicio, última vela, llama-server, disco y RAM → `HC_PING_URL`                                                                                                                                                                                         |
| `balancita-healthcheck.service` / `.timer`  | `/etc/systemd/system/`                     | Programa el chequeo                                                                                                                                                                                                                                                  |
| `systemd/balancita.service.d/llama.conf`    | `/etc/systemd/system/balancita.service.d/` | **Aplicado el 2026-11-07.** Drop-in de llama-server: 5 hilos (`LLAMA_THREADS`), `mlock` (`LLAMA_ARG_LOAD_MODE=mmap+mlock`) y `LimitMEMLOCK=infinity`                                                                                                                 |
| `swap-2g.sh`                                | `/usr/local/bin/`                          | **Aplicado el 2026-11-07.** Swap de 2 GB en `/swapfile` y `vm.swappiness=10`; se puede correr más de una vez                                                                                                                                                         |
| `systemd/balancita.service.d/noticias.conf` | `/etc/systemd/system/balancita.service.d/` | **Preparado, sin aplicar.** Drop-in de noticias en modo solo-ficha: `NEWS_CARDS=1`, `NEWS_LEGACY_QUESTIONS=0`, `NEWS_CARD_SCOPE=0`                                                                                                                                   |

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

Agregar `HC_PING_URL_RESPALDO=<url del chequeo nuevo>` a `/etc/balancita/alert.env` (no se versiona: tiene la URL secreta).

## Qwen en CPU: disco, hilos, mlock y swap (T8 de `odd/tasks/noticias-y-auditor.md`, S5)

Contexto y cifras: `analisis/vps-qwen-lento/informe.md`. El VPS no tiene GPU, así que Qwen no vuelve a los 0,4 s del Mac; esto quita la competencia por el disco.

### Ya va en el código (se aplica con el despliegue normal + reinicio de `balancita`)

- **`futures-market` fuera del respaldo interno de la app.** Lo copia cada noche `balancita-respaldo.timer` (03:30 UTC). El respaldo interno (`capture-main.ts`) sigue con las demás bases. Para volver a copiarla también desde la app: `Environment=FUTURES_DB_BACKUP_MARKET=1` (por defecto apagado). El panel «Salud del sistema» deja de listar `futures-market` en la copia diaria de la app.
- **Integridad cada 6 h con 45 min de margen** (antes cada 15 min y 10 min de margen). Se cambia con `FUTURES_DB_INTEGRITY_MINUTES` (por defecto 360) y `FUTURES_DB_INTEGRITY_TIMEOUT_MINUTES` (por defecto 45). El chequeo después de un despertar y el que se pide al ver «malformed» siguen igual.
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

## Noticias: ficha de Qwen en modo solo-ficha (T14 de `odd/tasks/noticias-y-auditor.md`, S7)

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

Borrar el drop-in y reiniciar; las filas escritas quedan como historia (solo-agregar) y nada se migra:

```
rm /etc/systemd/system/balancita.service.d/noticias.conf
systemctl daemon-reload && systemctl restart balancita
```

Para volver a las dos preguntas viejas conservando la ficha, dejar solo `Environment=NEWS_CARDS=1`; para apagar también la ficha, sacar las tres líneas. Las noticias que quedaron sin las dos preguntas viejas durante el modo solo-ficha no se las preguntan después de deshacer (fuera de la ventana de reintento se marcan `skipped_stale`), y `priority_v2` solo vuelve a ver noticias nuevas.
