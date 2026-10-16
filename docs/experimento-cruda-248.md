# Experimento offline #248: conservar el mensaje original de Kraken

Estado: experimento OFFLINE con datos SINTÉTICOS. No lee ninguna base ni captura, no se conecta a Kraken, no toca la captura, el servidor,
las estrategias, el forward ni el camino actual de Kraken. No decide nada operativo. Código en `python/experimentos/cruda_parquet/`.

## Qué se comparó

Misma mecánica de escritura en los dos candidatos (época reclamada con marcador exclusivo, bloque `.tmp` + renombrado, línea de manifiesto que
CONFIRMA el bloque, recuperación que nunca promueve un bloque parcial). Solo cambia el formato del bloque:

- **A**: biblioteca estándar, bloques comprimidos con zlib o lzma, hash sha256 al final.
- **B**: un archivo Parquet por bloque con el payload original en una columna binaria (`raw_bytes`), más identidad, hora de recepción, hora y
  secuencia del proveedor como TEXTO y `raw_sha256`. Parquet no se compara byte a byte (cambia con la versión de la biblioteca): se compara
  el payload de cada registro, la cantidad y el hash por registro.

pyarrow 21.0.0 está fijado con hashes de las ruedas en `requisitos-b.txt`, solo para un entorno virtual aparte fuera del repositorio. No está en
`pyproject`, lockfiles, workflows ni `ci_weights.json`. El CI no instala pyarrow: las pruebas de B se SALTAN allí y D las repite en local.
Verificado con ruedas con hash en Python 3.9, 3.12 y 3.13 (59 pruebas, 1 salto esperado).

## Garantías de referencia (BAL-REV-183-DURABILIDAD-09)

- Un registro está **confirmado** solo cuando su bloque se selló Y la línea de manifiesto se sincronizó (definición del escritor). Es una
  confirmación LÓGICA. La durabilidad física (corte de luz, discos que mienten en `fsync`) NO está probada por nada de este experimento.
- La derivación de referencia consume solo confirmados. `confirmacion.compare_paths` la contrasta con el camino que consume pendientes y rotula
  la divergencia: nunca llama «reproducible desde archivo» a lo que consumió pendientes perdidos (`reproducible_from_archive` es falso si se
  perdió algo, aunque esa derivación no lo note; hay prueba).
- Con SIGKILL real se pierde exactamente el sufijo sin sellar. No se eligió frecuencia de sync ni ventana de pérdida aceptable.
- Conexión en vivo, punto de conexión, pérdida tolerable, backpressure y parada requieren una propuesta operativa aparte.

## Mediciones (sintéticas; este contenedor, disco virtual; una corrida cada una)

Corpus de 97 650 mensajes (255 MiB, media 2,9 KB, p50 170 B, máx. ~66 KB). Todas dentro de los topes: 2 GiB en disco (el total mayor fue 540 MiB),
10 min por corrida (la mayor, 2 min) y 1 GiB de memoria (el pico mayor fue 310 MiB). Ida y vuelta exacta y derivación idéntica al corpus en
todas. Los dos candidatos en Python 3.9 para que la comparación sea justa; B en Python 3.9.25 con pyarrow 21.0.0.

| Candidato | Escritura (reg/s) | Archivo | Razón | Memoria pico escritura | Verificar todo | Reconstruir |
|---|---|---|---|---|---|---|
| A zlib (3.9) | 4 561 | 138 MiB | 1,85 | 106 MiB | 3,9 s | 4,5 s |
| A zlib (3.13) | 7 076 | 138 MiB | 1,85 | 56 MiB | 2,8 s | 3,7 s |
| A lzma (3.13) | 1 954 | 129 MiB | 1,98 | 58 MiB | 8,7 s | 9,5 s |
| B zstd (3.9) | 35 574 | 120 MiB | 2,12 | 147 MiB | 1,7 s | 2,9 s |
| B snappy (3.9) | 30 091 | 246 MiB | 1,04 | 163 MiB | 1,9 s | 2,8 s |

La razón de compresión depende del corpus sintético y NO se extrapola a Kraken. Consultas (rango+producto, un registro): B igual o más rápido
(0,05–0,12 s contra 0,15 s), memoria de consulta mayor en B (hasta 310 MiB contra 85 MiB).

Costo y latencia de confirmar (alternativas medidas; A zlib / B zstd, 20 000 mensajes, Python 3.9):

| Registros por bloque | Latencia máx. de confirmación A / B | Se pierde al matar (pendientes) | Bloques |
|---|---|---|---|
| 100 | 0,07 s / 0,02 s | 100 | 200 |
| 1 000 | 0,30 s / 0,05 s | 1 000 | 20 |
| 10 000 | 0,75 s / 0,22 s | 534 (corte por bytes) | 7 |

Es el compromiso medido: bloques chicos confirman antes y pierden menos, pero hacen más archivos y más `fsync`. El `fsync` de este disco virtual
no es representativo del de la Mac: no se concluye nada sobre el costo real del sincronizado.

## Informe según BAL-COORD-248-VIABILIDAD-01

**(a) Defectos arreglables del flujo actual (sin capa nueva).** Los REST tickers guardan un evento ya interpretado (precios pasan por `Number`,
`seq` y hora de evento son nuestra hora de recepción, cotizaciones incompletas se saltean sin rastro). El WebSocket decodifica antes de guardar
y descarta lo que no valida. Estos puntos se arreglan en el código existente. La discrepancia de velas (`open` de 18 de 22 buckets) tiene una
hipótesis sin verificar (convención de apertura); este experimento NO la prueba ni la arregla.

**(b) Evidencia que hoy se pierde.** Mensajes rechazados o no válidos, el texto exacto de los tickers REST, los eventos de conexión y el orden de
llegada completo. Un archivo crudo la conservaría hacia adelante; no explica el hueco de 38 h ya ocurrido ni resuelve datos históricos.

**(c) Ventajas y costo.**

| | A (stdlib) | B (Parquet) |
|---|---|---|
| Escritura medida | 4,6 mil reg/s (3.9) | 30 a 36 mil reg/s |
| Tamaño medido (sintético) | 138 MiB (zlib) | 120 MiB (zstd) |
| Dependencia nueva | ninguna | pyarrow (rueda binaria grande), un entorno aparte |
| Complejidad de código | formato propio a mantener | formato estándar, legible por otras herramientas |
| Lectura por columnas, consultas | por bloque completo | columnar nativo (no se aprovechó: el payload es una sola columna) |
| Riesgo de migración | bajo, formato propio sin terceros | medio: versión de pyarrow, ruedas por plataforma, evolución del formato |
| Mantenimiento | todo propio, incluido el formato | dependiente de terceros |
| Efecto sobre el paper | ninguno: no está conectado | ninguno: no está conectado |

Lectura honesta: B es más rápido y algo más chico, pero el beneficio se mide sobre un corpus sintético, no es una razón para conectar nada, y
trae una dependencia que hoy el proyecto no tiene. A alcanza como referencia simple. La elección, y si conviene una capa cruda, queda para la
decisión del revisor.

## Lo que NO se demuestra

Corte de luz y mentiras de `fsync`; compresibilidad ni tamaños de Kraken real; tamaño de los feeds reales (nunca medido); costo de una escritura
extra en el proceso que ya tuvo bloqueos; si Kraken tolera una conexión adicional; que Parquet arregle las velas.

## Presupuesto propuesto para una prueba representativa futura (NO autorizada, no se ejecuta)

Solo con orden explícita: una medición de metadatos acotada para estimar bytes por feed (sin leer valores), luego una corrida sintética con la
mezcla de tamaños medida, el mismo escritor y los mismos topes (2 GiB, 10 min, 1 GiB), y recién después una propuesta operativa con punto de
conexión, tamaño de bloque, política de sincronización y de parada.

## Reproducir

```
PYTHONPATH=python python3 -m experimentos.cruda_parquet.medir --formato A --codec zlib --registros-lista 100000 --bloque 10000
uv venv ~/.venvs/cruda-b && uv pip install --python ~/.venvs/cruda-b/bin/python --require-hashes -r python/experimentos/cruda_parquet/requisitos-b.txt
PYTHONPATH=python ~/.venvs/cruda-b/bin/python -m experimentos.cruda_parquet.medir --formato B --codec zstd --registros-lista 100000 --bloque 10000
PYTHONPATH=python:python/tests ~/.venvs/cruda-b/bin/python -m unittest discover -s python/tests -p "test_cruda*.py"
```
