# Estrategias del laboratorio

Una **estrategia** es una variante de la Terminal: la configuración activa con unas pocas perillas cambiadas. Sirve para probar
ideas (backtest y sombra en papel) antes de llevarlas a la Terminal como nueva versión de configuración
(ADR 0001, enmienda 2026-11-06). No reentrena el maestro ni el portero.

## Base: `config/terminal-activa.json`

Snapshot congelado de la última versión activada de `config_versions` en `live.sqlite` (copia de la VPS, solo lectura):
versión 3, activada 2026-11-02T14:15:54.811Z, hash `37f572a841d35a7b7a8d01569378c508c6bcd9c8a4a6a2adb96e5d1097eade07`.
El hash es el de `futures_qwen_trader.config_hash`; `cargar_snapshot()` lo recalcula y falla si no coincide. No se edita: una
versión activa nueva es un snapshot nuevo (y las estrategias se vuelven a basar en él).

## Formato: `config/estrategias/<id>.json`

```json
{
  "id": "ejemplo-salida-30h",
  "nombre": "Ejemplo: tope a 30 h",
  "descripcion": "Qué prueba y por qué.",
  "base_config_hash": "<hash del snapshot>",
  "cambios": { "guardrails": { "max_hold_min": 1800 } }
}
```

- `id`: minúsculas, números y guiones; igual al nombre del archivo.
- `base_config_hash`: tiene que ser el hash del snapshot; si no, se rechaza.
- `cambios`: solo las perillas de la tabla, anidadas como en la config. Se aplican sobre el snapshot con la misma mezcla que los
  traspasos de la Terminal (`futures_qwen_live._apply_pending_changes`).
- El archivo es inmutable: para otra variante, otro archivo (otro `id`).

## Perillas permitidas

| Clave                                                                   | Qué cambia                                                             | Valor hoy          |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------ |
| `guardrails.max_hold_min`                                               | cierre obligatorio (60–10080)                                          | 2160 (36 h)        |
| `guardrails.exhaust_hold_min`                                           | plazo tras el cual cierra si la fórmula ya no apoya (≤ `max_hold_min`) | 1440 (24 h)        |
| `guardrails.stop_sigma_24h`                                             | stop por volatilidad; `null` = sin stop                                | `null`             |
| `guardrails.min_stop_pct`, `guardrails.max_stop_pct`                    | topes del stop (solo actúan con stop)                                  | 0,005 / 0,03       |
| `guardrails.cooldown_min`                                               | espera tras cerrar                                                     | 15                 |
| `wake.flat_every_min`, `wake.position_every_min`                        | cada cuántos minutos (múltiplo de 5) mira la fórmula                   | 15 / 15            |
| `posiciones.max`, `.fraccion`, `.espera_entre_entradas_min`             | cupos paralelos (1–3) y tamaño por cupo                                | 3 / 0,33 / 0       |
| `rebotes.caida_pct`, `.ventana_min`, `.salida_min`, `.enfriamiento_min` | experto de rebote                                                      | 5 / 60 / 240 / 240 |
| `analista.modo`                                                         | tamaño según volatilidad: `apagado`, `suave`, `fuerte`                 | `fuerte`           |

Todo lo demás se rechaza con un error que nombra la clave: expertos (`corta.*`), fechas de ajuste, rutas de modelos, productos,
cuenta y capital, funding, ejecución, noticias, costos. Los umbrales de entrada del maestro y del portero viven en los archivos
de los expertos (no en la config); con expertos autónomos la `exigencia` no se aplica, por eso no es una perilla.

## Crear una

1. Copiá `config/estrategias/ejemplo-salida-30h.json` con otro `id` (y mismo nombre de archivo).
2. Dejá `base_config_hash` y cambiá `nombre`, `descripcion` y `cambios`.
3. Comprobá: `PYTHONPATH=python python3 -c "from balancita_engine import futures_estrategias as e; c=e.cargar_estrategia('<id>'); print(e.hash_config(c))"`.

## Comparar una estrategia con la oficial (backtest)

```
PYTHONPATH=python python3 -m balancita_engine.futures_estrategias_backtest --estrategia <id> [--desde AAAA-MM-DD] [--hasta AAAA-MM-DD] [--json]
```

Corre la Terminal oficial (el snapshot) y la variante con el `Trader` real del paper (`replay_formula`), cada una con su config
completa (sin variables de entorno), sobre **la misma ventana y los mismos datos**: velas 5 m y funding de la caché local
(`data/qwen-trader/cache`, sin red; `--cache-dir` para otra) y, con funding absoluto, el archivo de funding en solo lectura
(`--funding-archivo`, por defecto el de dev-live). No escribe nada: ni bases, ni el registro de intentos, ni archivos. Con
`--json` imprime el informe completo.

- **Ventana**: `[desde, hasta)`. Por defecto la honesta, **2026-02-01 → 2026-04-19** (del corte de ajuste de los expertos fríos
  a la reserva). Si la config no deja empezar tan pronto, el informe dice desde cuándo midió (`desde_efectivo`).
- **Reserva**: una ventana que pase de 2026-04-19 se rechaza (salida 2) salvo `--incluir-reserva`; con la bandera corre y el
  informe la marca (`ventana.reserva.incluida`, con aviso): ese resultado no sirve para elegir.
- Nada de `hasta` en adelante se lee, así que no hay look-ahead.

### Cómo leer el informe

| Campo                                  | Qué es                                                                                                                              |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `oficial` / `variante` → `metricas`    | Después de costos y funding, una por config                                                                                         |
| `operaciones`                          | Cantidad de operaciones cerradas (la última se cierra a la fuerza al final de la ventana: motivo `fin_examen`)                      |
| `neto_usd`, `neto_bp_cuenta`           | Suma del neto de las operaciones, en USD y en puntos básicos del capital inicial (1000 USD)                                         |
| `neto_bp_por_operacion`                | Promedio del neto de cada operación, en bp de lo que arriesgó                                                                       |
| `acierto`                              | Parte de las operaciones con neto > 0                                                                                               |
| `max_drawdown_usd`, `max_drawdown_bp`  | Mayor caída del saldo realizado desde su máximo (el saldo cambia al cerrar cada operación); bp sobre ese máximo                    |
| `horas_promedio`, `por_motivo`         | Tiempo abierta por operación y cuántas cerraron por tiempo, por vuelta del maestro, stop, rebote, etc.                              |
| `diferencia`                           | **variante − oficial** de cada métrica numérica (`null` si una de las dos no tiene operaciones). Menos horas = negativo             |
| `estrategia`                           | id, `overlay_sha256` (de los bytes del archivo), `cambios`                                                                          |
| `snapshot.config_hash`, `*.config_hash` | Hash del snapshot y de cada config comparada (la oficial siempre es la del snapshot)                                               |
| `ventana`, `datos`, `limites`          | Fechas pedidas y efectivas, fuente de datos, y lo que el replay no puede medir                                                      |

Dos configuraciones iguales dan diferencia cero. Límites del replay (siempre en `limites`): sin noticias, sin libro de órdenes
(costos del modelo, no fills reales), sin posicionamiento; las perillas que dependen de eso solo se miden en sombra.

Cada variante probada es un intento más sobre la misma historia (el resultado es optimista): el comparador no lo registra
todavía; anotá los intentos a mano hasta la fase de sombra.
