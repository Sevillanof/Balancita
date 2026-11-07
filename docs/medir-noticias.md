# Medir si las noticias anticipan el precio

Informe de solo lectura: por cada noticia que Qwen analizó (relevancia y dirección, preguntas v2) mide cuánto se movió ETH a **1 h, 4 h y 12 h** desde que Balancita la conoció. No cambia el trader ni las bases.

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
