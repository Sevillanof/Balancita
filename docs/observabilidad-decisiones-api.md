# B3 de solo lectura: `GET /api/observability/decisions`

Qué veredicto escribió el motor en cada minuto y con qué contenido: listado por intervalo (producto y minuto), traza completa de un
veredicto y descartes con su `reason_code`. Es el primer tramo de B3: **solo lectura** sobre `paper_futures_verdicts`, sin escribir,
sin lanzar procesos y sin tocar la captura. Vive en el gateway (`/api-live/observability/decisions` detrás del proxy de Vite, igual
que B1 y B2). La UI es la vista «Investigación de decisiones» (`/investigacion`), a la que se llega desde el HISTORIAL de la Terminal.

Código: `server/src/features/live-gateway/observability-decisions.ts`. Pruebas: `observability-decisions.test.ts`. Fixtures
**sintéticas**: `observability-decisions-fixtures.ts`. Ejemplos (generados por las pruebas con datos de fixture, no del motor):
`docs/mission-control/b3/`. Decodificador del frontend: `src/features/observability/infrastructure/decisions-api.ts`.

## Fuente

`paper_futures_verdicts` (DDL de `futures_verdicts.py`): `product_id, bucket_start, interval_ms, decision_known_at, regime, action,
reason_code, verdict_hash, payload_json, written_at`, clave primaria `(product_id, bucket_start)`. El payload (`futures-verdict.v1`)
trae `selected`, `proposals[]` (una por estrategia, con sus `conditions`), `features` (`1m`, `1m_previous`, `5m`), `inputs`,
`close_at_ms`, `knowledge_lag_ms`, `previous_regime`. Los veredictos son inmutables (triggers de no-update/no-delete).

## Costes y límites

- Cada petición abre la SQLite `readOnly` + `query_only`, recorre la clave primaria dentro de un rango acotado y la cierra.
- El **listado no lee el payload** salvo `selected.strategy_id` de las filas devueltas (SQLite evalúa esa expresión solo para las filas
  de la página). `limit` ≤ 200 (por defecto 50). Rango máximo 7 días (el filtro nunca recorre más de 10 080 filas). Contar el rango
  y los filtros no toca `payload_json`.
- La traza lee **una** fila. Un payload de más de 512 000 caracteres no se parsea ni se envía (`payload_state: "too_large"`).
- Caché de 10 s por consulta (máx. 64 entradas, la más antigua sale primero). Sin polling: la UI lee al abrir, al cambiar un filtro y
  con «Actualizar».
- Medición: 200 filas de 8 KB de payload se listan en bastante menos de 1 s (prueba de la suite, umbral 1 s).

## Listado

`GET /api/observability/decisions?product=PF_XBTUSD[&from=&to=&limit=&cursor=&action=&reason_code=]`

| Parámetro     | Regla                                                                                                          | Error                 |
| ------------- | -------------------------------------------------------------------------------------------------------------- | --------------------- |
| `product`     | obligatorio, uno de los productos del gateway                                                                  | `invalid_product`     |
| `from`, `to`  | ms epoch enteros, `[from, to)`; por defecto `to` = inicio del minuto en curso y `from = to - 3 h`; `from < to` | `invalid_range`       |
| (rango)       | `to - from ≤ 7 d`                                                                                              | `range_too_large`     |
| `limit`       | entero 1 a 200 (por defecto 50)                                                                                | `invalid_limit`       |
| `cursor`      | el `next_cursor` de la página anterior (dígitos)                                                               | `invalid_cursor`      |
| `action`      | `LONG`, `SHORT`, `WAIT` o `ABSTAIN`                                                                            | `invalid_action`      |
| `reason_code` | texto exacto, 1 a 80 caracteres                                                                                | `invalid_reason_code` |

Un parámetro repetido, `toString`, `__proto__` o cualquier otro valor es `400 {"error":{"code":"..."}}`. Orden: más nuevo primero.
La paginación es por cursor (`bucket_start < cursor`): sin repetir ni saltar filas. Para páginas siguientes hay que reenviar el mismo
`from` y `to` de la primera respuesta.

```jsonc
{
  "schema": "observability-decisions.v1",
  "generated_at_ms": 1790000000000,
  "cache_ttl_ms": 10000,
  "product": "PF_XBTUSD",
  "from_ms": 1789989180000,
  "to_ms": 1789999980000, // excluido
  "limit": 50,
  "filter": { "action": null, "reason_code": null },
  "decisions": {
    "state": "ok", // o "unavailable" + "detail" y sin cifras
    "evidence": {
      "source": "paper_futures_verdicts",
      "origin": "futures-verdicts.sqlite",
      "state": "read",
      "rule": "...",
    },
    "range_total": 120, // veredictos del rango, sin filtro
    "by_action": [{ "action": "WAIT", "count": 107 }],
    "matching": 120, // veredictos que cumplen el filtro
    "items": [
      {
        "product": "PF_XBTUSD",
        "bucket_start_ms": 0,
        "interval_ms": 60000,
        "decision_known_at_ms": 0,
        "regime": "range",
        "action": "WAIT",
        "reason_code": "no_directional_proposal",
        "verdict_hash": "...",
        "written_at_ms": 0,
        "selected_strategy_id": null, // solo si el payload nombra una estrategia
      },
    ],
    "next_cursor": null, // string si hay más antiguos
    "not_recorded": ["..."],
  },
}
```

## Traza

`GET /api/observability/decisions/:product/:bucket` (`bucket` = `bucket_start_ms`, dígitos).

- `state: "ok"`: `decision` (las columnas de la fila), `payload_state` (`ok | unparseable | not_an_object | too_large`), `payload`
  (el JSON del motor **tal cual se guardó**, `null` si no está `ok`) y `mismatches` (columnas que el payload repite y contradice;
  vacío si coinciden; un campo ausente del payload no cuenta).
- `model_decisions` (solo con `state: "ok"`): las filas de `paper_futures_llm_decisions` (base de decisiones del modelo, Qwen) con la
  **misma clave `(product_id, bucket_start)`**, hasta 20, sin `state_text`, logprobs ni tiempos. `state: "ok"` con `items: []` significa
  que la base se leyó y el modelo no tiene fila para ese minuto; `state: "unavailable"` + `detail` que no se pudo leer
  (`source_not_configured`, `file_not_found`, tabla ausente). Cada fila trae `matches_verdict` (su `verdict_hash` es el de este
  veredicto). Es una correlación por producto y minuto: **nada dice que el modelo haya intervenido en la acción** del selector.
- `state: "not_found"`: la fuente se leyó y no tiene veredicto de ese producto en ese minuto. Es un `200`, **no** un `404`: el `404`
  queda reservado para «ruta desconocida» (así lo verifica la prueba de integración contra el gateway real).
- `state: "unavailable"` + `detail` (`source_not_configured`, `file_not_found`, mensaje de SQLite): la fuente no se pudo leer.
- Producto inválido o `bucket` que no sea un entero: `400 invalid_product` / `invalid_bucket`.

## Reglas

1. **`reason_code` no es atribución a una estrategia.** El código lo escribe el motor para el veredicto. Una espera (`WAIT`) o
   abstención (`ABSTAIN`) lleva el código del _selector_ (`no_directional_proposal`, `conflicting_signals`,
   `signal_already_evaluated`, ...): `payload.selected` no trae `strategy_id`. Solo cuando el selector eligió una propuesta direccional,
   `selected` es esa propuesta y trae `strategy_id`; entonces (y solo entonces) el listado devuelve `selected_strategy_id`. Las
   `proposals[]` de cada estrategia tienen cada una su propio `reason_code`, que sí es de esa estrategia.
2. **Una propuesta no es una operación.** `LONG`/`SHORT` es la propuesta direccional del selector. Ninguna operación del forward se
   enlaza a un veredicto (ver abajo).
3. **Nada inventado.** Lo que el payload no trae queda `null` en el decodificador y «No disponible» en pantalla.
4. **Cero leído no es no poder leer**: `unavailable` nunca trae cifras; `state: "ok"` con `items: []` significa que se leyó y no hay filas.

## Qué sigue sin fuente (B3 completo / B4 / B5)

`not_recorded` lo enumera en cada respuesta `ok`:

- libro de órdenes y spread al decidir (no se guardan);
- funding, flujo y volatilidad de mercado más allá de los indicadores del payload (`features`);
- participación del modelo en la acción: `model_decisions` solo correlaciona por producto y minuto; no hay un campo que diga que el
  selector usó la respuesta del modelo. Tampoco hay fila en los minutos en que no se lo consultó (Kronos tiene su propia base y no se
  incluye en este contrato);
- rechazos del motor de riesgo por veredicto (B4);
- operación del forward asociada a un veredicto (B5): `forward_trade` no guarda el `verdict_hash` ni el bucket del veredicto;
- resultado posterior a 15/60/240/1440 min y MFE/MAE por veredicto (forecasts por veredicto, B3 completo);
- velas alrededor del punto de decisión servidas por intervalo y rango desde este contrato (existen en la base de mercado y en el
  gráfico de la Terminal, pero no hay endpoint por rango de tiempo pasado).

## Ejemplos

`docs/mission-control/b3/`: `ejemplo-listado`, `ejemplo-listado-descartes` (filtrado por `reason_code`), `ejemplo-listado-sin-datos`,
`ejemplo-traza-propuesta`, `ejemplo-traza-descarte`, `ejemplo-traza-no-encontrada`. Se regeneran con
`UPDATE_DECISIONS_EXAMPLES=1 pnpm --dir server exec vitest run src/features/live-gateway/observability-decisions.test.ts`; sin esa
variable la prueba falla si el código y el ejemplo difieren. **Los valores son sintéticos** (payload con la forma del motor,
números inventados); las capturas llevan el rótulo «DATOS DE EJEMPLO».
