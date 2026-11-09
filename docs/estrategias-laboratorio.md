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
| `rebotes.caida_pct`, `.ventana_min`, `.salida_min`, `.enfriamiento_min` | experto de rebote                                                      | 5 / 60 / 240 / 240 |

**Las reglas de inversión no son perillas** (usuario, 2026-11-06: «El backtest debe invertir igual que la Terminal, esas reglas no
cambian»): el tamaño de cada posición (`posiciones.fraccion`, 33 % del saldo del momento), los cupos (`posiciones.max`, 3),
`posiciones.espera_entre_entradas_min`, el tamaño por volatilidad (`analista.modo`: ×0,5 en calma; ×1,5 con movimiento queda **topado en un lugar**, 33 %), la cuenta, el nocional y el
apalancamiento son los de la Terminal activa y ninguna variante los cambia (`futures_estrategias.REGLAS_DE_INVERSION_FIJAS`). Un
archivo que los nombre se rechaza como cualquier clave no permitida, y el formulario «Nueva variante» no los ofrece.

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

| Campo                                     | Qué es                                                                                                                                            |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `oficial` / `variante` → `metricas`       | Después de costos y funding, una por config                                                                                                       |
| `operaciones`                             | Cantidad de operaciones cerradas por la estrategia (**sin** las que el replay cierra a la fuerza al final de la ventana: `fin_examen`)            |
| `neto_usd`, `neto_bp_cuenta`              | Suma del neto de las operaciones, en USD y en puntos básicos del capital inicial (1000 USD)                                                       |
| `neto_bp_por_operacion`                   | **Ponderado por tamaño**: Σ neto USD / Σ nocional USD × 10000 (lo que ganó cada dólar puesto). Mismo signo que el neto                            |
| `neto_bp_promedio_simple`                 | Promedio sin ponderar del bp de cada operación; solo referencia (un resto de 10 US$ pesa como una de 500 US$)                                     |
| `nocional_promedio_usd`, `_min_`, `_max_` | Tamaño de las posiciones: 33 % del saldo del momento (un lugar; con movimiento ×1,5 topado en 33 %, en calma ×0,5 = 16,5 %), tope por saldo libre |
| `acierto`                                 | Parte de las operaciones con neto > 0 (cada una cuenta igual, sea de 10 o de 500 US$)                                                             |
| `max_drawdown_usd`, `max_drawdown_bp`     | Mayor caída del saldo realizado desde su máximo (el saldo cambia al cerrar cada operación); bp sobre ese máximo                                   |
| `horas_promedio`, `horas_max`             | Tiempo abierta por operación; el máximo muestra que un tope (p. ej. 30 h) se cumple                                                               |
| `por_motivo`                              | Cuántas cerraron por cada razón: `maestro_vuelta`, `maestro_agotado`, `tiempo`, stop… (nunca `fin_examen`)                                        |
| `cerradas_fin_ventana`                    | `{operaciones, neto_usd}` de lo que seguía abierto al terminar la ventana y se cerró a la fuerza (motivo `fin_examen`); `{0, 0}` si no hubo       |
| `funding_operaciones_incompletas`         | Operaciones que tocaron una hora sin funding en el archivo (el booleano `funding_completo` se apaga con una sola hora)                            |
| `diferencia`                              | **variante − oficial** de cada métrica numérica (`null` si una de las dos no tiene operaciones). Menos horas = negativo                           |
| `estrategia`                              | id, `overlay_sha256` (de los bytes del archivo), `cambios`                                                                                        |
| `snapshot.config_hash`, `*.config_hash`   | Hash del snapshot y de cada config comparada (la oficial siempre es la del snapshot)                                                              |
| `ventana`, `datos`, `limites`             | Fechas pedidas y efectivas, fuente de datos, y lo que el replay no puede medir                                                                    |

**Cierre forzado de fin de ventana.** Lo que sigue abierto cuando termina la ventana no es una decisión de la estrategia (el replay lo
cierra al último precio): no cuenta en operaciones, acierto, neto (USD y bp, ponderado y simple), drawdown, horas, nocional ni
`por_motivo`, y se informa aparte en `cerradas_fin_ventana`. La lista `operaciones` del informe sí lo trae (con `motivo`
`fin_examen`) para dibujarlo y listarlo. `diferencia` se calcula con las métricas ya sin ellas.

Dos configuraciones iguales dan diferencia cero. Límites del replay (siempre en `limites`): sin noticias, sin libro de órdenes
(costos del modelo, no fills reales), sin posicionamiento; las perillas que dependen de eso solo se miden en sombra.

- **Libro de órdenes**: la config de la Terminal declara `execution.model` (fills contra el libro público). El replay no tiene libro
  y lo descarta (entra al cierre de la vela con el modelo de costos); si la config declara una salida maker en `execution.exit`, se
  conserva. Antes de este arreglo la declaración hacía que **cada entrada** se omitiera con `libro_no_disponible` y el comparador
  daba 0 operaciones en las dos configs.
- **Posicionamiento y prima**: el informe dice si importa. Los expertos activos (maestro y portero autónomo) solo leen velas, así que
  no importa. Si un maestro/portero de ETH usara prima, sesgo long/short o funding (`strength_btc`, `premium_bp`, `long_bias`,
  `top_long_bias`, `funding_bp`), el replay los alimentaría con 0 y sus decisiones no serían las del vivo: el informe lo marca como
  límite. El historial existe (`positioning.sqlite`: posicionamiento horario desde 2024-01, prima desde 2022-03), pero el replay
  todavía no lo lee.

Cada variante probada es un intento más sobre la misma historia (el resultado es optimista): el comparador no lo registra
todavía; anotá los intentos a mano hasta la fase de sombra.

## API de la página (servidor del registro, `futures_estrategias_api.py`)

Rutas bajo `/api-strategies` (el mismo proceso del puerto 8790; `--estrategias-dir` cambia la carpeta de overlays). Errores: `{"error", "detail"}`.

| Ruta                                      | Qué hace                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /estrategias`                        | `snapshot.config_hash`, `ventana_honesta`, `perillas` (las de `PERILLAS_PERMITIDAS`: `clave`, `tipo` entero/decimal/opcion, `valor_actual`, `minimo`, `maximo`, `paso`, `admite_null`, `opciones`) y `estrategias` (`id`, `nombre`, `descripcion`, `cambios`, `base_config_hash`, `overlay_sha256`, `error`). Un archivo roto sale con su `error` sin romper la lista                                            |
| `POST /estrategias`                       | Crea `<id>.json` con `{nombre, descripcion, cambios[, id]}` (sin `id`, sale del nombre). La base la pone el servidor: cualquier otro campo (p. ej. `base_config_hash`) da 400 `campos_desconocidos`. Clave prohibida o valor inválido: 400 `estrategia_invalida` nombrando la clave; id mal formado: 400 `id_invalido`; id existente: 409 `estrategia_existe` (nunca se pisa; no hay ruta para editar ni borrar) |
| `POST /estrategias/<id>/comparar`         | Cuerpo opcional `{desde, hasta}` (por defecto la ventana honesta). Arranca `comparar` en un hilo y devuelve el trabajo `{job_id, estado: corriendo, ...}`. Solo corre uno a la vez (409 `comparacion_en_curso`). Una ventana que pase de la reserva: 400 `ventana_invalida`; `incluir_reserva` no existe (400 `campos_desconocidos`) y se llama siempre con `False`                                              |
| `GET /estrategias/<id>/comparar/<job_id>` | `estado` corriendo \| listo \| error, con `informe` (el de `comparar`) o `error`                                                                                                                                                                                                                                                                                                                                 |
| `GET /estrategias/<id>/comparar`          | El último trabajo de esa estrategia (404 `sin_comparacion`)                                                                                                                                                                                                                                                                                                                                                      |

Los trabajos viven en memoria (se pierden al reiniciar el servidor).

## La página Estrategias (`/estrategias`)

Solo muestra variantes de la Terminal (T4, S5). Las estrategias de reglas C25–C33, su editor, VectorBT, el ranking, la puerta, la
prueba rápida con Qwen y los diálogos de activar/borrar ya no están en la página; sus datos y su backend siguen guardados como
historial. No tiene título: la barra superior dice dónde se está. Diseño: `design/estrategias-laboratorio/01-lista-y-detalle.html`.

- **Izquierda**: la tarjeta «Terminal activa · la que opera» (versión y fecha de `origen`, hash corto y, si hay una comparación
  lista, su resultado en la ventana honesta), «Variantes · N» con **+ Nueva variante** y una tarjeta por variante: qué cambia
  («Tope de horas 36 h → 30 h»), estado (**Sin probar**, **Probando…**, **Mejor que la oficial**, **Peor que la oficial**, **Falló**,
  **No se puede probar**) y el resumen del backtest (operaciones y diferencia de neto contra la oficial). El estado sale del
  último trabajo de `GET /estrategias/<id>/comparar`; como el servidor guarda los trabajos en memoria, tras reiniciarlo una
  variante vuelve a «Sin probar» hasta que se corra de nuevo.
- **Derecha**: la variante elegida. Barra de etapas **Backtest → Sombra → Promover** (Sombra y Promover aparecen deshabilitadas con
  «próximamente»: son T5/S6); barras de neto Oficial (azul) y Variante (ámbar) con el número de operaciones dentro; el gráfico
  de **velas de ETH con las operaciones** (ver abajo, una operación a la vez o varias); cuatro tarjetas (Neto por operación, Acierto, Peor caída, Horas promedio con la diferencia) y el pie con la
  ventana, «Reserva intacta» y las condiciones que el backtest no reproduce (Noticias, Libro, Posicionamiento, tachadas con su
  motivo en el tooltip, según `limites` del informe), **Ver operaciones** (lista de operaciones de la variante o de la oficial) y
  **Volver a correr**. Sin resultado se muestra el motivo: nunca probada (botón **Correr backtest**), corriendo, con error o sin
  poder usarse.
- **Nueva variante** (panel en lugar del detalle): nombre y las perillas permitidas que devuelve `GET /estrategias`, cada una con
  su «hoy X». Los valores se muestran en la unidad habitual (2160 min → 36 h, 0,33 → 33 %) y se envían en la del servidor. Solo se
  envía lo que difiere de hoy; la descripción es el resumen del cambio. Al crearla se arranca su backtest.
- **Velas con operaciones** (diseño `design/estrategias-laboratorio/09-lineas-que-se-separan.html`; reemplaza al gráfico de
  `lightweight-charts` de la dirección 08 y a la curva «Saldo acumulado»). Es un SVG propio, con los tokens del proyecto, que se
  ajusta al alto de su panel (sin logo de TradingView). Arriba: **‹ ›**, «Operación N de M», **▲ LONG / ▼ SHORT**, fecha y
  «entra HH:MM», el selector **Una operación | Varias** y la leyenda en una línea (Oficial azul, Variante ámbar, Ideal verde). Abajo:
  una línea de ayuda y la temporalidad **15m / 1h / 4h / 1d** (1 h al abrir). Las dos configuraciones se emparejan por instante de
  entrada y lado; una operación que solo hizo una de las dos se muestra igual (la otra salida falta y el panel dice «—» / «no operó»).
  Abre en la operación del medio de la lista (la primera que la variante cortó, si la hay).
  - **Una operación** (por defecto): velas solo alrededor de la operación (10 h antes de la entrada, 8 h después de la última
    salida), una banda mientras estuvo abierta, la **línea punteada** del precio de entrada con su píldora «entrada 2.034,00», el
    triángulo de entrada y **tres salidas** con una píldora con su neto en US$ cada una: Oficial ●, Variante ● e Ideal ★. Las
    píldoras no se pisan. Panel a la derecha: neto (verde/rojo), horas y motivo de cada salida (oficial: «tope 36 h» o «regla de
    salida»; variante: «tope 30 h» —el de su `guardrails.max_hold_min`— o «igual que la oficial»; ideal: «mejor precio posible») y la caja
    punteada **«Le faltó a la oficial»** = ideal − oficial, «contra la ideal».
  - **Varias**: velas de unos 5 días centradas en la operación elegida y, debajo, **una barra redondeada por operación** (de la
    entrada a la salida oficial) en filas que no se pisan (carriles), verde si la oficial ganó y roja si perdió, con «▲/▼ neto»,
    una **raya ámbar** donde salió la variante si fue en otro momento, la elegida con borde, y un punteado de cada barra al precio de
    entrada sobre las velas. Un clic (o Enter/Espacio) en una barra la elige y pasa a «Una operación».
  - **Salida ideal**: el mejor precio posible mientras la operación podía seguir abierta: el máximo (LONG) o el mínimo (SHORT) de las
    velas entre la entrada y entrada + 36 h (el tope de la oficial). Solo cuentan velas que caen enteras en ese tramo; la que contiene
    la entrada solo aporta su cierre y el precio de entrada, y la que abre en el tope queda fuera. Nunca queda peor que el precio al
    que salió la oficial o la variante dentro del tope. **Su neto** = neto de la oficial + `nocional × (precio ideal − precio de la
salida oficial) / precio de entrada` (± según el lado): mismo tamaño y mismos costos que la oficial, porque el informe no trae
    comisiones ni precios por operación. Los precios de entrada y salida salen de las velas (interpolando entre apertura y cierre
    dentro de la vela), por eso son aproximados con velas de 4 h o 1 d; los netos de la oficial y la variante son los del backtest.
    Si el informe no trae `nocional_usd` (informe anterior), el neto ideal y «Le faltó» muestran «—».
  - Solo se pide **una consulta de velas por operación elegida y temporalidad**, para el tramo que ve el modo «Una operación» o
    «Varias» (la ventana ±60 h, y más si la temporalidad es gruesa), siempre dentro de la ventana probada.
- **Fichas de la prueba** (pie del resultado): además de ventana, reserva y condiciones, **una sola** ficha «○ Fin de ventana 2 · 2»
  (oficial · variante) cuando alguna de las dos tiene `cerradas_fin_ventana.operaciones > 0`; el tooltip dice «Cerradas a la fuerza
  al final de la ventana (no cuentan en las métricas): oficial 2 · +1,00 US$; variante 2 · +0,97 US$». No aparece con 0 ni en un
  informe anterior. «Ver operaciones» sigue listándolas (motivo «Fin de la ventana») y avisa cuántas no cuentan.
- **La ventana del gráfico es la de la comparación**: del `ventana.desde_efectivo_ms` al `ventana.hasta_ms` del informe (nunca
  antes ni desde la reserva, 2026-04-19). Lo exige el servidor (abajo) y también la página, que recorta el cursor a esa ventana y
  descarta cualquier vela fuera de ella.
- **Alto**: en pantallas de menos de ~860 px de alto el panel de detalle compacta espacios para que el gráfico, las tarjetas y los
  botones quepan dentro del panel a 1280×800; si aun así no cupieran, el panel se desplaza por dentro (nada queda fuera de él).

### `GET /api-strategies/estrategias/velas/<producto>/<intervalo>/<desde_ms>/<hasta_ms>/<antes_ms>/<limite>`

Solo lectura. Velas OHLC de ETH agregadas desde las de 5 m de la **misma caché que lee el backtest** (`data/qwen-trader/cache`,
por `History`, sin red ni escritura; no se usa `/terminal/chart`: la base de velas oficiales no cubre feb–abr).

- Es una ruta con segmentos (no query string) porque el despachador del servidor solo pasa el camino a esta API.
- `producto`: símbolo `PF_…` con velas en la caché (si no, 404 `sin_velas`). `intervalo`: `15m`, `1h`, `4h` o `1d`.
- `[desde_ms, hasta_ms)` es la **ventana probada** (la del informe). Nunca sale una vela fuera de ella: solo velas completas,
  alineadas a UTC (`desde` se sube y `hasta` se baja al múltiplo del intervalo; `desde_ms`/`hasta_ms` de la respuesta son los
  alineados). Un `hasta_ms` posterior a la reserva se **rechaza** (400 `ventana_invalida`); `desde_ms >= hasta_ms` también.
- `antes_ms`: cursor de paginación (se recorta a `hasta_ms`); `limite` (1–5000): cuántas velas, **las más nuevas** anteriores al cursor.
  Para ir hacia atrás: `antes_ms` = `t` de la vela más vieja que se tiene.
- Respuesta: `{producto, intervalo, desde_ms, hasta_ms, velas, hay_mas}` con `velas: [{t, o, h, l, c, v}]` en orden ascendente (`t` = apertura en ms);
  `hay_mas` dice si hay velas más viejas dentro de la ventana. Un cursor fuera de la ventana da `velas: []` y `hay_mas: false`.
- 400 con mensaje claro: `producto_invalido`, `intervalo_invalido`, `desde_invalido` / `hasta_invalido` / `antes_invalido`
  (milisegundos enteros), `limite_invalido`, `ventana_invalida`.

## Replay contra el vivo (S4)

```
PYTHONPATH=python python3 -m balancita_engine.futures_estrategias_backtest --vs-vivo --live-db RUTA/qwen-live__live-<sello>.sqlite [--desde AAAA-MM-DD] [--hasta AAAA-MM-DD] [--json]
```

Repite la **Terminal oficial** (el snapshot) con el mismo replay sobre el período en que corrió el trader en vivo y lista dónde
coinciden o difieren sus decisiones y operaciones con las de la copia de `live.sqlite` (tablas `decisions`, `trades`, `skipped`,
`config_versions`, abiertas en solo lectura). Es un **chequeo de equivalencia de código, no una evaluación de estrategia**: el
período vivo es posterior a la reserva, no se registran intentos y el resultado no sirve para elegir ni promover nada.

- **Datos**: las velas del vivo en la misma carpeta que la base (`qwen-live_cache__candles-<producto>-<sello>.sqlite`; `--cache-dir`
  para otra carpeta, o `candles-<producto>.sqlite` de la caché del vivo) y, con funding absoluto, `futures-market-<sello>.sqlite` de
  esa carpeta (`--funding-archivo` para otro). Si faltan velas de un producto, el error nombra el archivo esperado (brecha de datos).
  `datos.cobertura` dice, por producto, desde cuándo hay velas y si alcanzan para el calentamiento; si no, `datos.avisos` lo marca.
- **Ventana**: sin `--desde`/`--hasta`, del día en que se activó esa config al día siguiente de su última decisión. El replay empieza
  en la primera vela posterior a la activación (el vivo empieza plano) y no compara nada anterior.
- **Decisiones** (una por mirada de 15 min, por hora de la mirada): `coinciden`, `difieren` (con acción y motivo de los dos lados),
  `solo_vivo` y `solo_replay` (con su explicación si el vivo omitió esa mirada, p. ej. `proceso_detenido`, o, hasta 2026-11-09, por el enfriamiento
  contado desde la hora real del fill; desde entonces se cuenta desde la mirada). `senal_coincide` cuenta las miradas donde el maestro y el portero dicen lo mismo sin importar
  las posiciones (una diferencia de posición arrastra las acciones siguientes) y `puntaje_dif_max` es la mayor diferencia del puntaje.
- **Saldo inicial**: el replay empieza con el `cash_usd` que tenía la Terminal al activarse esa config (`vivo.saldo_inicial_usd`),
  porque cada posición toma su fracción del saldo del momento (con 1000 US$ fijos el tamaño salía 0,1 % distinto y el tercer cupo, un
  resto de saldo, hasta 10 %).
- **Operaciones**: se emparejan por lado y vela de entrada; de cada par, si la salida cae en la misma vela y el neto replay − vivo en
  bp. Una operación todavía abierta en la copia del vivo no se juzga por su salida.
- **Tamaño e importes** (`operaciones.importes`, `operaciones.fuera_de_tolerancia`, `operaciones.tolerancias`): de cada par, el
  nocional, la cantidad, el neto en US$, las comisiones, el funding y las horas abierta, con vivo, replay, diferencia y si cae dentro
  de la tolerancia (`TOLERANCIAS_IMPORTES`): nocional y cantidad 1 % o 1 US$ (el tercer cupo es un resto de ~10 US$); neto 2 bp,
  comisiones 0,5 bp y funding 0,5 bp del nocional vivo, comparados **a igual tamaño** (el tamaño ya tiene su propia comparación);
  horas, una vela (5 min). Lo que queda fuera se lista con ambos valores. Las operaciones abiertas en el vivo solo comparan tamaño.
- **Límites** (en el informe): el vivo llena contra el libro y el replay al cierre de la vela (unos bp de neto); noticias no
  reproducibles; esperas y omisiones del vivo.

**Tope por lugar** (`odd/tasks/tope-por-lugar.md`, 2026-11-06): con varios cupos (`posiciones.max` > 1) el analista solo puede achicar una
posición: nocional = saldo × `posiciones.fraccion` × multiplicador, con tope en saldo × `posiciones.fraccion` (`Trader._open`,
`futures_qwen_trader.py`). Con la config activa (33 %): fuerte 33 %, normal 33 %, flojo 16,5 %, y los tres cupos siempre entran (ya no hay
un tercer cupo de ~10 US$). Rige para las entradas nuevas, igual en la Terminal y en este backtest; las abiertas no se tocan. Lo de abajo
es la copia del 2026-11-05, anterior al tope: sus operaciones con «fuerte» son de 49,5 %, así que `--vs-vivo` contra ella marca el tamaño.

### Resultado con la copia del 2026-11-05 (config `37f572…`, 2026-11-02 14:20 → 2026-11-05 03:45 UTC)

213 de 213 decisiones del vivo coinciden (misma acción, mismo maestro y portero, puntaje idéntico); las 33 miradas que solo tiene el
replay se explican (30 con el proceso del vivo detenido, 3 por el enfriamiento desde la hora real del fill, que desde 2026-11-09 se mide desde la mirada como en el replay — `docs/terminal-ciclo-de-vida.md`); 9 de 9 operaciones
emparejadas (6 cerradas con la salida en la misma vela y neto dentro de ±2 bp; 3 siguen abiertas en el vivo). Con el saldo inicial del
vivo (998,68 US$) **el tamaño coincide**: 494,34 / 494,34 US$ (33 % × 1,5 del saldo), el tercer cupo 9,98 / 9,98 US$; comisiones y
funding difieren menos de 0,0001 US$ y el neto hasta 0,09 US$ (≤ 2 bp: libro vs. vela).
