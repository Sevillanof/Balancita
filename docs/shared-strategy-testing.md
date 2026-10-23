# Alcance de las pruebas compartidas

**Una prueba determinista nueva del gate es `baseline_only`, aunque diga PASA.**
Mide el libro independiente de 100 USD fijos por operación; no reproduce las
confirmaciones/vetos OPEN de Qwen ni valida la política completa. Las señales,
salidas y umbrales estadísticos existentes no cambian. Los tramos temporales
nuevos sí purgan cruces y aplican el embargo heredado, como se detalla abajo.

## Consultar antes de empezar

`GET /api-strategies/strategies/{id}/gate/preflight`

Devuelve `strategy_id`, `spec_hash`, `evaluation_mode`, `supported_modes` y
`evaluation_policy`. El único modo admitido es `baseline_only`; se puede indicar
con `?evaluation_mode=baseline_only`. La identidad usa el spec de configuración
si existe y, si no, la última versión no borrada del registro, igual que el gate.
No descarga datos, lee resultados, requiere informes antiguos, crea una DB,
reserva capacidad, cuenta intentos ni consume el examen. No garantiza que haya
datos suficientes o que un examen esté disponible.

## Empezar y consultar resultados

El POST existente `.../strategies/{id}/gate` sigue admitiendo `from`, `to`,
`products` y `exam`. Omitir `evaluation_mode` equivale a `baseline_only`.
`full_policy`, un modo desconocido o un valor mal formado responde 400
(`unsupported_evaluation_mode`) antes de lanzar un proceso. No se admiten campos
de certificación enviados por el cliente. La CLI admite
`evaluate --evaluation-mode baseline_only` y rechaza los demás modos antes de
leer datos o crear la DB.

`evaluation_policy` tiene este contrato versionado:

| Campo | Corrida determinista nueva |
| --- | --- |
| `schema` | `balancita.strategy-evaluation-policy.v1` |
| `classification` | `baseline_only` |
| `account_scope` | `independent_fixed_notional` |
| `notional_per_trade_usd` | `"100"` |
| `qwen_open_decisions_replayed` | `false` |
| `full_policy_validated` | `false` (nunca se certifica en esta entrega) |
| `reasons` | `deterministic_book_only`, `qwen_open_not_replayed`, `full_policy_not_supported` |

El productor lo guarda en `runs.params.evaluation_policy` desde el inicio y en
el `summary` del artefacto al terminar; también aparece en la respuesta de inicio,
listas/estado, resultado Python, evento JSON final de CLI e informe descargable.
Si el inicio sigue `pending`, el alcance anunciado es el previsto; al obtener el
estado manda el metadato guardado por el productor.

## Límites y compatibilidad

- Una corrida antigua sin metadatos sigue `unclassified`, con motivo
  `missing_evaluation_policy`; un payload inválido/desconocido usa
  `invalid_evaluation_policy`. No se reescribe ni se infiere desde el spec actual.
  El alcance de cuenta, nocional y replay Qwen quedan `null`.
- Qwen/Kronos conservan su camino de operaciones ya registradas, sin llamadas a
  modelos. Su alcance queda `unclassified`, con motivo
  `recorded_model_trades_not_policy_replay`: no es un replay determinista del libro.
- La clasificación no sustituye PASA/NO PASA ni demuestra rentabilidad, funding
  completo, separación temporal, procedencia auditable o permiso de activación.
  La contabilidad y la separación de tramos se describen abajo; su presentación
  en Testear y los demás contratos quedan para las entregas siguientes.

## Contabilidad: observado no significa definitivo

Las corridas nuevas añaden `accounting`, con esquema
`balancita.strategy-gate-accounting.v1`. **No cambia la liquidación del libro,
la población estadística ni el mínimo agregado de funding del 95 %.**
PASA puede coexistir con un neto provisional: la elegibilidad por conteo no
certifica cada importe ni el total. `evaluation_policy` sigue siendo independiente.

### Por operación

El mismo objeto `accounting` aparece en las operaciones compactas del resultado
Python, las operaciones del artefacto/API y `costs.accounting` de la traza.

| Campos | Contrato |
| --- | --- |
| `schema`, `state`, `reasons` | Esquema anterior; estado `complete`, `provisional` o `unclassified`; códigos de evidencia ausente/inválida. |
| `observed_net_usd`, `observed_net_bp` | Copias numéricas finitas de `pnl_usd` y `net_bp`; `null` si la evidencia es inválida/ausente. No se reconstruye el neto. |
| `definitive_net_usd`, `definitive_net_bp` | Mismos importes, solo con evidencia completa de funding, costes y neto; de lo contrario `null`. |
| `funding_evidence` | `complete`, `partial`, `unknown`, `unclassified` (flags ausentes/antiguos) o `invalid`. |
| `cost_evidence`, `cost_model_version` | `complete` solo para operaciones recién producidas por `Book`, con campos numéricos válidos y su identidad de costes; `invalid` si esos campos fallan; sin identidad, `unclassified` y versión `null`. |
| `funding_bp` | Importe observado con su signo, relativo al nocional; `null` si falta o es inválido. Un cero medido sigue siendo `0`. |
| `funding_covered_ms`, `funding_held_ms` | Duraciones registradas, separadas del conteo de operaciones; `null` si faltan o son inválidas. |
| `funding_time_share` | Cubierto/retenido para evidencia temporal conocida; `null` si es desconocida, no clasificable, inválida o no hay duración positiva. |

Funding definitivo exige importe finito, `funding_status=complete`,
`funding_complete=true` y duración cubierta igual a la retenida. Un importe
parcial conserva su signo, pero no certifica neto. Long/short no vuelve a invertir
el funding ya liquidado. La ejecución adversa ya está en el gross del libro:
no se vuelve a descontar ejecución, comisiones ni funding.

**Compatibilidad:** `net_bp`, `pnl_usd` y `costs.net_usd/net_bp` conservan su
valor numérico observado; queda obsoleta su interpretación como neto definitivo.
El `funding_bp` compacto pasa a ser nullable; `observed_funding_bp` conserva
explícitamente el adaptador histórico (importe observado o cero solo para la
comparación estadística sin funding). No es evidencia de funding completo.
Las operaciones completas también conservan `funding_complete` en el artefacto.

### Por corrida y API

El productor guarda el resumen en `result.accounting`, `runs.params.accounting`
y `manifest.summary.accounting`. Se copia a `run_summary`, al resultado Python,
al evento JSON final de CLI y al informe en español. Listas/estado exponen
`run.accounting`; `visual-summary` expone además `summary.accounting`. El estado
no depende de que se haya podido guardar el artefacto.

| Campos del resumen | Contrato |
| --- | --- |
| `schema`, `state`, `scope` | Esquema anterior; `complete`, `provisional`, `unclassified`, `no_trades` o `censored`; alcance `closed_trades_only`. |
| `metric_population` | `all_observed_closed_trades`: no excluye operaciones incompletas de medias, intervalos, drawdown, controles ni reglas. |
| `closed_trades`, `open_at_end` | Conteos separados; una abierta al corte no se liquida artificialmente. |
| `definitive_trades`, `provisional_trades` | Cerradas con evidencia completa y resto de cerradas, respectivamente. El resto puede incluir no clasificadas. |
| `observed_net_usd`, `observed_net_bp` | Sumas observadas de todas las cerradas; `null` sin operaciones o si falta algún importe. Los bp sumados no son retorno sobre capital compartido. |
| `definitive_net_usd`, `definitive_net_bp` | Totales solo si todas las cerradas son definitivas y no hay abiertas al corte; de otro modo `null`. No se ofrece un subtotal como si fuera el total. |
| `funding_complete_count`, `funding_complete_share` | Conteo de estados declarados `complete` y fracción sobre **todas** las cerradas, como la regla original. No certifica importes ni costes. |
| `minimum_complete_share`, `funding_eligible` | Umbral de configuración sin modificar (hoy `0.95`) y elegibilidad por ese conteo. Sin cerradas, elegibilidad y fracción son `null`. |
| `funding_evidence_complete_count`, `cost_evidence_complete_count` | Conteos de evidencia individual realmente completa; pueden diferir del conteo de estados declarados antiguos. |
| `funding_time_known_trades`, `funding_covered_ms`, `funding_held_ms` | Número de operaciones con fracción temporal conocida y sumas de duraciones (cada suma es `null` si falta algún dato). |
| `funding_time_share` | Fracción ponderada por duración; `null` si alguna operación tiene cobertura desconocida o no hay duración positiva. Nunca se sustituye por el porcentaje por conteo. |

Con 96 % de estados completos puede aprobar la regla del 95 % y seguir siendo
`provisional`. `no_trades` no significa neto cero demostrado; `censored` indica
abiertas al corte, incluso sin cerradas. Si falta evidencia de costes en registros
Qwen/Kronos o fuentes históricas, la identidad actual del manifiesto no los
certifica. Tampoco se aplica el modelo actual a sus importes antiguos.

### Históricos y siguiente entrega (T5)

No se reescribe ningún resultado guardado. Si falta `accounting`, tiene esquema
incompatible o no valida sus tipos e invariantes, las lecturas de estado/resumen añaden
`unclassified`, `reasons=[missing_or_invalid_accounting]`, ambos netos y las
fracciones/elegibilidad `null`, y `metric_population=null`. No se infiere
completitud desde el spec, la configuración o el modelo de costes actual.
El lector exige números JSON finitos (no strings ni booleanos), conteos enteros
no negativos, fracciones válidas y coherencia entre estado, conteos, cobertura y
netos. `complete` requiere cerradas, ninguna abierta y evidencia completa; sus
netos observados y definitivos deben coincidir. Los demás estados no pueden
publicar totales definitivos. Un payload inválido se rechaza entero, sin repararlo
ni reescribirlo. La elegibilidad conserva el umbral guardado, separado del conteo
de evidencia definitiva; no se contrasta con la configuración actual.
Las operaciones/trazas antiguas pueden seguir sin el objeto nuevo: T5 debe
mostrar esa ausencia como no clasificada, no como neto definitivo.

## Tramos temporales purgados (T3)

**Solo cambia la muestra de estabilidad de corridas nuevas.** Las estadísticas
globales, controles, contabilidad y denominador del 95 % de funding conservan
**todas las cerradas observadas**, incluidas las excluidas de los tramos. La
cantidad de tramos y el porcentaje mínimo de tramos positivos no cambian.
Un tramo vacío permanece en el denominador y no es positivo; su `mean_bp=null`
significa media no disponible, no cero medido. Una sola operación tampoco
permite medir dispersión, pero no se añade un mínimo nuevo a la regla existente.

### Fronteras y embargo heredado

- Entradas en `[from_ms,to_ms)`; salida `<=to_ms` del tramo propietario. Una
  operación que cruza uno o varios finales se excluye una sola vez, sin repartir
  su resultado ni moverla al tramo de salida. Una entrada exactamente en la
  frontera pertenece al tramo siguiente; una salida exactamente en ella puede
  pertenecer al anterior. La última frontera también se respeta.
- Se reutilizan directamente `embargo_ms` y `purged_split` de `futures_purged.py`,
  los mismos helpers puros que llama `futures_strategy_backtest.py`: embargo de
  **la mayor duración cerrada observada**, limitado al **25 % del ancho de un
  tramo**. No es un horizonte nuevo del spec ni una orden de cerrar por tiempo.
  Los cruces permanecen en la población usada para medir esa duración.
- El primer tramo no tiene embargo. En los siguientes se excluyen entradas
  anteriores a `from_ms + embargo_ms`; la entrada exactamente al final del
  embargo sí puede usarse. Se conservan los bordes enteros originales del gate;
  el tope usa el ancho uniforme `(fin-inicio)/cantidad`, como el legado.
- El legado tenía extremos abiertos; el gate los limita a su ventana explícita.
  No se modifica ninguna salida del backtest legado. Hay prueba de paridad para
  operaciones cerradas dentro de esa ventana.
- Sin cerradas no se inventa duración: `embargo_ms=null`, fuente `no_closed_holds`.
  Un cero solo puede resultar de duraciones realmente observadas (o del tope
  heredado), no es un valor por defecto nuevo.
- Qwen/Kronos conservan sus rutas de registros observados, pero no se les atribuye
  esta política de horizonte/embargo: `state=unsupported`, fuente
  `unsupported_recorded_model_horizon`, duración `null`. Las cerradas siguen en
  el global y no se certifican muestras de estabilidad. La regla de tramos conserva
  `ok=false`, pero añade `measurement_status=unavailable` y el motivo de la
  limitación: **no es una regla de rendimiento medida que haya fallado**.
  Si todas las demás reglas pasan, el resultado es **INCONCLUSO**, con motivo
  `temporal_unsupported` (o `temporal_unavailable` cuando falta evidencia), nunca
  PASA. Si falla otra regla de rendimiento medida, sigue siendo **NO PASA**.
  Con evidencia respaldada, `measurement_status=measured` conserva los umbrales
  y el denominador originales, también cuando hay tramos vacíos. El informe
  muestra la estabilidad no evaluable, no «cero periodos ganadores».
  No se llama a ningún modelo.

**No es entrenamiento/prueba walk-forward**, ni validación sin fugas del
aprendizaje o de la generalización. No se ajusta ningún parámetro y la duración
observada no es una garantía de duración máxima futura. Tampoco valida la
política completa de Qwen. Se conservan la exclusión del holdout, contaminación
y bloqueo de un solo examen por versión; las versiones examinadas no se reabren.

### Metadatos persistidos y consumo en T5

El objeto `temporal` aparece en `result`, respuesta Python y evento final CLI;
se guarda en `runs.params.temporal` y `manifest.summary.temporal`. Listas/estado
lo copian a `run.temporal`, y `visual-summary` a `summary.temporal`. El informe
nuevo incluye método, embargo, motivos, conteos y tabla por tramo. No requiere
que se haya podido escribir el artefacto para persistir la evidencia en la DB.

| Campos | Significado |
| --- | --- |
| `schema`, `method`, `scope` | `balancita.strategy-gate-temporal.v1`, `purged_stability_observed_hold.v1`, `temporal_stability_only`. |
| `state`, `reasons` | `observed`, `insufficient` (hay tramos vacíos o unitarios), `no_trades`, `censored` o `unsupported`; motivos explícitos. No son el veredicto estadístico. |
| `from_ms`, `to_ms`, `entry_bounds`, `exit_bound`, `fold_count` | Ventana evaluada, convenciones de frontera y denominador original. |
| `embargo_ms`, `embargo_source`, `embargo_supported`, `embargo_max_fold_share` | Duración usada, origen heredado o limitación explícita, disponibilidad y tope `0.25`. |
| `input_trades`, `used_trades`, `excluded_trades`, `excluded_reasons` | Población recibida y separación disjunta de usadas/excluidas. Motivos: `crosses_fold_end`, `embargo`, `entry_out_of_range`, `open_at_cut`, `invalid_interval`, `unsupported_embargo`. |
| `open_at_end` | Posiciones abiertas censuradas, separadas de las cerradas. Nunca se crean cierres sintéticos. |
| `folds` | Por tramo: `index`, `from_ms`, `to_ms`, `usable_from_ms`, embargo aplicado, `used`, `excluded`, motivos y `sample_state` (`no_trades`, `single_trade`, `observed`). El resultado añade sus métricas habituales. |
| `training_testing_walk_forward` | Siempre `false` para evidencia nueva. |

T5 debe mostrar muestras vacías/unitarias y límites del embargo junto a la
estabilidad, sin presentar `observed` como certificación de generalización.
La regla de tramos guarda `measurement_status` y `reasons` también en
`summary.rules`; T5 debe consultar ese estado antes de interpretar su conteo o
`ok=false` como un fracaso medido.
Las lecturas sin metadatos compatibles devuelven `state=unknown`, método,
embargo y tramos `null`, motivo `missing_or_invalid_temporal_metadata`. El lector
v1 exige tipos JSON y conteos enteros no negativos, identidad sin walk-forward,
fuente/soporte/duración coherentes, bordes e índices correctos, muestras y motivos
por tramo reconciliados con los agregados y estado/motivos coherentes con la
censura y la disponibilidad. Una contradicción rechaza todo el objeto, sin
repararlo. Un embargo cero observado, muestras escasas, bordes no divisibles y
estados no soportados o censurados válidos siguen siendo legibles.
No se recalculan duraciones desde operaciones subyacentes ni se reescriben
corridas, artefactos o informes anteriores a T3; tampoco se retrocertifican desde
el spec o los costes actuales.

T2/T3 no cambian el frontend ni las rutas antiguas de backtest del registro,
forward, replay/Qwen, Kronos, sesión paper o multi-experimento. Sus campos
numéricos antiguos no adquieren esta certificación. T5 debe priorizar los campos
`definitive_*`, distinguir conteo de cobertura temporal y etiquetar claramente
los importes `observed_*`; el informe descargable nuevo ya hace esa distinción.

## Reproducibilidad y estado de auditoría

Cada corrida nueva guarda `provenance` (esquema `balancita.strategy-gate-provenance.v1`)
y `audit` (`balancita.strategy-gate-audit.v1`) en `runs.params`, en el `summary`
del artefacto y en `run.provenance` / `run.audit` de las listas y del estado.
Son recibos del productor, **no una auditoría independiente**: no prueban que los
datos del proveedor sean correctos ni hacen replay de la política completa.

`provenance` registra lo necesario para reproducir: hash del spec, configuración
del gate (semilla, sorteos, reglas) y su hash, hashes de los archivos del motor,
modelo de costes (versión y hash del contenido), tipo de corrida, ventana,
productos y tick, número de intentos, y por producto un recibo de entradas
(velas 1m/5m con calentamiento, funding y operaciones) con conteo, límites y
hash de los registros parseados en orden de consumo. Un recibo `partial` indica
una fuente limitada (p. ej. operaciones propias sin entradas de decisión).

`audit.state`:

| Estado | Significado |
| --- | --- |
| `available` | Artefacto publicado, procedencia completa y traza de decisiones capturada. `evidence_ready=true`. |
| `partial` | Artefacto publicado pero procedencia incompleta o sin traza. |
| `pending` | La corrida sigue en curso. |
| `unavailable` | Falló o se canceló la corrida, o no se pudo guardar el artefacto (`artifact_write_failed`). PASA y las estadísticas numéricas no cambian. |
| `unknown` | Corrida antigua o metadatos ausentes/corruptos; se valida al leer y no se reescribe. |

`independently_verified` y `full_policy_replay` son siempre `false`.
El replay de una traza (`gate_trace.replay`) reproduce el recibo con la etiqueta `base`.
