# Noticias y auditor

Arreglar los briefings de noticias que fallan, revisar todos los proveedores de noticias
y que el auditor mida la dirección además de «la operación pagó». Origen: T14 de
`odd/tasks/estrategias-laboratorio.md` (L32, `analisis/vivo-noviembre/informe.md`).

## Specs

- **S1** — Briefings de noticias: «Si, implementalo» (arreglar las noticias). Hoy 552 de 1.216 briefings de Qwen terminan en error y `priority_v2` nunca disparó (`analisis/vivo-noviembre/informe.md`). Se encuentra la causa y se arregla, con un test que la reproduzca.
- **S2** — Proveedores: «analiza de nuevo a los dos, a las noticias que todos los proveedores funcionen bien y si podemos agregar nuevas noticias y quitar otras». Se mide cada proveedor de `config/news-sources.json` (disponibilidad, errores, demora, duplicados, cuántas noticias aportan y si alguna movió ETH) y se proponen altas y bajas con evidencia. Cambiar la lista de fuentes es decisión del usuario.
- **S3** — Auditor, dirección: «Si, implementalo» (sumar la dirección al auditor). Para cada mirada y cada operación, el auditor guarda además si la dirección fue correcta a 4, 12 y 24 h, y el MAE/MFE de la operación, sin cambiar los veredictos que ya calcula.
- **S4** — Auditor, mejoras: «Y si el auditor podria mejorarse». Se analizan sus límites (miradas correlacionadas, contexto de posicionamiento nulo, `portero_umbral` nulo, una fila por mirada con hasta 3 operaciones, miradas perdidas cuando el proceso está caído) y se arregla lo que sea un error; lo demás se propone.

## Tasks

| ID  | Specs  | Ruta                                                                  | Estado                                             | Commit     |
| --- | ------ | --------------------------------------------------------------------- | -------------------------------------------------- | ---------- |
| T1  | S1, S2 | worker noticias: causa y arreglo de briefings; informe de proveedores | hecha (falta decisión `priority_v2` y altas/bajas) | ver Log L3 |
| T2  | S3, S4 | worker auditor: dirección 4/12/24 h + MAE/MFE; informe de mejoras     | en curso                                           | —          |

## Log

- **L1** (usuario, 2026-11-07): «Si, implementalo y de paso analiza de nuevo a los dos, a las noticias que todos los proveedores funcionen bien y si podemos agregar nuevas noticias y quitar otras. Y si el auditor podria mejorarse.» (respuesta a: «¿Arranco por arreglar las noticias y sumar la dirección al auditor?»)
- **L2** (evidencia T2/T3): auditor guarda dirección a 4/12/24 h por mirada y por operación (tabla `operaciones` con MFE/MAE), migración aditiva y reversible; veredictos viejos idénticos en 404 miradas reales. `portero_umbral` nulo es por diseño (portero autónomo sin umbral; se propone `portero_margen`). Posicionamiento nulo: `futures_qwen_live.py` volvía antes de enganchar el `PositioningFeed` sin `state_ficha`; arreglado con test. Propuestas (sin hacer): miradas correlacionadas → contar por episodio; tabla mirada↔operaciones; reconstruir miradas perdidas al arrancar; UI con ✓/✗ de dirección y MFE/MAE. Tests: 205 Python OK, 9 vitest OK, typecheck server limpio.
- **L3** (evidencia T1): 608 intentos de briefing (1.216 filas = pendiente + final): 56 ok, 552 error. 480 `model_unavailable` por timeout de 30 s heredado de la clasificación (Qwen en el VPS pasó de ~0,4 s a ~15 s por clasificación desde el 3-nov ~15:00 UTC; probable presión de RAM/disco por el respaldo de futures-market y el chequeo de integridad, sin verificar); 71 `invalid_summary` porque el reintento no nombraba el culpable. Arreglo: timeout propio del briefing (120 s, `--briefing-timeout-seconds`), prompt más chico (titular + 240 caracteres, `PROMPT_VERSION` 4), reintento que nombra la cifra/palabra/largo. `priority_v2` no dispara por diseño: exige relevancia `high` (ninguna de 404) y solo `fed`/`fed_monetary` tienen licencia. Proveedores: 13 responden (97,7-100 %); propuestas de alta `bls_empsit`, `bls_cpi`, `fed_speeches`, `cftc`; baja opcional `bankless` (`analisis/noticias-proveedores/informe.md`). 162 tests de noticias OK.
