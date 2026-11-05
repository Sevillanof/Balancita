# parquet-respaldo-completo

Que el archivo Parquet sea un respaldo que nunca quede incompleto en silencio, como base para habilitar más adelante el borrado seguro periódico de SQLite.
Esta fase cubre los pasos 1 y 2; el borrado sigue apagado.

## Specs

- **S1** — Los scripts y la programación del VPS (copia diaria a `/home/balancita/backups/AAAA-MM-DD`, 7 días; export `nocturno` a `/home/balancita/parquet`; respaldo fuera del VPS) quedan versionados en el repo, encadenados: el export arranca solo cuando la copia del día terminó y pasó `quick_check`, nunca por horario fijo.
- **S2** — Nunca más «copia muy nueva»: si el export no encuentra la copia del día lista, espera/reintenta dentro de una ventana y, si vence, falla con código ≠ 0 y una línea en `nocturno.jsonl` que lo dice.
- **S3** — Todo hueco cuenta como fallo (código ≠ 0 y aparece en `nocturno.jsonl`): base esperada sin copia (`sin_copias`), tablas de la copia que no están ni exportadas ni excluidas explícitamente, columnas nuevas no exportadas (`avisos`), `omitidos_por_retencion`, `reemplazos_omitidos`, archivos huérfanos, y cualquier excepción por base (la línea de resumen se escribe siempre).
- **S4** — Alerta: un `nocturno` con código ≠ 0, o sin línea nueva en `nocturno.jsonl` en 26 h, dispara la alerta que ya usa el respaldo diario del VPS.
- **S5** — La pantalla de salud muestra el estado del archivo (último `nocturno`: hora, estado, bases con problemas).

## Tasks

| ID  | Specs  | Ruta                                                                                                      | Estado                                    | Commit                     |
| --- | ------ | --------------------------------------------------------------------------------------------------------- | ----------------------------------------- | -------------------------- |
| T1  | S1     | parent: leer (solo lectura) scripts y programación actuales del VPS                                       | hecha                                     | —                          |
| T2  | S2-S3  | parent: `python/archivo_parquet/nocturno.py` + `test_archivo_parquet_nocturno.py` (8 tests nuevos) + docs | hecha                                     | — (lo commitea el usuario) |
| T3  | S1, S4 | parent: `ops/vps/` (scripts + units + README), `archivo_parquet/estado.py` + CLI `estado` + 7 tests       | hecha (falta instalar en el VPS: usuario) | —                          |
| T4  | S5     | gateway/salud + UI                                                                                        | pendiente                                 | —                          |

## Log

- **L1** (usuario, 2026-11-05): «Primero tenemos que estar seguros que parcel funciona perfectamente como backup, no puede estar incompleto nunca. Tenemos que lograr poder hacer ese borrado seguro cada cierto tiempo. Analiza como podemos hacerlo»
- **L2** (usuario, 2026-11-05): «Si a los dos» — aprueba pasos 1 y 2: (1) scripts del VPS en el repo encadenados; (2) todo hueco = fallo + alerta + salud.
- **L3** (evidencia): `nocturno` 05-nov 03:49 UTC salteó news, verdicts y positioning por «copia muy nueva» (copias 03:30), código 1; el 04-nov una segunda corrida 08:48 completó. Scripts del VPS no están en el repo. Regla del repo: el agente no hace commit ni push.
- **L4** (T2): nocturno espera copias que maduran (tope 1 h), y cuenta como fallo: sin_copias, bases_sin_cubrir (excepto qwen-live_cache__*), tablas_sin_cubrir, avisos, omitidos_por_retencion, reemplazos_omitidos, huérfanos y errores inesperados; la línea de nocturno.jsonl se escribe siempre. `pendientes_por_abrir` (períodos abiertos) no es hueco. Falla previa ajena: test_archivo_parquet_aislamiento detecta una copia del paquete en server/data/medicion-parquet (falla también sin estos cambios).
- **L5** (dry-run sobre copia VPS 05-nov): código 1. Bases sin cubrir: forward, futures-strategies, maker-costs, qwen-live auditor y live. Tablas sin cubrir: 16 de futures-market (official_candles, funding__, analytics__, ticker_snapshots…), 2 verdicts, 2 llm, 1 forecast, 1 positioning (collector_run), 5 news (briefings, errors, meta, polls, source_sets). Es la lista de trabajo del paso 4 (cobertura).
- **L6** (T1/T3): en el VPS el respaldo ya estaba encadenado (`balancita-respaldo.sh`: VACUUM INTO + integrity_check y después nocturno), pero el export corría a los pocos minutos de la última copia → «muy nueva» (regla de 5 min); con T2 ahora espera. No había alerta del respaldo: el healthcheck (cada 5 min, healthchecks.io) no lo miraba. Se agregó ping propio `HC_PING_URL_RESPALDO` (éxito / `/fail` con el motivo de `archivo_parquet estado`).
