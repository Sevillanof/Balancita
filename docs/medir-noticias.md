# Medir si las noticias anticipan el precio

Informe de solo lectura: por cada noticia que Qwen analizó (relevancia y dirección, preguntas v2; o la fuerza y la dirección de la ficha, de Qwen en el modo solo-ficha o de las reglas del backend desde S10) mide cuánto se movió ETH a **1 h, 4 h y 12 h** desde que Balancita la conoció. No cambia el trader ni las bases.

```
PYTHONPATH=python python3 -m balancita_engine.futures_news_effect \
  --news-db <futures-news.sqlite> --market-db <futures-market.sqlite> \
  [--desde AAAA-MM-DD] [--hasta AAAA-MM-DD] [--json]
```

`--desde` incluye ese día y `--hasta` no (UTC). Sirve igual sobre una copia del VPS (`~/balancita-vps-respaldo/ultima-copia`).

## Cómo leerlo

- **acierto %**: noticias alcistas tras las que ETH subió, o bajistas tras las que bajó. 50 % es azar.
- **pb medio a favor**: movimiento medio en puntos básicos en la dirección que dijo la noticia; negativo = el precio fue en contra.
- **Neutrales**: no tienen dirección; se cuentan aparte.
- **`ficha N`**: grupo de las noticias que solo tienen ficha (modo solo-ficha), por su fuerza 0-3. No se mezcla con los grupos `none`/`low`/`medium`/`high` de las preguntas viejas: si hay las dos, las preguntas viejas mandan y la ficha no se mira.
- **Latencia de ingesta**: minutos entre la publicación y la llegada. Las fuentes que cargaron su historial al empezar muestran latencias enormes; mirar la mediana de las fuentes de flujo continuo.
- **Descartadas sin análisis**: noticias que no llegaron a Qwen (ventana de 30 min o filtro de titulares de precio), ordenadas por cuánto se movió ETH en la hora siguiente. Si arriba aparecen noticias que movieron el mercado, el filtro está tirando información útil.
- Sin vela de 5 m cerrada en la hora previa no hay precio: ese horizonte queda vacío, nunca se inventa.

Las muestras son chicas y las noticias se agrupan en los mismos eventos: un acierto de 55 % con n=50 no es una ventaja demostrada.

## Motor de reglas: el backend cataloga cada noticia, sin IA (S10, T18)

Decisión del usuario (L26 de `odd/tasks/noticias-y-auditor.md`): «tenemos que hacerlo sin una IA, solo BE que catalogue cada noticia entre alcista, bajista e importante». El proceso de noticias (`futures_news`) cataloga **cada noticia al entrar**, al instante y sin llama-server, con reglas fijas: `python/balancita_engine/futures_news_reglas.py` y el léxico versionado `config/noticias-reglas.json`. Sin Qwen, sin Haiku, sin ningún modelo ni red; la misma noticia da siempre la misma ficha.

**Qué escribe.** Una fila de `paper_futures_news_cards` con `card_version = 3` (las de Qwen son la 1 y no se tocan; los lectores toman la versión más nueva de cada noticia), `status = done`, y:

| Columna                                       | Valor                                                                                                                                                   |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `event_type`                                  | `hack`, `regulation`, `macro_fed`, `etf_flows`, `network_outage`, `adoption`, `price_recap`, `opinion`, `other` (los ids de siempre, no `hack_exploit`) |
| `direction`                                   | `bullish` (alcista), `bearish` (bajista), `neutral`                                                                                                     |
| `strength`                                    | importancia 0-3: 0 ruido, 1 menor, 2 importante, 3 muy importante                                                                                       |
| `strength_model`                              | la fuerza antes de los ajustes por fuente y topes (`strength_base`)                                                                                     |
| `amount_usd`                                  | el monto principal en dólares (`parse_amount_usd`, el mismo de siempre)                                                                                 |
| `rules_json`                                  | los nombres de las reglas que dispararon (para el tooltip y la auditoría): `recap`, `hack_100m`, `source_boost:fed`…                                    |
| `questions_json`                              | `["engine:reglas", "lexicon:noticias-reglas.vN"]`: quién la hizo y con qué léxico                                                                       |
| `scope`, `already_happened`, `strength_value` | nulos (las reglas no los deciden; `hack_100m` supone que ya pasó, como el modo solo-ficha)                                                              |

Corre en el mismo ciclo que la ingesta, para toda noticia guardada que no tenga ficha 3 (también las anteriores al cambio: al primer arranque se catalogan todas). Si las reglas fallan con una noticia queda una ficha `failed` y las demás siguen.

**Orden de las reglas** (el código solo sabe el orden; las palabras y los umbrales están en el JSON):

1. **`recap`** (titular que narra el precio: «Ether slips 2% to $3,400», «live updates») y **`opinion`** (pregunta, «why/how…», `could`, columna, comentario de un hackeo: «…, Pandl says», «warns», «calls for») → fuerza 0, `neutral`. Una opinión no pasa de `caps.opinion_max_strength` (1) ni con el empujón de una fuente (`opinion_cap`).
2. **Tipo de evento**, el primero que coincide: hackeo, caída de red/exchange, flujos de ETF, macro/Fed, regulación, hackeo en el resumen, adopción, macro amplia (`macro_broad`: ruido salvo sorpresa), otro.
3. **Fuerza del tipo**: hackeo ≥ 100 M US$ → ≥ 2 (`hack_100m`), ≥ 1.000 M → 3 (`hack_1b`; una secuela del hackeo —«traces», «denies», «says»— se queda en 2: `hack_followup_cap`); caída que corta retiros u operaciones de un exchange → 2; sorpresa macro (CPI más alto, «no cuts», recorte/alza, aranceles con caída) → 2; flujos de ETF ≥ 500 M → 2 (`etf_flow_500m`); acción contra un exchange (demanda, sanción, «cuts off») → 2; adopción menor solo si es grande o de una institución conocida.
4. **Reglas críticas** (patrones con nombre en el JSON): `chain_halt` (mainnet de Ethereum detenida) y `stablecoin_depeg` (USDT/USDC) → 3 bajista; `spot_etf_approval` (aprobación de un ETF spot de ETH/BTC) → 3 alcista; `fed_emergency_cut` → 3 alcista y `fed_emergency_hike` → 3 bajista; `hack_withdrawals_halted` (hackeo con retiros frenados, en el titular) → 2 bajista; `crypto_purchase` (una empresa compra ETH/BTC) → 1 alcista.
5. **Dirección**: bajista para hackeos y caídas (con monto ≥ 1 M, palabra de caída o fuerza 2); flujos de ETF por su vocabulario (`inflows`/`outflows`…); el resto, por vocabulario solo desde fuerza 2; fuerza 0 siempre `neutral`.
6. **Prioridad de la fuente** (`source_priors`): `fed_monetary` +1 y mínimo 2; `fed` +1 si es macro y habla de tasas/inflación/FOMC; `sec` +1 si es regulación o ETF y habla de cripto/demandas; `sec_speeches` y `eth_foundation` con tope 1 (`source_boost:…`, `source_floor:…`, `source_cap:…`).

**Cómo se afina.** Editar `config/noticias-reglas.json` (listas de palabras, umbrales en `amounts_usd`, `source_priors`, `critical`) y **subir `version`**; el proceso valida el archivo al arrancar y sale con «configuration error» nombrando el campo (`types.hack: invalid pattern…`) en vez de catalogar a ciegas. Cada ficha guarda la versión que la hizo. No hace falta tocar código; sí correr los tests (`test_futures_news_reglas*.py`: una prueba por regla y los 22 casos claros como regresión).

**Cómo se mide el acuerdo con Haiku** (informativo: acuerdo no es acierto; Haiku contra sí mismo coincide ~93 % en fuerza, ~97 % en dirección, ~91 % en tipo):

```
PYTHONPATH=python python3 -m balancita_engine.futures_news_reglas_eval analisis/clasificador-noticias/datos.jsonl [--solo-desarrollo] [--json]
```

Parte las 854 noticias etiquetadas en `desarrollo` (antes del 2026-11-07 00:00 UTC: 650) y `prueba` (desde ahí: 204). **El léxico se afinó mirando solo desarrollo y los 22 casos claros; la prueba no se usa para afinar** (se lee al final, con `--solo-desarrollo` mientras se afina).

| `noticias-reglas.v1` vs fichas de Haiku | n   | fuerza 0/1/2-3 | fuerza exacta | dirección (siempre «neutral») | tipo   | recall 2-3 | precisión 2-3 | bajistas | alcistas |
| --------------------------------------- | --- | -------------- | ------------- | ----------------------------- | ------ | ---------- | ------------- | -------- | -------- |
| desarrollo (en muestra)                 | 650 | 67,2 %         | 66,2 %        | 86,3 % (88,9 %)               | 56,2 % | 50/59      | 50/66         | 40/64    | 0/8      |
| **prueba final**                        | 204 | **60,8 %**     | 60,8 %        | **84,3 %** (93,6 %)           | 47,1 % | 1/4        | 1/10          | 2/8      | 0/5      |

Cómo leerlo, sin adornos: en la prueba las reglas **no superan** a «siempre fuerza 0 / neutral» (68,1 % y 93,6 %): marcan 1 donde Haiku pone 0 (la frontera 0/1 es borrosa también para Haiku) y ponen dirección donde Haiku dice neutral. Solo hay 4 noticias de fuerza ≥ 2 en la prueba, así que el recall no mide nada (1 de 4). El prototipo previo (`analisis/clasificador-noticias/reglas.py`) sacó 59,8 % / 89,7 % / 49,5 % en la misma prueba; Qwen en vivo, 51,1 % en fuerza sobre las 135 noticias que alcanzó a procesar. Lo que las reglas sí hacen, y Qwen tardaba 44 s por noticia en hacer: marcar al instante los eventos raros fuertes (hackeos grandes, caídas, sorpresas de la Fed), que es lo que el trader querría ver. Los **22 casos claros** (`analisis/haiku-panorama/casos_esperados.py`, titulares inventados) salen **22/22** en fuerza, dirección y tipo aceptables (el prototipo, 16/22, 16/22 y 21/22) — pero el léxico se ajustó hasta que pasaran, así que es una guardia de regresión, no evidencia independiente. La prueba final se leyó dos veces (antes y después de un último ajuste hecho solo con la tabla de desarrollo: `macro_broad`); el número de arriba es el segundo (el primero fue 55,4 % / 84,3 % / 47,1 %).

**Límites conocidos:** la dirección de las secuelas de un hackeo y de lo que Haiku llama «opinión» es la más discordante; no hay alcance ni «ya pasó»; el titular manda (el resumen solo cuenta para montos, el hackeo en el resumen y las reglas con `"where": "text"`); inglés solamente (las fuentes son en inglés); una errata («Bitcion tumbles») evita la regla de recap.

**El resumen (briefing) y el panorama.** Con el motor de reglas el resumen de Qwen no se genera: el proceso escribe una fila `off` en `paper_futures_news_briefings` con el motivo `news_engine_reglas` (el panel de noticias ya sabe leer `off`). Lo que lo reemplaza es **determinista y ya lo soporta la UI sin cambiar el contrato de datos**: la tarjeta de arriba de la columna de noticias (`src/app/TerminalNewsPanel.tsx`) pasa a ser «Lo más importante · 6 h»: las 3 noticias de mayor importancia de las últimas 6 horas (importancia y, a igual importancia, la más reciente; sin duplicados de titular; sin las de importancia nula), cada una con su flecha de dirección; al hacer clic, las 8 primeras con fuente, importancia y enlace. Se calcula en el navegador con las fichas que la lista ya trae; sin hora de referencia o con la fuente sin confirmar muestra «Sin confirmar», no una lista. Se eligió esto y no quitarlo porque no agrega ninguna consulta ni columna y el usuario sigue viendo un panorama; la API de noticias no cambió salvo lo aditivo de abajo.

**API y panel.** `server/src/features/live-gateway/news-items.ts` agrega, de forma aditiva, `card.engine` (`reglas` para la versión 3, `qwen` para las otras) y el valor `reglas` en `analysis_source` (junto a `questions`, `card` y `null`); `relevance` y `direction` salen de la ficha como ya salían con las de Qwen. Las noticias con respuestas viejas de las dos preguntas siguen leyéndose de ellas. El panel (`TerminalNewsPanel`) muestra el color de importancia y la flecha de dirección como siempre. Arreglo aparte que apareció al verificar: la API rechazaba (`invalid_briefing_record`) toda fila de resumen con `prompt_version` 4, que es la que escribe Python desde el arreglo de T1; ahora la reconoce. Propuesta fuera de lo editado aquí: el tooltip de cada noticia podría listar `card.rules`, pero `useTerminalNews.ts` no lleva la ficha al panel.

**Interruptor.** `NEWS_ENGINE=reglas` (por defecto, también vacío) o `qwen` (la cascada de Qwen y su resumen, tal como eran: se comprobó que con `qwen` las tablas salen idénticas a las del commit anterior). Un valor desconocido es un error de configuración. Con `reglas` el lanzador (`scripts/dev-provider-env.mjs`) no pasa `--analyze` al proceso de noticias aunque llama-server esté encendido, y el proceso de noticias arranca y cataloga con llama-server parado, caído o ausente (`DECISIONS_ENABLED=0`). Instalar y deshacer en la VPS: `ops/vps/README.md`, «Noticias sin IA y llama-server apagado».

**Qué lee la ficha 3.** El informe de efecto y la API leen la ficha más nueva de cada noticia: para las noticias que tenían ficha de Qwen (versión 1), desde ahora cuenta la de reglas. `priority_v2` (la única vía noticia → operación) sigue leyendo las respuestas viejas v2 y no lee fichas: sigue inerte, con o sin reglas.

## Resúmenes (briefings) de noticias

> Desde S10, con `NEWS_ENGINE=reglas` (el valor por defecto) no se genera ningún resumen: ver el apartado anterior. Lo que sigue describe el resumen de Qwen (`NEWS_ENGINE=qwen`).

El proceso de noticias (`futures_news`) pide a Qwen una frase en español sobre las noticias recientes. Es solo para mostrar: no entra en `news_features` ni en el trader. Cada intento escribe **dos filas** en `paper_futures_news_briefings` (solo-agregar): una `pending` y otra final (`ok`, `error`, `no_news` u `off`). Por eso los intentos son las filas `pending`; las filas finales de esos intentos son `ok` o `error` (en el VPS del 2-nov al 7-nov: 608 intentos, 56 `ok`, 552 `error`).

```
sqlite3 -readonly futures-news.sqlite "SELECT status, COALESCE(reason,'-'), count(*) FROM paper_futures_news_briefings WHERE status != 'pending' GROUP BY 1,2"
```

Por qué fallaba (2-nov → 7-nov, 4,6 días):

- **`model_unavailable` (480 de 552)**: `POST /v1/chat/completions: timed out`. El resumen compartía con la clasificación el tiempo máximo por llamada (30 s), pensado para un token. Desde el 3-nov ~15:00 UTC el llama-server del VPS fue unas 40 veces más lento (una clasificación pasó de ~0,4 s a ~15 s; generación de 30 a 1,5–3 tokens/s), y el resumen (~3.100 tokens de entrada y ~40 de salida) tardaba 15–30 s o más. Ahora tiene su propio tiempo máximo: `--briefing-timeout-seconds` (por defecto 120 s, o `--timeout-seconds` si es mayor); el de la clasificación no cambia. Un timeout sigue guardándose como `model_unavailable`.
- **Entrada demasiado grande**: el pedido llevaba ids, urls, marcas de tiempo y resúmenes de hasta 1.500 caracteres por noticia. Desde `prompt_version` 4 el modelo lee solo fuente, titular y los primeros 240 caracteres del resumen; la fila guarda igual las entradas completas (`inputs_json`).
- **`invalid_summary` (71 de 552)**: el modelo ponía cifras copiadas del titular («2800 ETH»), palabras vedadas («compras») o pasaba de 20 palabras, y el reintento solo decía la regla rota, así que repetía el texto (29 textos distintos en 71 rechazos; 26 de 30 conjuntos de noticias con un rechazo nunca llegaron a `ok`). Ahora el mensaje de error y el reintento nombran el culpable: `(digits) «2800»`, `(forbidden_words) «compras»`, `(too_long) «29»`. Las reglas de validación no cambiaron.

## Por qué `priority_v2` no disparó

`priority_v2` (`futures_qwen_noticias.py`) exige relevancia `high` con soporte ≥ 0,75 sobre `high`, dirección alcista o bajista, publicada hace ≤ 15 min y fuente con licencia verificada en `source_licenses` (solo `fed` y `fed_monetary`). Sobre las 404 noticias analizadas desde el 2-nov: ninguna salió `high` (66 `medium`, 85 `low`, 253 `none`; la mayor probabilidad de `high` fue 0,0003), así que 374 caen en «not_strong_directional_news» y 30 en «ingestion_late». Aunque saliera `high`, solo `fed` y `fed_monetary` tienen licencia: las otras 11 fuentes se rechazan por «source_or_license_unverified». El código no tiene un error; las condiciones juntas no se pueden cumplir con este clasificador y esta lista de licencias. Cambiarlas es una decisión sobre el trader, fuera de este documento.

**Caché de prompt de Qwen (T9).** Cada noticia se pregunta dos veces seguidas (`news_direction` y `news_relevance_btc`) con el texto de la noticia primero. Por eso la segunda pregunta reutiliza el sistema y la noticia de la primera y solo procesa su bloque de pregunta (84 tokens contra 136-206; medido en llama-server local, 20 llamadas: 2.459 tokens procesados contra 3.808 sin caché, −35 %). `cache_prompt: true` ya se envía y no cambia ninguna probabilidad (24 llamadas, diferencia máxima 0,0). Poner la pregunta primero y la noticia al final se midió y se descartó: ahorra solo 17 % más porque procesa la noticia dos veces, y cambia las probabilidades (hasta 1,0 en una opción), o sea cambia lo que Qwen responde. `--cache-reuse` tampoco: reutiliza bloques desplazados calculados con otro contexto. Con `-np 2` el trader y las noticias no se desalojan la caché entre sí (medido con un pedido sintético de ~1.000 tokens). Los scripts están en `analisis/qwen-cache-prompt/`.

## Ficha de noticia con Qwen (S7, T13)

Además de las dos preguntas de hoy (`news_relevance_btc` y `news_direction`, v2, que no cambian; con el modo solo-ficha de más abajo se pueden dejar de preguntar), el proceso de noticias puede pedir a Qwen la **ficha** del diseño S6: tipo de evento, fuerza 0-3 con ejemplos fijos, dirección, alcance y «ya pasó», en cuatro preguntas de una letra, y aplicar reglas fijas encima. Está **apagada por defecto** (la VPS no cambia sin un OK): `futures_news --analyze --cards` o `NEWS_ANALYSIS=1 NEWS_CARDS=1`. Sin `--analyze` no hace nada.

**Las cuatro preguntas** (catálogo `config/decision-questions.json`, ámbito `news_card`, versión 1; ids nuevos, así que las filas viejas y sus preguntas quedan intactas). Se hacen en este orden, siempre con el texto de la noticia primero (la caché de prompt reutiliza el sistema y la noticia entre ellas):

| Pregunta                     | Opciones (una letra cada una)                                                                                   |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `news_card_type`             | `hack`, `regulation`, `macro_fed`, `etf_flows`, `network_outage`, `adoption`, `price_recap`, `opinion`, `other` |
| `news_card_strength` (score) | `noise`=0, `minor`=1, `significant`=2, `shock`=3, cada una con ejemplos fijos en su descripción                 |
| `news_card_direction`        | `bullish`, `bearish`, `neutral`                                                                                 |
| `news_card_scope_status`     | alcance (`eth`, `crypto`, `macro`) × «ya pasó» o «planeado/rumor»: seis opciones, p. ej. `eth_happened`         |

Cascada: si Qwen contesta `price_recap` a la primera, no se hacen las otras tres; un titular de recap (`is_price_recap`) ni llega al modelo. Con el modelo caído no se escribe nada y la noticia se reintenta dentro de la ventana; una pregunta que falla `max_attempts` veces deja una ficha `failed`; una noticia vencida o solo de Bitcoin deja una ficha `skipped_stale`.

**Reglas fijas** (`apply_card_rules` en `futures_qwen_noticias.py`, sin modelo, con tests):

- `recap`: el modelo dice `price_recap` o el titular lo es → fuerza 0 y dirección `neutral`.
- `hack_100m`: hackeo o exploit (el modelo dice `hack` o el titular lo dice) que ya pasó, con monto ≥ 100 M US$ → fuerza ≥ 2. Corre después de `recap`, así un hackeo grande cuyo titular también cita el precio conserva su peso.
- Monto (`parse_amount_usd`): el mayor monto en dólares del titular, o del resumen si el titular no trae: `$6.3 billion`, `$40M`, `US$ 300 million`, `133 million dollars`, `$3,000` (un precio también es un monto; solo los grandes activan reglas). Sin marca de dólar no cuenta.

**Dónde queda.** Cada respuesta va a `paper_futures_news_analysis` como cualquier otra (clave `item_hash, question_id, question_version`). La ficha terminada va a la tabla nueva, solo-agregar, `paper_futures_news_cards` (una fila por noticia y `card_version`): `event_type`, `scope`, `direction`, `strength` (final), `strength_model` (lo que contestó Qwen), `strength_value` (fuerza esperada, 0-3), `already_happened`, `amount_usd`, `rules_json`, `questions_json`. Se crea sola en una base vieja y no cambia el hash de configuración. La API de noticias (`server/src/features/live-gateway/news-items.ts`) agrega a cada noticia el campo `card` (`null` si no hay ficha válida); los campos anteriores no cambian.

**Qué tan bien responde** (4B local contra las fichas de Haiku de T12 como referencia, no como verdad; detalle y matrices en `analisis/qwen-preguntas/informe.md`): detecta casi todo lo de fuerza ≥ 2 (19 de 21) pero marca de más (de lo que saldría ≥ 2 en la población, ~36 % coincide con Haiku), no separa bien fuerza 0 de 1, y la dirección apenas supera a decir siempre «neutral». Úsese como señal gruesa, no como probabilidad calibrada.

**Costo.** Cuatro preguntas son ~910 tokens de entrada por noticia (~790 de media con el filtro de recaps), contra ~250 de las dos de hoy. En la VPS (20,7 tok/s en el mejor caso medido; 4,2 tok/s la velocidad de los últimos días) eso es ~39 s (mejor caso) o ~190 s por noticia además de ~13 s o ~60 s de las dos de hoy. No se activa en la VPS sin decidir antes cuánto de eso se acepta.

`priority_v2` sigue leyendo `news_relevance_btc` v2 (ver arriba): leer la fuerza de la ficha ahí no es un cambio chico (otra consulta, otro soporte, otra razón de rechazo) y queda propuesto, no hecho. Con el modo solo-ficha queda **inerte** (ver abajo).

## Modo solo-ficha (T14, S7)

Autorizado por el usuario (L17 de `odd/tasks/noticias-y-auditor.md`: «Si, pasala a la VPS»). Con la ficha encendida se pueden apagar, cada una por separado, las preguntas que ya no hacen falta. Todo por defecto igual que antes: sin definir nada, el proceso de noticias hace lo mismo y escribe las mismas filas (comprobado con una pasada guionada contra el commit base: mismas filas, byte a byte, con la ficha apagada y con la ficha encendida por defecto).

| Qué                      | Variable (o flag)                                 | Por defecto  | Valor que apaga           |
| ------------------------ | ------------------------------------------------- | ------------ | ------------------------- |
| La ficha                 | `NEWS_CARDS=1` (`--cards`)                        | apagada      | —                         |
| Las dos preguntas viejas | `NEWS_LEGACY_QUESTIONS` (`--no-legacy-questions`) | se preguntan | `0`, `false`, `no`, `off` |
| Alcance y «ya pasó»      | `NEWS_CARD_SCOPE` (`--no-card-scope`)             | se pregunta  | `0`, `false`, `no`, `off` |

- Sin las dos preguntas viejas, ninguna noticia nueva recibe filas de `news_relevance_btc` ni `news_direction`, ni siquiera `skipped_stale`. `NEWS_LEGACY_QUESTIONS=0` sin `NEWS_CARDS=1` y con Qwen encendido es un error de configuración (el proceso sale con «configuration error»); sin Qwen no hace nada.
- Sin la pregunta de alcance, la cascada es tipo → fuerza → dirección (un recap sigue cortándose tras la primera) y la ficha queda con `scope` y `already_happened` nulos; `questions_json` lista solo las tres preguntas hechas. La regla `hack_100m` necesitaba «ya pasó»: sin la pregunta supone que pasó, salvo que Qwen haya tipado la noticia como `price_recap` o `opinion`, y se anota como regla **`hack_100m_unconfirmed`** (un titular tipo «exchange could be hacked for $500 million» sin esos tipos subiría a fuerza 2). La versión de la ficha sigue siendo 1: la ficha dice qué preguntas la hicieron y qué reglas la tocaron.
- Costo (proyección del informe, no medida en la VPS): ~620 tokens por noticia de media (tipo 320 + fuerza 269 + dirección 98, y los recaps salen tras la primera) contra ~790 de la ficha completa y ~250 de las dos preguntas viejas: ~31 s por noticia a 20,7 tok/s o ~150 s a 4,2 tok/s.
- Una noticia que ya tenía filas viejas sigue leyéndose de ellas. Una noticia sin filas viejas se lee de su ficha. Al arrancar con la ficha, las noticias que ya estaban en la base y no tienen ficha reciben una ficha `skipped_stale` si pasó la ventana de reintento (30 min): no se les pregunta nada.

### Quién lee las preguntas viejas

Se buscó cada lectura de `news_relevance_btc`, `news_direction` y `paper_futures_news_analysis` en `python/`, `server/src/`, `src/`, `scripts/`. Las lecturas son estas:

| Lector                                                                                                            | ¿Alimenta al trader?                                                                                 | Con solo-ficha                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `load_priority_events` → `NewsFeed.priority_at` / `lifecycle_at` (`priority_v2`, `futures_qwen_noticias.py`)      | **Sí**: `noticias_si` del trader de la Terminal (`terminal-activa.json`) y sus aperturas por noticia | **Inerte**: sin filas viejas no hay eventos ni rechazos; `priority_at` da `none`, `lifecycle_at` da `status: none` y sin noticias. No lee la ficha (ver abajo). Probado con una ficha de fuerza 3 licenciada: no abre nada.                                                                                                                                                                                                                        |
| `load_exogenous_events` → `verdict` (habilitador legado `legacy_v1`, `qwen-live.json`, exámenes y reproducciones) | Solo con `policy` distinta de `priority_v2` (no es la de la Terminal)                                | Sin eventos: `noticias_si` falso, `n` 0. Disponible, sin dato. Sin cambio de código; probado.                                                                                                                                                                                                                                                                                                                                                      |
| `news_features` (`futures_news --features-at`)                                                                    | No (sin llamadores en producción)                                                                    | Ventanas vacías (`items` 0). Sin cambio de código; probado.                                                                                                                                                                                                                                                                                                                                                                                        |
| Auditor (`futures_auditor.py`)                                                                                    | No (lee la fórmula guardada de la mirada, no la base de noticias)                                    | Sin cambio: con `priority_v2` guarda `priority: none` como hoy.                                                                                                                                                                                                                                                                                                                                                                                    |
| Resumen de noticias (`futures_news_briefing.select_inputs`)                                                       | No (solo para mostrar)                                                                               | **Lee la ficha**: noticias sin filas viejas con ficha `done` de fuerza ≥ 1 (la fuerza 0 se excluye como la relevancia `none`); fuerza 1/2/3 → `low`/`medium`/`high`, dirección de la ficha. Las entradas llevan además `analysis_source: "card"` y `card_strength` (solo ellas: las de filas viejas no cambian ni su hash). Lo que Qwen lee (fuente, titular, 240 caracteres del resumen) no cambia.                                               |
| Informe de efecto (`futures_news_effect`)                                                                         | No                                                                                                   | **Lee la ficha**: dirección y grupo `ficha N` (fuerza). Sin ficha ni filas viejas, la noticia no cuenta (igual que antes).                                                                                                                                                                                                                                                                                                                         |
| API de noticias (`server/src/features/live-gateway/news-items.ts`) → panel de noticias                            | No                                                                                                   | **Lee la ficha** si no hay respuesta vieja: `relevance` (fuerza 0-3 → `none`…`high`), `relevance_value` (`strength_value`/3), `direction`, `analysis_status` `done`, `known_at_ms`, y el campo nuevo `analysis_source` (`questions`, `card` o `null`). Ficha `skipped_stale`/`failed` → `stale`/`failed`; sin ficha válida → `pending` con todo en `null` («sin dato»). El panel (`src/app`) no cambió y muestra estos campos como los de siempre. |

**Qué cambia en las decisiones.** Nada que se haya visto: `priority_v2` no disparó nunca (0 de 404 noticias con relevancia `high`; solo `fed` y `fed_monetary` tienen licencia), así que el trader tampoco abrió ni giró por noticias. Lo que cambia es el derecho: con las dos preguntas viejas una noticia de `fed`/`fed_monetary` con P(`high`) ≥ 0,75 y dirección ≥ 0,75 hubiera podido abrir una posición; en solo-ficha eso ya no puede pasar. No se hizo que `priority_v2` lea la ficha porque no es un cambio chico ni neutral: haría falta sintetizar un soporte (la probabilidad de `shock` de Qwen 4B no está calibrada: marca ≥ 2 en 12,7 % de las noticias contra 5,1 % de Haiku), otra razón de rechazo y las marcas de tiempo de la ficha, y activaría de verdad una fuente de operaciones nueva con un modelo cuya fuerza no predijo ETH (L14/L16). Queda propuesto: es una decisión del usuario.
