# Mejoras de operación: libro más seguido, miradas perdidas, despliegue

Mejoras de la operatoria pedidas por el usuario después de la sombra maker. Contexto:
`odd/tasks/maker-sombra.md` (un tercio de patas `sin_datos` por el libro cada 30 s),
`analisis/ciclo-de-vida/informe.md` (27 miradas perdidas el 3-nov; entrada fechada al llenado,
~4 s después de la mirada).

## Specs

- **S0** — Reserva (decisión del usuario): «La reserva es todo apartir del 19 de abril hasta lo nuevo que venga. Despues vamos a definir unas pruebas por pequeños tramos de la reserva.» Nada de esta feature lee la reserva para entrenar o elegir reglas.
- **S1** — «hace la 3»: guardar el libro de órdenes de ETH cada 10 s en lugar de cada 30 s (mismo rango ±0,1 %, sin deltas), con el costo de disco medido y documentado; BTC y el resto sin cambios.
- **S2** — «hace la 4» (a): que la Terminal no pierda miradas. Al arrancar (o al volver de un bloqueo), si se saltearon miradas, hace enseguida una mirada de recuperación con los datos de ese momento (incluidas las salidas de las posiciones abiertas) en vez de esperar a la próxima de :00/:15/:30/:45; las miradas pasadas que no se hicieron NO operan hacia atrás: se registran como perdidas (con lo que la fórmula habría dicho) para el auditor.
- **S3** — «hace la 4» (b): la entrada se fecha con la hora de la mirada que la decidió (no con la del llenado, ~4 s después), para que «maestro agotado» a las 24 h y el enfriamiento de 15 min funcionen como en el backtest. Cambia en vivo: «agotado» puede cerrar 15 min antes y el enfriamiento efectivo pasa de 30 a 15 min.
- **S4** — «hace la 5»: un script de despliegue único (`ops/vps/desplegar.sh` o similar) que haga, con verificaciones: PR develop→main con la cuenta Sevillanof, CI, merge, `git pull` en la VPS, instalar drop-ins, reinicio en la ventana :16-:28 y chequeos posteriores; fijar la cuenta Sevillanof para `gh` en este repo sin tocar la cuenta global; arreglar el test inestable del CI por el archivo de funding compartido (`funding-{product}.json` entre grupos de Python en paralelo).

## Tasks

| ID  | Specs | Ruta                                                               | Estado | Commit |
| --- | ----- | ------------------------------------------------------------------ | ------ | ------ |
| T1  | S1    | worker captura: libro de ETH cada 10 s                             | hecha  | —      |
| T2  | S2-S3 | worker trader: mirada de recuperación, perdidas, fecha de entrada  | hecha  | —      |
| T3  | S4    | worker operatoria: script de despliegue, cuenta gh, test inestable | hecha  | —      |

## Log

- **L1** (usuario, 2026-11-09): «1. La reserva es todo apartir del 19 de abril hasta lo nuevo que venga. Despues vamos a definir unas pruebas por pequeños tramos de la reserva. Ademas hace la 3,4,5»
- **L2** (evidencia T1): libro de ETH cada 10 s por defecto (`FUTURES_ETH_BOOK_SAMPLE_MS`), mismo formato; BTC sin libro, sin cambios. Costo medido ≈ 4,2 KB por foto: ~37 MB/día (+25 MB), cota superior ~57 MB/día; con 7 días de retención ~260-400 MB. Ya archivado en Parquet como `market_events`. 694 tests del servidor, typecheck limpio.
- **L3** (evidencia T3): `ops/vps/desplegar.sh` (`--dry-run`, `--sin-reinicio`, `--dropin`; espera el CI de push y PR, ventana :16-:27, chequeos posteriores; 45 tests con stubs) y `scripts/gh-sevillanof.sh` (gh con Sevillanof solo para ese proceso). Test inestable: `History.funding` escribe `funding-{product}.json` con `open("w")` no atómico; reproducción determinista de lectura parcial; módulo `futures_funding_cache` (escritura atómica, carpeta inyectable `BALANCITA_QWEN_CACHE_DIR`) y `ci_python_run.py` da a cada proceso su carpeta. Falta usar el módulo en `futures_qwen_trader.py` (archivo de T2).
- **L4** (evidencia T2): la entrada se fecha con la mirada (el llenado queda en `fill_ms` y el recibo); «agotado» ve 1.440 min a las 24 h, tope 36 h y enfriamiento de 15 min desde la mirada. Mirada de recuperación al arrancar o tras un bloqueo (entradas y salidas permitidas, nunca hacia atrás) y tabla `miradas_perdidas` (archivada en Parquet). Diferencial: replay de 30 días byte-idéntico; en vivo con libro cambia `entry_ms` (4 s antes) y, por el enfriamiento más corto, hay entradas una mirada antes. No volver a la versión anterior con una posición abierta guardada por esta. 984 tests OK.
- **L5** (usuario): «pero como vas acordarte de pedirlo siempre?» → `desplegar.sh` frena (código 2) antes de instalar nada si hay un drop-in nuevo sin decidir; se decide con `--dropin` o `--omitir`. La caché de funding del trader ya escribe de forma atómica (`futures_funding_cache`).
