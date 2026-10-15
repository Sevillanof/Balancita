# `GET /api/observability/candles` (Mission Control B6)

Velas históricas **oficiales de Kraken** ya guardadas en la base de mercado, de un producto y un intervalo, en un rango acotado.
Es la fuente del gráfico de contexto de «Investigación de decisiones». Solo lectura: no escribe, no calcula nada financiero, no
toca el WebSocket ni la captura. Vive en el gateway (`/api-live/observability/candles` detrás del proxy de Vite, igual que B1/B2).
**No hay UI conectada** todavía.

Código: `server/src/features/live-gateway/observability-candles.ts`. Pruebas: `observability-candles.test.ts` (unitarias,
rendimiento sintético, ejemplos) y `e2e/integracion-gateway.pw.ts` (gateway real con base temporal sintética).
Ejemplos completos generados por las pruebas: `docs/mission-control/b6/`.

## Petición

`GET /api/observability/candles?product=&interval=&from=&to=&limit=`

| Parámetro  | Obligatorio | Regla                                                                                                                                        |
| ---------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `product`  | sí          | Uno de los productos `PF_*` del gateway. Otro valor: `400 invalid_product`.                                                                  |
| `interval` | sí          | `1m`, `5m`, `15m`, `1h`, `4h`, `1d` (clave exacta; `toString`, `constructor` o un valor repetido se rechazan). Otro: `400 invalid_interval`. |
| `from`     | no          | ms epoch, entero decimal sin signo. Incluido. Por defecto `to - limit × intervalo`.                                                          |
| `to`       | no          | ms epoch. **Excluido**. Por defecto, el fin del bucket en curso (`(floor(ahora/intervalo)+1) × intervalo`).                                  |
| `limit`    | no          | 1 a 1500, entero. Por defecto 500.                                                                                                           |

Rechazos (todos `400 {"error":{"code":"..."}}`):

- `invalid_range`: `from`/`to` no son enteros decimales sin signo, o `from >= to`, o un parámetro repetido.
- `range_too_large`: el rango abarca **más de 1500 buckets** alineados del intervalo (1500 × 1m = 25 h; 1500 × 1d ≈ 4 años). Se rechaza, no se recorta.
- `invalid_limit`: `limit` no entero, `< 1` o `> 1500`.

404 solo para una ruta desconocida. Un método distinto de GET sobre esta ruta también es 404 (no hay escrituras).

## Respuesta

200 siempre que la petición sea válida, incluso sin datos.

- `schema`: `observability-candles.v1`. `generated_at_ms`: reloj del gateway al construir la respuesta. `cache_ttl_ms`: 5000.
- `from_ms` / `to_ms`: **rango efectivo** `[from_ms, to_ms)`. Si hay más velas que `limit` se sirven las `limit` más nuevas,
  `truncated` es `true` y `from_ms` sube a la primera vela servida. Si no, `from_ms` es el pedido.
- `candles.state`:
  - `ok`: la base se leyó. `count` puede ser 0 (no hay velas en el rango; no es un error).
  - `unavailable`: no se pudo leer (`detail`: `source_not_configured`, `file_not_found`, `schema_without_product_id` o el mensaje de
    SQLite) y **no hay `items`**. `evidence.state` es `missing` o `unreadable`.
- `candles.evidence`: `source` (tabla), `origin` (nombre de archivo), `state`, `rule` (qué se sirve y cómo).
- `candles.items` (de la más vieja a la más nueva): `bucket_start_ms`, `close_at_ms` (= inicio + intervalo, excluido),
  `known_at_ms` (cuándo se conoció la primera revisión), `open/high/low/close/volume_btc` (**strings decimales tal cual están
  guardados**, sin convertir ni recalcular) y `closed` (`close_at_ms <= generated_at_ms`).
- `candles.last_candle_closed`: `closed` de la última vela servida; `null` sin velas.
- `candles.expected` / `count` / `missing`: buckets alineados esperados en el rango efectivo, velas servidas y la diferencia.
- `candles.gaps`: tramos sin vela `{from_ms, to_ms, missing}` (hasta 100; `gaps_truncated` lo avisa, los conteos siguen exactos).

## Reglas

1. **Huecos sin rellenar.** (Kraken publica los minutos quietos como velas planas, así que un hueco suele ser captura caída o backfill pendiente.) Un bucket que Kraken no publicó o que la captura no guardó **no aparece** como vela: figura en `gaps`.
   No se interpola ni se copia el cierre anterior.
2. **Solo velas oficiales cerradas.** Se sirve `paper_futures_official_candles` (la primera revisión conocida de cada bucket, la
   misma regla que el gráfico de la Terminal). No se sirven la vela en formación ni las construidas con trades. Qué intervalos tienen
   datos depende de la captura (según `official-candles.ts`: 1m y 5m para los productos capturados; 15m, 1h, 4h y 1d solo para el producto de la Terminal; no verificado contra las bases reales); un intervalo sin filas es
   `ok` con `count: 0` y todo el rango en `gaps`, no un error ni un 404.
3. **Orden y alineación.** Ascendente por `bucket_start_ms`. Los buckets son múltiplos del intervalo desde el epoch (UTC);
   `from`/`to` no alineados cuentan solo los buckets alineados que caen dentro de `[from, to)`.
4. **Solo lectura acotada.** SQLite `readOnly` + `query_only`, conexión corta, consulta por el prefijo de la clave primaria
   `(product_id, interval_ms, bucket_start)` dentro del rango (una prueba verifica el plan: `SEARCH ... USING INDEX`, sin `SCAN`).
5. **Caché corta y acotada**: 5 s, 64 entradas por proceso, clave `(producto, intervalo, from, to, limit)`.

## Ejemplos (generados por `observability-candles.test.ts`)

Con huecos (`ejemplo-con-huecos.json`, primera vela; las otras siguen el mismo formato):

```json
{
  "schema": "observability-candles.v1",
  "generated_at_ms": 1790000000000,
  "cache_ttl_ms": 5000,
  "product": "PF_XBTUSD",
  "interval": "1m",
  "interval_ms": 60000,
  "limit": 500,
  "from_ms": 1789999200000,
  "to_ms": 1789999680000,
  "truncated": false,
  "candles": {
    "state": "ok",
    "evidence": {
      "source": "paper_futures_official_candles",
      "origin": "futures-market.sqlite",
      "state": "read",
      "rule": "velas oficiales cerradas de paper_futures_official_candles (primera revisión conocida de cada bucket) con bucket_start en [from_ms, to_ms); los buckets sin vela se listan en gaps y no se rellenan"
    },
    "count": 5,
    "expected": 8,
    "missing": 3,
    "gaps": [
      {
        "from_ms": 1789999380000,
        "to_ms": 1789999500000,
        "missing": 2
      },
      {
        "from_ms": 1789999620000,
        "to_ms": 1789999680000,
        "missing": 1
      }
    ],
    "gaps_truncated": false,
    "first_bucket_ms": 1789999200000,
    "last_bucket_ms": 1789999560000,
    "last_candle_closed": true,
    "items": [
      {
        "bucket_start_ms": 1789999200000,
        "close_at_ms": 1789999260000,
        "known_at_ms": 1789999263000,
        "open": "100.0",
        "high": "101.25",
        "low": "99.75",
        "close": "100.5",
        "volume_btc": "3.5",
        "closed": true
      },
      "..."
    ]
  }
}
```

Truncado por `limit` (`ejemplo-truncado.json`): 6 velas de 5m en el rango, `limit=3`:

```json
{
  "schema": "observability-candles.v1",
  "generated_at_ms": 1790000000000,
  "cache_ttl_ms": 5000,
  "product": "PF_XBTUSD",
  "interval": "5m",
  "interval_ms": 300000,
  "limit": 3,
  "from_ms": 1790000100000,
  "to_ms": 1790001000000,
  "truncated": true,
  "candles": {
    "state": "ok",
    "evidence": {
      "source": "paper_futures_official_candles",
      "origin": "futures-market.sqlite",
      "state": "read",
      "rule": "velas oficiales cerradas de paper_futures_official_candles (primera revisión conocida de cada bucket) con bucket_start en [from_ms, to_ms); los buckets sin vela se listan en gaps y no se rellenan"
    },
    "count": 3,
    "expected": 3,
    "missing": 0,
    "gaps": [],
    "gaps_truncated": false,
    "first_bucket_ms": 1790000100000,
    "last_bucket_ms": 1790000700000,
    "last_candle_closed": false,
    "items": [
      {
        "bucket_start_ms": 1790000100000,
        "close_at_ms": 1790000400000,
        "known_at_ms": 1790000403000,
        "open": "100.0",
        "high": "101.25",
        "low": "99.75",
        "close": "100.5",
        "volume_btc": "3.5",
        "closed": false
      },
      "..."
    ]
  }
}
```

Fuente ausente (`ejemplo-fuente-ausente.json`), 200:

```json
{
  "schema": "observability-candles.v1",
  "generated_at_ms": 1790000000000,
  "cache_ttl_ms": 5000,
  "product": "PF_XBTUSD",
  "interval": "1m",
  "interval_ms": 60000,
  "limit": 500,
  "from_ms": 1789999200000,
  "to_ms": 1789999380000,
  "truncated": false,
  "candles": {
    "state": "unavailable",
    "evidence": {
      "source": "paper_futures_official_candles",
      "origin": "futures-market.sqlite",
      "state": "missing",
      "detail": "file_not_found",
      "rule": "velas oficiales cerradas de paper_futures_official_candles (primera revisión conocida de cada bucket) con bucket_start en [from_ms, to_ms); los buckets sin vela se listan en gaps y no se rellenan"
    },
    "detail": "file_not_found"
  }
}
```

## Rendimiento

Prueba rotulada **SINTÉTICA** (base temporal, 194 400 filas, 1 500 velas por lectura, 20 lecturas sin caché). En este contenedor:
mediana ~9 ms, peor ~22 ms. La prueba exige mediana < 150 ms y peor < 500 ms. No es una medición de los datos reales.

## Qué necesita el consumidor (#157)

- Llamar a `/api-live/observability/candles?product=<producto de la decisión>&interval=<1m|5m|...>&from=&to=` con el rango que
  rodea al `bucket_start` de la decisión (por ejemplo ±N buckets), con `N` tal que el rango no pase de 1500 buckets.
- Dibujar solo `candles.items`; mostrar los `gaps` como tramos sin dato, nunca interpolarlos; si `candles.state` es `unavailable`
  mostrar «Sin datos de velas» con `detail`; si `count` es 0, «Sin velas en el rango».
- Si `truncated` es `true`, avisar que el rango se acortó y usar `from_ms` efectivo como borde izquierdo.
- Una decisión muy reciente puede caer en el bucket en curso: no habrá vela (`gaps`), no es un error.
- Convertir los strings a número solo para dibujar; no recalcular precios.
