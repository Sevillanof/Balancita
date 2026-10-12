# Nuevas fuentes de ventaja: estudio de viabilidad

Fecha: 2026-10-12. Solo paper. Solo viabilidad: no se implementó ninguna estrategia, no se ejecutó `holdout` y los últimos 60 días siguen reservados. Los resultados de mx-funding-v1, mx-momentum-v1, mx-meanrev-v1 y el combinador no se tocan.

## Qué se hizo y qué no
Solo se consultaron cobertura, huecos, estabilidad de revisiones y volatilidad por producto en la API pública de Kraken Futures. **No se calculó ninguna relación señal-retorno**, por eso el registro de pruebas (`registro-pruebas.json`) no tiene configuraciones evaluadas: solo sondeos de disponibilidad y candidatos preregistrados con estado `no ejecutada`.

## Datos verificados (API pública, sin credenciales)
| Dato | Fuente | Profundidad | Notas |
|---|---|---|---|
| Open interest (1 h) | `charts/v1/analytics/{PF}/open-interest` | desde 2023-03-07 (HYPE 2025-01-24); SOL termina el 2025-09-02 (hueco) | ~31.570 puntos por producto; 2.000 por petición |
| Liquidaciones (volumen) | `.../liquidation-volume` | desde 2023-03-01 (HYPE 2025-01-24) | los 8 productos |
| CVD / flujo agresor | `.../cvd` | ≥700 días | acumulado: usar `buy_volume − sell_volume` por intervalo |
| Long/short, top traders | `.../long-short-info`, `top-traders` | cobertura parcial | solo informativo |
| Funding horario | `historicalfundingrates` | tope ~8.909 h, desde 2025-10-06 | ~1 año, no más |
| Velas 1 h | `charts/v1/trade/{PF}/1h` | >240 días | ya en la base de historia |

Revisiones: en 72 buckets de OI re-consultados durante 75 s y en 1.571 horas XBT capturadas en vivo no hubo revisiones. Sigue pendiente comprobar que el bucket de la hora en curso no se publica a medias (regla: usar solo buckets cerrados, decidir en t+2).

## Costes y movimiento mínimo
Ida y vuelta por producto (modelo único `futures_costs.py`, ~10 pb en XBT). Movimiento bruto mínimo para ser distinguible: `coste + 3σ/√N`, con σ del horizonte y N episodios independientes.

| Horizonte | N=300 | N=1.000 | N=3.000 |
|---|---|---|---|
| XBT 4 h | 27 pb | 19 pb | 16 pb |
| XBT 24 h | 50 pb | 32 pb | 23 pb |
| ZEC 4 h | 58 pb | 38 pb | 28 pb |
| ZEC 24 h | 122 pb | 73 pb | 49 pb |

Lectura: en altcoins volátiles el piso es alto; con 8 productos correlacionados (0,76–0,90) hay ~1,3–1,5 apuestas independientes, así que N real es mucho menor que N nominal.

## Comparación crítica
| | 1. Order flow | 2. Funding + OI | 3. Momentum relativo | 4. Rupturas con volumen/volatilidad |
|---|---|---|---|---|
| Razón económica | Presión agresora desbalanceada mueve precio por impacto | Funding extremo + OI alto = posicionamiento apretado; su desarme (OI cae, liquidaciones) fuerza reversión | Los líderes relativos persisten (flujo lento de capital) | Rupturas validadas por volumen indican información nueva |
| Datos | CVD, liquidaciones, cinta con lado agresor | Funding (1 año), OI y liquidaciones (3,5 años) | Velas (240 d) | Velas (240 d) |
| Calidad | Muy buena, independiente del precio | Buena; funding corto, OI SOL con hueco | Buena pero universo de 8 (sesgo de supervivencia) | Buena |
| Riesgo de look-ahead | Alto: flujo contemporáneo al retorno; hay que entrar en t+2 | Medio: buckets abiertos y funding publicado después | Bajo | Bajo, pero fácil de sobreajustar |
| Horizonte | minutos a horas (cobra comisión muchas veces) | 4–24 h | días | horas a días |
| Coste a superar | 10–60 pb por ida y vuelta, alta rotación | mismo, pocos eventos | mismo, rotación baja | mismo |
| Solapamiento con lo ya refutado | Impulso+flujo a 5 min ya DESCARTADO (−12,1 pb) | mx-funding-v1 ya falló (usa solo funding) | mx-momentum-v1 ya falló | Familia de momentum |
| Experimento más simple que lo refuta | Retorno bruto a t+2 tras onset de desbalance extremo vs control aleatorio | Eventos de desarme (OI −X %, liquidaciones altas, funding extremo) → reversión bruta a 4–24 h con IC90 | Long/short cross-section semanal vs control permutado | Rupturas a 24 h vs rupturas aleatorias |
| Potencia | Alta (muchos eventos) pero con piso de coste inalcanzable en horizontes cortos | Media (cientos de eventos con 3,5 años de OI, pero funding solo 1 año) | Baja (8 productos) | Media, pero ya cubierta por momentum |

## Criterios de refutación (fijados antes de mirar retornos)
Una hipótesis queda refutada si: (a) hay menos de 100 clusters independientes (episodios separados por ≥12 ciclos y por producto/día), o (b) el límite inferior del IC90 del retorno bruto de reversión es menor que el coste de ida y vuelta + 3σ/√N del horizonte (≈28 pb en el caso base). Entrada siempre en t+2. Análisis con y sin HYPE y ZEC. Como máximo 5 variantes por familia, todas registradas antes de correrlas.

## Recomendación
**Implementar primero la 2: eventos de desarme de Funding + OI (deleveraging).** Razones: es la única con una razón económica distinta de lo ya refutado (no es otra regla de velas ni otro funding puro), usa OI y liquidaciones con 3,5 años de historia, y el horizonte de 4–24 h es el único donde el coste de ~10 pb se puede amortizar. La limitación honesta: el funding solo tiene 1 año, así que los eventos que dependan de funding extremo tendrán menos muestra; por eso se preregistra primero una variante solo OI+liquidaciones.

Segunda: 3 (momentum relativo), como prueba barata pero con potencia baja. Order flow queda como filtro/diagnóstico de la 2, no como estrategia propia (ya falló a 5 min). Rupturas (4): no recomendada, duplica momentum y es la más propensa a sobreajuste.

Probabilidad de éxito: baja en todas. Lo más probable es otro resultado negativo, y está bien: es una prueba barata de refutar antes de construir nada.

## Control del sesgo de selección
- Cada configuración probada irá en `registro-pruebas.json` antes de ejecutarse (nombre, parámetros, fecha, resultado).
- Sin ajuste de parámetros: especificaciones fijadas a priori, máximo 5 variantes por familia.
- DSR con el número real de pruebas del registro.
- Últimos 60 días reservados; `holdout` no se ejecuta hasta que haya una especificación congelada.
