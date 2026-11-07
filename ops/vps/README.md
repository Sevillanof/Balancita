# VPS: respaldo diario, export Parquet y alertas

Copia versionada de lo que corre en el VPS (antes vivía solo allá). Si se cambia algo acá, hay que instalarlo en el VPS.

| Archivo                                    | Instalado en                               | Qué hace                                                                                                                                                                                                                                                             |
| ------------------------------------------ | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `balancita-respaldo.sh`                    | `/usr/local/bin/`                          | 04:30 Madrid: copia cada base de `server/data/dev-live` con `VACUUM INTO` + `integrity_check` a `/home/balancita/backups/AAAA-MM-DD` (7 días), después corre `archivo_parquet nocturno` sobre esas copias hacia `/home/balancita/parquet`, y avisa a healthchecks.io |
| `balancita-respaldo.service` / `.timer`    | `/etc/systemd/system/`                     | Programa el respaldo; lee `/etc/balancita/alert.env`                                                                                                                                                                                                                 |
| `balancita-healthcheck.sh`                 | `/usr/local/bin/`                          | Cada 5 min: servicio, última vela, llama-server, disco y RAM → `HC_PING_URL`                                                                                                                                                                                         |
| `balancita-healthcheck.service` / `.timer` | `/etc/systemd/system/`                     | Programa el chequeo                                                                                                                                                                                                                                                  |
| `systemd/balancita.service.d/llama.conf`   | `/etc/systemd/system/balancita.service.d/` | **Aplicado el 2026-11-07.** Drop-in de llama-server: 5 hilos (`LLAMA_THREADS`), `mlock` (`LLAMA_ARG_LOAD_MODE=mmap+mlock`) y `LimitMEMLOCK=infinity`                                                                                                                 |
| `swap-2g.sh`                               | `/usr/local/bin/`                          | **Aplicado el 2026-11-07.** Swap de 2 GB en `/swapfile` y `vm.swappiness=10`; se puede correr más de una vez                                                                                                                                                         |

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
