# Motor D retirado (datos-útiles S7, T6)

El motor viejo D deja de capturar y calcular. Qué para, qué sigue y cómo volver atrás.

## Qué se apaga

Tres procesos hijos de `pnpm dev` (`scripts/dev-provider-env.mjs`):

| Hijo      | Escribe                                                          | Qué era                                    |
| --------- | ---------------------------------------------------------------- | ------------------------------------------ |
| `verdict` | `futures-verdicts.sqlite` (`paper_futures_verdicts`, 2,2 GB VPS) | verdict por producto y minuto (motor C/D)  |
| `scores`  | `futures-forecast-scores.sqlite`                                 | puntaje de pronósticos sobre esos verdicts |
| `q`       | `futures-llm-decisions.sqlite`                                   | decisiones LLM viejas (Qwen opinando)      |

`paper` (el libro D) ya estaba apagado antes. Las bases **no se borran**: siguen en disco, el respaldo del VPS las sigue copiando y el Parquet nocturno ya las archivó (último respaldo real: código 0).

## Qué sigue corriendo

`vite`, `capture`, `positioning`, `live` (gateway), `forward`, `carry`, `strategies`, `news`, **`llm`** (llama-server: lo usan las noticias, el resumen y el trader), **`qwenlive`** (el trader: maestro, portero y ciclo de vida de entradas y salidas) y `qwenexit` si su interruptor lo permite. Nada de eso lee `verdicts`, `llm_decisions` ni los puntajes.

## El interruptor

`ENGINE_D_ENABLED=1` (entorno real o `.env.local`) vuelve a arrancar `verdict`, `scores` y `q`. Sin la variable, con `0` o con cualquier otro valor, el motor D queda retirado. No se borró código: reactivar es poner la variable y reiniciar `pnpm dev`. Al arrancar, `pnpm dev` imprime una línea `[dev] Motor D retirado…`.

El lanzador le pasa al gateway `FUTURES_ENGINE_D_RETIRED=1|0` (siempre pisa un valor heredado).

## Qué ve cada lector

| Lector                                               | Con el motor D retirado                                                                                                                                    |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/observability/health`                      | Procesamiento `ok` sin pedir verdicts; Decisiones «Sin datos» con «Motor D retirado» (ver `observabilidad-salud-api.md`)                                   |
| `GET /api/observability/activity`                    | `evaluations`, `signals`, `discards` `unavailable` con «Motor D retirado»; `operations` igual (ver `observabilidad-actividad-api.md`)                      |
| Panel Observador (UI)                                | Muestra ese detalle por sección (ya renderiza `unavailable`); sin cambios de código                                                                        |
| Terminal (gateway, `paper-engine-follower`)          | Sin cambios: ya filtraba los verdicts de estrategias no aprobadas y el estado del motor ya era `idle`                                                      |
| `GET /api/qwen/scores`                               | Sin cambios: calcula sobre las bases viejas (historia); ninguna pantalla lo usa                                                                            |
| Registro de estrategias / Estrategias (`strategies`) | Sigue corriendo. Los backtests anclan su ventana en el verdict más nuevo: **quedan congelados en la fecha del corte** (siguen funcionando, sobre historia) |
| `forward`, `carry`, `news`, trader en vivo           | Sin cambios (no leen estas bases)                                                                                                                          |
| Parquet nocturno (`archivo_parquet.nocturno`)        | Sigue archivando las tres bases (ya sin filas nuevas); las copias existen mientras los archivos sigan; código 0                                            |

## Ahorro

No se midió en el VPS (prohibido consultar las bases vivas). Estimación con las cifras del propio repo: un verdict por producto y minuto, 8 productos ≈ 11 500 filas/día; con ~11 KB por fila son del orden de 90 a 130 MB/día de SQLite en `futures-verdicts` (la cuenta que da 2,2 GB acumulados), más WAL; `futures-forecast-scores` y `futures-llm-decisions` agregan algo menos. También se libera el CPU y la memoria de dos procesos Python (verdict calcula indicadores de 8 productos cada minuto) y de las lecturas del puntaje.

Lo que **no** baja todavía: el respaldo diario sigue copiando `futures-verdicts` (2,2 GB × 3 copias retenidas). Quitarlo del respaldo es decisión aparte (el Parquet nocturno exige una copia de cada base de su lista).
