# Forward retirado (enmienda 2026-11-06)

El paper hacia delante de C25-C31 y Kronos deja de correr. Qué para, qué sigue y cómo volver atrás. Decisión del usuario («Apagalo y deja la enmienda»); el reglamento está en la enmienda 2026-11-06 del [ADR 0001](adr/0001-isolated-paper-futures-accounting.md).

## Qué se apaga

Un proceso hijo de `pnpm dev` (`scripts/dev-provider-env.mjs`):

| Hijo      | Escribe                                                                    | Qué era                                                             |
| --------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `forward` | `server/data/dev-live/forward/forward.sqlite` y `forward-reliability.json` | libros de paper hacia delante de las estrategias activas, cada hora |

Las bases **no se borran** ni se tocan: siguen en disco, el respaldo diario las sigue copiando y el Parquet nocturno las deja fuera por prefijo (`forward__`, motivo en `BASES_EXCLUIDAS`; sigue saliendo con código 0).

## Qué sigue corriendo

`vite`, `capture`, `positioning`, `live` (gateway), `carry`, `strategies`, `news`, `llm`, `qwenlive` (el trader) y, según su propio interruptor, `qwenexit`. El interruptor del motor D (`ENGINE_D_ENABLED`, `docs/motor-d-retirado.md`) es independiente. El proceso de Kronos nunca estuvo en el supervisor y no cambia.

## El interruptor

`FORWARD_ENABLED=1` (entorno real o `.env.local`) vuelve a arrancar `forward`. Sin la variable, con `0` o con cualquier otro valor queda retirado, también con `DEV_ONLY=…,forward,…`. No se borró código: reactivar es poner la variable y reiniciar `pnpm dev`. Al arrancar, `pnpm dev` imprime una línea `[dev] Forward retirado…`. Un `forward` viejo que haya quedado de una sesión anterior en este checkout lo cierra la limpieza de arranque, como siempre.

El lanzador le pasa al gateway `FUTURES_FORWARD_RETIRED=1|0` (siempre pisa un valor heredado).

## Qué ve cada lector

| Lector                                          | Con el forward retirado                                                                                                                                                    |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/observability/health`                 | Procesamiento y Estrategias: línea informativa `forward_retired` (ok); Ejecución paper «Sin datos» con «Forward retirado». Nunca error (ver `observabilidad-salud-api.md`) |
| `GET /api/observability/activity`               | `operations` `unavailable` con «Forward retirado…»; no abre la base (ver `observabilidad-actividad-api.md`)                                                                |
| Panel Observador (UI)                           | Muestra ese detalle en «Resultados» (ya renderiza `unavailable` como información, no como alerta); sin cambios de código                                                   |
| Chips de proceso de la Terminal / `/api/health` | `forward` ya no figura entre los procesos supervisados, así que no aparece como «caído»                                                                                    |
| Registro de estrategias (`strategies`)          | Sigue corriendo y lee `forward.sqlite` como historia: los resultados forward quedan congelados en la fecha del corte (ya no hay ciclos nuevos)                             |
| Kronos / C31                                    | Sin cambios en el lanzador: Kronos corre fuera del supervisor y C31 tiene su propio interruptor; sus filas de Estrategias siguen juzgadas por su resumen, como antes       |
| Parquet nocturno (`archivo_parquet.nocturno`)   | Sin cambios: `forward__` ya estaba en la lista de exclusión; código 0                                                                                                      |
