# Cuerpo de las respuestas de funding (S6 de datos-útiles)

Tarea: `odd/tasks/datos-utiles.md`, T5 / S6. La captura de funding guarda el dato interpretado y la procedencia, **no el texto crudo** de cada respuesta HTTP de Kraken (≈1 MB por respuesta: 1,2 GB en el VPS, ≈3,3 GB en la Mac).

## Qué se guarda ahora

En `paper_futures_funding_responses` (una fila por respuesta que trae algo nuevo; la clave `sha256` es el hash del cuerpo **entero**):

```json
{"balancitaSlim":true,"fullSha256":"<igual a sha256>","fullBytes":<tamaño del cuerpo entero>,"serverTime":"…","rates":[<solo los períodos nuevos, en el texto literal de Kraken>]}
```

- `sha256`, `received_at` y `server_time` no cambian: la procedencia se verifica (mismo hash que el de la respuesta que Kraken seguía sirviendo).
- `paper_futures_funding_periods`, `funding_sightings` y `funding_polls` salen igual que antes: se calculan de la respuesta en memoria, no de lo guardado.
- La primera respuesta de un producto trae todo su año de historia: su cuerpo corto lleva todos los períodos (una vez).
- Si no se pueden aislar los textos de los períodos (por ejemplo una llave `}` dentro de un valor), se guarda el cuerpo entero: no se pierde información ni se falla.

## Variable

`FUTURES_FUNDING_BODY` (reiniciar la captura):

| Valor            | Efecto                                                                                |
| ---------------- | ------------------------------------------------------------------------------------- |
| `none` (defecto) | Nunca el cuerpo entero (lo de arriba).                                                |
| `daily`          | El primero de cada día UTC y producto, entero; los demás, cortos (lo de antes de S6). |
| `full`           | Siempre entero (el comportamiento original).                                          |

`FUTURES_FUNDING_BODY_DAILY=1` sigue significando `daily` si `FUTURES_FUNDING_BODY` no está puesta. `pnpm --dir server funding:backfill` usa la misma variable.

## Qué no se toca

Las filas ya guardadas (tablas append-only con triggers `_no_update`/`_no_delete`) quedan como están, con su cuerpo entero. El Parquet de `funding_responses` mezcla filas viejas y nuevas sin cambios (`docs/archivo-parquet.md`).

## Quién lee el cuerpo

- `python/balancita_engine/futures_funding_context.py`: lee primero el extracto de `funding_polls` y, si falta una hora, `["rates"]` del cuerpo: el cuerpo corto tiene la tasa literal de cada período nuevo.
- `python/balancita_engine/capture_minimal_read.py` / `capture_funding_184.py` (diagnóstico puntual de la captura 184): miden tamaño y contenido del cuerpo; con filas nuevas verán el cuerpo corto (`fullBytes` guarda el tamaño real).
- `FuturesMarketStore.fundingResponse(sha256)`: devuelve la fila tal cual está guardada (sin llamadores en el código de producción).
- `db:snapshot`, `db:rebuild`, `db:compact` y el Parquet copian la tabla fila a fila: no interpretan el cuerpo. Nada reconstruye `funding_periods` desde los cuerpos guardados.

## Ahorro esperado

Con la captura de 8 productos, una respuesta nueva por producto y hora como máximo: antes ≈170 MB/día (cuerpos de ≈1 MB), con `daily` ≈10 MB/día, ahora ≈0,1 MB/día (≈200 B por período nuevo, 8 × 24 respuestas ≤ 0,5 KB cada una). Es decir, ≈170 MB/día menos en el VPS, y el crecimiento de `funding_responses` pasa a ser despreciable.
