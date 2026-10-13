# `GET /api/observability/activity` (Mission Control B2)

Qué hizo el sistema en las últimas 3 h o 24 h, contado con filas que ya existen: evaluaciones, señales direccionales,
descartes agrupados por `reason_code` y la última operación de cada experimento. Solo lectura: no escribe, no lanza procesos y
no hace polling. Vive en el gateway (`/api-live/api/observability/activity` detrás del proxy de Vite, igual que
`/api/observability/health`). **No hay UI conectada** todavía.

Código: `server/src/features/live-gateway/observability-activity.ts`. Pruebas: `observability-activity.test.ts`.
Medición: `observability-activity-bench.ts`. Ejemplos (generados por las pruebas con datos de fixture):
`docs/mission-control/b2/`.

## Petición

`GET /api/observability/activity?window=3h|24h[&product=PF_XBTUSD]`

- `window` es obligatorio y solo acepta las claves propias `3h` y `24h` (también rechaza `toString`, `constructor`, `__proto__`
  o un parámetro repetido). Otro valor o ausente: `400 {"error":{"code":"invalid_window"}}`.
- `product` es opcional y debe estar en la lista de productos del gateway. Otro valor: `400 {"error":{"code":"invalid_product"}}`.
- Sin `product` se agregan los 8 productos.

## Reglas

1. **Actividad no es salud.** Ningún campo de este endpoint es un estado `ok/warning/error`. Una ventana sin señales ni
   operaciones no es un error: las estrategias pueden no encontrar nada que hacer. El estado de salud sigue siendo B1.
2. **Cero leído no es lo mismo que no poder leer.** Una sección cuyo origen no existe, no está configurado o no se puede abrir
   devuelve `state: "unavailable"` con `detail` y la evidencia (`file_not_found`, `source_not_configured`, mensaje de SQLite) y
   **sin cifras**. `state: "ok"` significa que se leyó y que los contadores son filas reales, incluso si son cero.
3. **Cada sección declara su evidencia**: `source`, `origin` (archivo), `state` (`read|missing|unreadable`) y la `rule` con la
   que se contó.
4. **Lo que no se registra se dice.** Los descartes del forward (entradas bloqueadas) y los fallos de Qwen no se guardan fila a
   fila hoy; `discards.not_recorded` lo enumera para que su ausencia no se lea como «cero descartes». Persistirlos es B4.
5. **Sin inferir motivos.** Los motivos de espera son los `reason_code` que el sistema escribió, tal cual; el endpoint no los
   traduce ni deduce causas.

## Ventana

`to_ms` es el inicio del minuto en curso (límite superior **excluido**: ese veredicto aún no está cerrado) y
`from_ms = to_ms - window`. Un veredicto cuenta si su `bucket_start` está en `[from_ms, to_ms)`. Cada producto debería tener
un veredicto por minuto: `expected` = minutos de la ventana (180 o 1440), `missing = max(0, expected - count)`.

**`missing` es la diferencia con la cadencia nominal de veredictos (uno por producto y minuto), no un diagnóstico de salud.**
Si el proceso `verdict` no se lanzó a propósito (p. ej. `DEV_ONLY=vite,capture,live,forward,strategies`), esos minutos sin
evaluaciones no son un fallo del sistema; quien determina la salud es B1. La regla de la sección lo repite en
`evaluations.evidence.rule`. Los veredictos reconstruidos de un respaldo cuentan por su `bucket_start`.

## Contrato

```jsonc
{
  "generated_at_ms": 1790000000000,
  "cache_ttl_ms": 15000,
  "window": "3h",
  "from_ms": 1789989180000,
  "to_ms": 1789999980000,
  "product": null,                      // o el producto pedido
  "evaluations": {
    "state": "ok",                      // o "unavailable" + "detail"
    "evidence": { "source": "...", "origin": "futures-verdicts.sqlite", "state": "read", "rule": "..." },
    "total": 360,
    "by_product": [{
      "product": "PF_XBTUSD",
      "count": 180, "expected": 180, "missing": 0,
      "first_bucket_ms": 0, "last_bucket_ms": 0, "last_known_at_ms": 0,
      "long": 1, "short": 0,
      "last_signal": { "bucket_ms": 0, "action": "LONG", "reason_code": "c25_long_pullback" } // o null
    }]
  },
  "signals":  { "state": "ok", "evidence": {...}, "total": 1, "long": 1, "short": 0 },
  "discards": {
    "state": "ok", "evidence": {...},
    "total": 359,                       // sobre TODOS los motivos
    "by_reason": [{ "reason_code": "no_directional_proposal", "action": "WAIT", "count": 333 }],
    "distinct_reasons": 3,              // pares (action, reason_code) distintos de la ventana
    "truncated": false,                 // by_reason se cortó a los 50 más frecuentes
    "omitted_count": 0,                 // descartes de los motivos que quedaron fuera de by_reason
    "not_recorded": ["..."]
  },
  "operations": {
    "state": "ok", "evidence": {...},
    "pair_source": "registro del forward | estado del forward",
    "experiments": [{
      "experiment_id": "C29",
      "expected_active": true,          // false: lo vio el forward pero ya no se exige; null: no se pudo determinar
      "trades_in_window": 1,
      "open_records": 1,                // registros de forward_open: NO son posiciones actuales verificadas
      "last_cycle_ms": 0,               // último ciclo del forward para el experimento (null: sin fila de ciclo)
      "last_trade": { "product": "PF_XBTUSD", "side": "LONG", "entry_bucket_ms": 0, "exit_bucket_ms": 0, "exit_reason": "target" } // o null
    }],
    "notes": ["..."]                    // avisos de lectura (open_records, operaciones propuestas vs almacenadas)
  }
}
```

- **Evaluaciones**: filas de `paper_futures_verdicts` por producto y minuto (el veredicto de C).
- **Señales**: veredictos cuya acción seleccionada es `LONG` o `SHORT` (propuesta direccional). `last_signal` es la más reciente
  de la ventana.
- **Descartes**: veredictos `WAIT` o `ABSTAIN`, agrupados por `(action, reason_code)`, de mayor a menor (máximo 50 códigos).
  `total` se calcula sobre todos los motivos **antes** de limitar la lista: `truncated`, `distinct_reasons` y `omitted_count`
  dicen cuánto quedó fuera. Siempre: `evaluations.total = signals.total + discards.total`.
- **Operaciones**: por experimento (cada estrategia del forward es independiente, nada se suma entre ellos). `last_trade` es
  la última operación **de toda la historia** (puede ser anterior a la ventana: así se distingue «hace tiempo que no opera»
  de «nunca operó», que es `null`); `trades_in_window` cuenta entradas dentro de la ventana; `open_records` son los registros de
  `forward_open` con contenido: **lo último que el forward guardó, no una posición actual verificada**. Con el forward detenido
  siguen ahí y son historia. Se leen junto con `last_cycle_ms` (el `checked_ms` más reciente del ciclo del forward para el
  experimento en el alcance pedido; `null` si no hay fila de ciclo). Presentar posiciones actuales verificadas corresponde
  a B5; B2 no debe usarse para eso. Ninguna operación propuesta cuenta como ejecutada: solo se informan las que el forward
  almacenó. Los campos del trade se copian del payload del forward sin calcular nada (contabilidad
  intacta); un payload ilegible deja `side/exit_*` en `null` en lugar de fallar.
- **Qué experimentos**: los que el forward debe actualizar ahora, reconstruidos igual que en B1 (archivo de registro, estado del
  registro, specs y productos), más los que el forward tiene en `forward_status` pero ya no se exigen (`expected_active: false`).
  Si el conjunto esperado no se puede determinar, se listan los de `forward_status` con `expected_active: null`
  (`pair_source: "estado del forward"`).

## Seguridad y rendimiento

- Cada SQLite se abre `readOnly` con `PRAGMA query_only=ON` y `busy_timeout`, se consulta y se cierra. No se modifican tablas
  ni se crean archivos. Prueba: hash, tamaño y mtime de las fuentes no cambian.
- Consultas acotadas por clave primaria, sin escanear historia:
  - Veredictos: un rango `(product_id, bucket_start)` por producto, agrupado por `action, reason_code`. No se lee ni se parsea
    `payload_json`; coste = filas de la ventana (máx. 1440 por producto).
  - Última señal: mismo rango, `ORDER BY bucket_start DESC LIMIT 1`, solo si hubo señales.
  - Forward: por par (estrategia, producto) la última operación por prefijo de clave (`ORDER BY entry_bucket_ms DESC LIMIT 1`),
    las de la ventana por rango de `entry_bucket_ms` y la posición abierta por clave. **No hay `GROUP BY` sobre `forward_trade`.**
- Caché de 15 s por `(window, product)`; sin procesos nuevos ni tocar WebSocket, captura, estrategias, decisiones o contabilidad.

### Medición

`node --experimental-strip-types src/features/live-gateway/observability-activity-bench.ts --days N` sobre una copia sintética
(nunca la base viva): veredictos de N días con payload de 4 KB y `forward_trade` con 480 384 filas (3 estrategias × 8 productos).
Informe sin caché, 60 repeticiones, Linux, caché de páginas caliente.

| Historial de veredictos | 3 h p50 / p95 | 24 h p50 / p95 | Lecturas fallidas |
| ----------------------- | ------------- | -------------- | ----------------- |
| 2 días (102 MB)         | 2,6 / 3,7 ms  | 10,3 / 14,8 ms | 0                 |
| 14 días (717 MB)        | 2,6 / 3,4 ms  | 10,2 / 11,2 ms | 0                 |
| 28 días (1 433 MB)      | 2,6 / 3,3 ms  | 12,6 / 17,1 ms | 0                 |

(Segunda tanda, tras los ajustes de revisión, para 2 y 14 días; 28 días es de la primera tanda: sin cambios de consulta.)
Con un escritor insertando veredictos entre lecturas (WAL, 14 días): 24 h p50 10,2 / p95 11,8 ms, 0 lecturas fallidas. La
latencia depende de la ventana, no del historial (14× más historial: mismo orden), y no del historial de trades (480 384 filas).

## Límites conocidos

- Los descartes del forward y los fallos de Qwen no se persisten por evento (B4, opcional): se informan en `not_recorded`.
- `trades_in_window` cuenta por `entry_bucket_ms`; una operación que entró antes de la ventana y salió dentro no se cuenta.
- La lista de productos del forward se toma del entorno del gateway (`FUTURES_PRODUCTS` o la lista fijada), como en B1.
- Mediciones solo en Linux con caché de páginas caliente; en la Mac con disco frío la primera lectura puede tardar más
  (no se midió allí por indicación de no tocar la captura).
- Veredictos reconstruidos de un respaldo se cuentan por su minuto, no por cuándo se escribieron.
