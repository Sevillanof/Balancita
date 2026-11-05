# medir-noticias

Medir, con datos reales, qué noticias analizadas por Qwen anticipan el precio de ETH, antes de cambiar las reglas de noticias del trader.
Solo lectura sobre las bases; no cambia el trader ni los esquemas.

## Specs

- **S1** — Por cada noticia con análisis v2 `done` (relevancia `news_relevance_btc` y dirección `news_direction`), calcular el movimiento de ETH (`PF_ETHUSD`, velas oficiales de 5 m) a **1 h, 4 h y 12 h** desde que Balancita la conoció (`known_at = max(received_at, analyzed_at de ambas preguntas)`), en puntos básicos, con signo a favor de la dirección (alcista +, bajista −; neutral sin signo, se informa aparte).
- **S2** — Agregar por **fuente**, **relevancia** (none/low/medium/high) y **dirección**: cantidad, % de aciertos y pb medio a favor por horizonte; y la latencia de ingesta por fuente (`received_at − published_at`, mediana y p90, en minutos).
- **S3** — Las noticias descartadas sin análisis (`skipped_stale`, incluido el filtro de titulares de precio) se informan aparte: cantidad por motivo y movimiento absoluto de ETH a 1 h tras `received_at`, para ver si el filtro tira noticias que movieron el mercado (caso 4-nov 14:00 UTC, «Live updates: Bitcoin and stocks reverse overnight plunge…»).
- **S4** — CLI de solo lectura: `python -m balancita_engine.futures_news_effect --news-db <ruta> --market-db <ruta> [--desde AAAA-MM-DD] [--hasta AAAA-MM-DD] [--json]`. Abre las bases en modo `ro`; sin `--json` imprime tablas legibles; con `--json` un objeto estable. Una vela faltante deja ese horizonte sin dato (no se inventa precio).
- **S5** — Documentar el comando y cómo leer el informe en `docs/` (una sección corta).

## Tasks

| ID  | Specs | Ruta                                                                                                                                      | Estado           | Commit                     |
| --- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | -------------------------- |
| T1  | S1-S4 | parent (workers no arrancan fuera del repo): `python/balancita_engine/futures_news_effect.py`, `python/tests/test_futures_news_effect.py` | hecha (10 tests) | — (lo commitea el usuario) |
| T2  | S5    | parent: `docs/medir-noticias.md`                                                                                                          | hecha            | —                          |
| T3  | S1-S3 | parent: correr sobre el respaldo del VPS (`~/balancita-vps-respaldo/ultima-copia`) y resumir                                              | hecha            | —                          |

## Log

- **L1** (usuario, 2026-11-05): «Si a los dos» — respuesta a «¿Querés que arme algo para medir qué noticias predicen el precio antes de tocar las reglas?».
- **L2** (evidencia, 2026-11-05): en el VPS `priority_v2` nunca disparó (relevancia `high` 1 de 434); noticias relevantes aciertan 55 % a 4 h y 41 % a 12 h (Mac); la suba del 4-nov 14:15 UTC (+5,2 %) tuvo su noticia causal descartada por el filtro de titulares de precio. Regla del repo: el agente no hace commit ni push.
- **L3** (resultado T3, copia VPS 05-nov): 195 noticias con dirección, 239 neutrales, 826 descartadas. Relevancia media: acierto 46 % / 54 % / 33 % (1/4/12 h), −26,8 pb a 12 h; high n=1. Bajistas 159 vs alcistas 36. Entre las descartadas que más movieron ETH en la hora siguiente (≈+250 pb) están los «Live updates» del hack de Binance y de la Blue Wave del 4-nov: el filtro de titulares de precio tira las noticias que más mueven el mercado.
