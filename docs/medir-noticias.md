# Medir si las noticias anticipan el precio

Informe de solo lectura: por cada noticia que Qwen analizó (relevancia y dirección, preguntas v2; o, en el modo solo-ficha, la fuerza y la dirección de la ficha) mide cuánto se movió ETH a **1 h, 4 h y 12 h** desde que Balancita la conoció. No cambia el trader ni las bases.

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

## Resúmenes (briefings) de noticias

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
