# Retención de la base de captura sin bloquear el event loop

## Problema

`capture` borraba eventos viejos con `store.trimRawEvents()` cada 120 s. `node:sqlite` es síncrono, así que mientras
la llamada corre el proceso no atiende WebSocket, sondeos REST ni temporizadores. Una llamada podía borrar hasta 20
lotes de 5.000 filas y tocar triggers, sobre una base de unos 3,3 GB. En la Mac se vieron huecos de 10 a 32 s en
todas las fuentes de la captura cada 2 minutos, mientras el colector del libro (otro proceso) seguía sin huecos.
Esa parada se registraba como un incidente de red (`poll_stuck`).

## Cambios

- `retention-runner.ts`: la retención corre en pasos pequeños (un lote por llamada) y cede el event loop entre
  pasos. El tamaño del lote se adapta para que cada paso dure cerca de 40 ms (se reduce a la mitad si un paso
  tarda más de 60 ms, crece un 50 % si tarda menos de 10 ms; entre 50 y 5.000 filas). Un ciclo no se solapa con
  otro y se corta a los 20 s de reloj para seguir en el siguiente. El ciclo pasa de cada 120 s a cada 15 s.
- `trimRawEvents` acepta `batchSize` y `vacuumPages`, y `done` ahora significa de verdad "no queda nada por
  borrar" (antes, con un solo lote por llamada, informaba `false` aunque no quedara trabajo).
- Las garantías no cambian: los triggers de inmutabilidad se retiran y se restauran dentro de la transacción de
  cada lote; las ventanas de retención (tickers 24 h, eventos 7 días, copia cruda 24 h) son las mismas; sigue
  habiendo un único escritor.
- `retention.jsonl` (junto a la base de mercado): una línea por ciclo con pasos, filas, duración total, paso más
  largo y tamaño de lote.
- `eventloop.jsonl`: cada minuto, retraso p50, p99 y máximo de los temporizadores del proceso (`loop-monitor.ts`).
  Un máximo grande con la red sana indica un proceso bloqueado o una Mac dormida.
- Detección: un plazo de sondeo o una comprobación del WebSocket que se ejecuta más de 2 s tarde se registra como
  `process_blocked` (informativo), no cuenta como incidente de red y recibe un plazo más antes de darse por colgado.
  Si el socket sigue mudo después, se reconecta como antes.
- `FUTURES_RETENTION_MODE=legacy` restaura la llamada única de antes, solo para medir antes y después.

## Medición antes y después

`pnpm --dir server retention:bench --db <COPIA> --mode legacy|incremental --shift-minutes 2` ejecuta el trabajo de un
ciclo de 2 minutos sobre una copia de la base y mide cuánto se atrasa un temporizador de 5 ms mientras tanto. Toma
el cerrojo de escritura, así que no corre contra la base viva mientras `capture` funciona.

Base sintética de 40.000 tickers (filas pequeñas, solo para comprobar el banco):

| Modo        | Parada máxima del event loop | Pasos |
| ----------- | ---------------------------- | ----- |
| legacy      | 398 ms                       | 1     |
| incremental | 80 a 90 ms                   | ~100  |

**No está medido sobre la base real de 3,3 GB.** Esa medición es la que decide si basta con el trabajo por pasos. Si
algún paso supera de forma sostenida los 100 ms con el lote mínimo, el siguiente paso es mover la retención a un
worker con su propia conexión SQLite (sin segundo escritor de eventos: solo borra), pero no se hace sin esa medición.

## Pruebas

Borra todo lo vencido en pasos pequeños y conserva lo reciente, con el guard de inmutabilidad restaurado; cede el
loop entre pasos; adapta el lote; respeta el presupuesto de tiempo; no se solapa; sigue ingiriendo filas nuevas
mientras borra las viejas; el modo legacy; el medidor de loop; y los casos de `process_blocked` en el sondeo y en el
vigilante del WebSocket.

## Corrección tras medir sobre la base real (13-oct)

La medición sobre una copia consistente de 3,5 GB mostró que el modo incremental
inicial seguía bloqueando ~2 s por paso incluso con lote 50: la consulta
`feed='ticker' ORDER BY rowid LIMIT n` recorría desde el rowid 1 unas 626 mil
filas de trades antes del primer ticker, así que el coste era fijo por paso y no
dependía del lote. Ahora la poda de tickers camina por ventanas de rowid con un
cursor (`rowid>cursor AND rowid<=cursor+lote`), de modo que cada paso toca como
máximo `lote` filas. Además los límites (bisección) se reutilizan 5 s y se corrigió
que la última fila quedara sin borrar cuando todas estaban vencidas. En la copia,
un prototipo equivalente dio pasos de p50 2,5 ms y máximo 6,5 ms.

Segunda medición (commit 19dd808, copia real): pasos típicos de 2 ms, pero el primero
de cada ciclo tardaba 180–430 ms porque `bound()` pedía `MIN(rowid), MAX(rowid)` en la
misma consulta (recorre toda la tabla; con un solo agregado es O(log n)) y lo hacía
tres veces. Ahora son dos consultas `ORDER BY rowid LIMIT 1` / `DESC LIMIT 1`, y el
cursor salta los rowids vacíos (el hueco de 2,2 millones de rowids borrados) con una
consulta O(log n) en lugar de recorrerlos en ventanas. El modo `legacy` conserva su
tope de 20 lotes, de modo que sobre una base fría puede tardar varias llamadas en
llegar a los tickers (el cursor persiste entre llamadas).

## Resultados finales sobre la copia real (commit 73739c4)

Instantánea consistente (`VACUUM INTO`, 3,5 GB, 1,10 millones de eventos), copias
idénticas por modo, shift de 2 min:

|                                                     | Resultado                                                                      |
| --------------------------------------------------- | ------------------------------------------------------------------------------ |
| Paso más largo en régimen estacionario              | 16–29 ms                                                                       |
| Arranque en frío (~900 pasos, un ciclo)             | p50 5 ms, p99 47 ms, un paso de 102 ms                                         |
| Con ingesta concurrente (12 tickers/s + 4 trades/s) | p99 26 ms, máximo 82 ms, bloqueo máx. del monitor 83 ms                        |
| Latencia de append durante la poda                  | p50 0,26 ms, máx. 11 ms                                                        |
| Retención frente a entrada                          | 351–413 filas por ciclo de 2 min más recorte, frente a ~418 de entrada real    |
| Integridad                                          | `quick_check` ok, triggers restaurados, velas, funding y analítica sin cambios |
| `legacy` hasta done desde un proceso nuevo          | 45 llamadas, paso más largo 293 ms                                             |

Límites: el banco no reproduce los silencios reales de 7–47 s (en la copia el
modo legacy bloquea ~1 s), así que la magnitud en vivo debe confirmarse con
`retention.jsonl`, `eventloop.jsonl` y `resilience.jsonl`. Que la eliminación por
ciclo quede ligeramente por debajo de la entrada no prueba acumulación (no todos
los eventos nuevos están vencidos): hay que comprobar en vivo que el trabajo
pendiente y el tamaño de la base se estabilizan. La copia no tenía el WAL ni la
fragmentación de la base viva. `caffeinate -s` está verificado enchufado; no con
batería ni con el equipo desatendido.
