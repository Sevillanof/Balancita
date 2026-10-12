# Criterios de revisión del 7 de diciembre de 2026 (congelados el 2026-10-12)

Fijados antes de capturar datos nuevos y de calcular cualquier resultado. No se modifican retrospectivamente. Cualquier cambio se anota en un apartado de enmiendas con fecha y motivo, sin borrar lo anterior.

Alcance: solo paper, solo datos públicos, estrategias congeladas (C29, C30, C32, Kronos), captura de libro y operaciones de BTC y ETH. Sin nuevas estrategias, sin tocar los últimos 60 días ni `holdout`.

## A. Estrategias forward
Una estrategia se marca **para revisión** solo si cumple todo:
1. ≥ 100 operaciones independientes cerradas (agrupadas por día y producto).
2. Neto medio > 0 tras el modelo de costes vigente.
3. *t* con errores agrupados > 2.
4. El resultado no depende de ≤ 3 operaciones (neto > 0 sin ellas).
5. La significación se corrige por el número de pruebas acumuladas del registro.
6. Se informa por separado la fracción `recovered` y el resultado sin ellas.
Cumplirlo no demuestra rentabilidad: indica que hay que mirar la estrategia con más cuidado.

## B. Costes
- Spread cotizado, impacto de 100 USD y 1.000 USD, y banda de ejecución maker (optimista y conservador) para BTC y ETH, con tres categorías separadas (observado, simulado, estimado).
- Un recorte de costes solo cuenta si el maker conservador mejora el coste neto con selección adversa incluida.

## C. Calidad de la infraestructura
- Cobertura del colector ≥ 95 % durante el piloto; huecos explicados; sin saturación; p99 de latencia dentro del límite fijado en T2c.
- Crecimiento de disco proyectado compatible con el equipo.

## D. Decisión
Salidas permitidas: (1) ampliar la captura a 8 productos; (2) pausar el laboratorio; (3) preregistrar una única hipótesis nueva, con presupuesto de pruebas declarado y análisis posterior a la revisión. Ninguna prueba predictiva con datos del libro antes de esta revisión.

## Enmiendas
(ninguna)
