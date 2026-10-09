# Funding como información nueva para Qwen

Pedido de Fran (2026-10-09): tras QC-01 a QC-04 (con velas Qwen no tiene información predictiva), probar el funding como dato nuevo. Qwen sigue respondiendo directo, sin pensar.

## Qué es el funding

En un perpetuo no hay vencimiento; cada hora los largos pagan a los cortos (o al revés) según la distancia entre el perpetuo y el precio spot. Funding alto = mucha gente larga pagando = mercado apalancado al alza. Es una señal lenta (horas), no de 30 minutos.

## Reglas fijadas antes de medir

- Línea de STATE `funding: <high|normal|low> (pctl30d=NN, longs pay|shorts pay)`. Percentil del último periodo horario cerrado contra los 720 periodos anteriores (30 días, excluye el periodo juzgado, nunca el historial entero). `high` >= 90, `low` <= 10. Un periodo cuenta solo cuando cerró y pasaron 10 min de publicación. Tasa relativa por hora (comparable entre productos). Sin 30 días de historia: `funding: unknown`.
- `trade_action@5` = `@4` + campo `funding` antes de `lessons`. Se deriva en código (`futures_funding_context.funding_question`); el catálogo y `@4` no cambian, así que el servicio en vivo sigue con `@4`.
- Brazos (mismo rango, mismo trigger, mismas velas): `v4` (sin línea), `--qwen-funding on`, `placebo` (la línea de 7 días antes: mismo formato, dato equivocado), `contrarian` (funding alto vende, bajo compra, sin modelo), `follow` (al revés). Comparar con `futures_replay_compare`.
- Antes de lanzar, contar horas extremas por rango; con menos de ~20 el resultado se declara "no concluyente" de antemano. Rangos elegidos por el funding, no por retornos.

## Tareas

- [x] FC-01 Backfill: `pnpm --dir server funding:backfill [--db …] [--products …]`. Kraken lista ~1 año de periodos horarios por producto en una respuesta pública (8838 periodos desde 2025-10-06). Idempotente. Hay que correrlo sobre la base de mercado de los replays (`market-90d.sqlite`) y la de dev.
- [x] FC-02 Línea de funding y pregunta v5 (`futures_funding_context.py`, campo `funding` en `build_state`, `BlindQwen(funding=…)`).
- [x] FC-03 Brazos de replay: `futures_replay --qwen-funding off|on|placebo|contrarian|follow`.
- [x] FC-04 Estudio sin modelo `scripts/funding_signal_study.py` (percentil vs retorno futuro a 1/8/24 h, 8 productos, 1 año).
- [ ] FC-05 Correr en la Mac (hace falta `pnpm dev` parado y el OK de Fran, el replay calienta la GPU).
- [ ] FC-06 Si hay señal en FC-05: valorar poner v5 en el catálogo (activa funding en vivo, requiere leer funding en el servicio Q) y probarlo con el horizonte de C29/C30 (24 h), no a 30 min.

## Calor de la GPU en el replay

El calor viene de Metal, no de la CPU. Propuesta: variable `QWEN_REPLAY_PAUSE_MS` (pausa entre preguntas) o `-ngl` menor en llama-server. Pendiente de elegir con Fran; no está implementado.

## Registro

- 2026-10-09 (FC-04, 8 perpetuos, 2025-11 a 2026-10, 64 942 horas, coste ida y vuelta supuesto 10 pb): correlación de rangos percentil-retorno −0,01 (1 h), −0,03 (8 h), −0,02 (24 h). Retorno medio posterior por banda de percentil: 1 h de +2,4 pb (bajo) a −0,7 pb (alto); 8 h de +17,1 a −5,4 pb; 24 h de +34,9 a −3,9 pb. Estrategia contraria (corto con pctl >= 90, largo con pctl <= 10): bruto 1,5 pb a 1 h (neto −8,5), 11,2 pb a 8 h (neto +1,2), 18,9 pb a 24 h (neto +8,9). Por producto a 24 h: XBT +20,7, ETH +29,5, ZEC +63,6, HYPE +26,0, XRP +18,3, ADA +12,7, NEAR −2,9, SOL −16,9. Cautelas: las ventanas de 8 y 24 h se solapan y los 8 productos se mueven juntos, así que los t reales son bastante menores que los calculados (5,4 a 24 h); el año incluye tendencia (la banda baja gana en general, también fue mayormente un mercado con deriva); no se descontó el funding pagado. Lectura: hay una inclinación contraria débil a 8-24 h, nada a 1 h. Qwen se juzga a 30 min, donde el funding no dice nada: probarlo a ese horizonte probablemente sale en blanco. Para que valga hay que juzgarlo con el horizonte de una estrategia lenta (C29/C30, 24 h).
