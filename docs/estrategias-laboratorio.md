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

Cada variante es un intento más sobre la misma historia: registralo cuando haya backtest (T2).
