# VPS: respaldo diario, export Parquet y alertas

Copia versionada de lo que corre en el VPS (antes vivía solo allá). Si se cambia algo acá, hay que instalarlo en el VPS.

| Archivo                                    | Instalado en           | Qué hace                                                                                                                                                                                                                                                             |
| ------------------------------------------ | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `balancita-respaldo.sh`                    | `/usr/local/bin/`      | 04:30 Madrid: copia cada base de `server/data/dev-live` con `VACUUM INTO` + `integrity_check` a `/home/balancita/backups/AAAA-MM-DD` (7 días), después corre `archivo_parquet nocturno` sobre esas copias hacia `/home/balancita/parquet`, y avisa a healthchecks.io |
| `balancita-respaldo.service` / `.timer`    | `/etc/systemd/system/` | Programa el respaldo; lee `/etc/balancita/alert.env`                                                                                                                                                                                                                 |
| `balancita-healthcheck.sh`                 | `/usr/local/bin/`      | Cada 5 min: servicio, última vela, llama-server, disco y RAM → `HC_PING_URL`                                                                                                                                                                                         |
| `balancita-healthcheck.service` / `.timer` | `/etc/systemd/system/` | Programa el chequeo                                                                                                                                                                                                                                                  |

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
