# Validación histórica de las tres estrategias y el combinador (PR 105)

Pregunta única: ¿alguna de `mx-funding-v1`, `mx-momentum-v1`, `mx-meanrev-v1` tiene una ventaja estadísticamente
defendible después de costes? Las reglas están congeladas: nada se ajusta con estos datos. Qwen (brazo C), C25–C31 y
Kronos quedan fuera. Un resultado favorable en un período no es una ventaja demostrada.

El protocolo se escribe en `protocol.json` (con su hash) antes de que exista ningún resultado y no se puede cambiar en
el mismo directorio de salida.

## Datos y períodos

- Velas oficiales de 1 y 5 min de los 8 productos y funding observado (`candles:backfill --days 240`, `funding:backfill`)
  en una base aparte; los 240 días terminan el 2026-10-01 (lo posterior queda para el forward).
- Validación = los primeros 180 días. **Reserva ciega** = los últimos 60: `analyze` nunca los lee; `holdout` los corre una
  sola vez (deja `holdout.lock`; un segundo intento se rechaza).
- El calentamiento sale de las ventanas de los indicadores (PR 104). Sin funding observado un episodio no tiene resultado
  neto completo: se cuenta como «no juzgado» y no entra en las cifras.

## Qué se mide

- **Episodio** = inicio de una señal (sin candidata de la misma estrategia, producto y acción en la hora anterior).
  12 relecturas de una misma condición son una oportunidad. Se informan las reevaluaciones por episodio y, para funding,
  las observaciones horarias.
- **Resultado de un episodio** = libro en sombra de su inicio (mismos niveles, costes y funding que el paper; si stop y
  objetivo caen en la misma vela se asume el stop). Ignora posiciones simultáneas y límites de capital: mide
  oportunidades, no una cuenta.
- **Estadístico primario** = PnL neto diario de la cartera equiponderada de los 8 productos (100 USD por episodio, en el
  día de salida). Los 8 productos equivalen a ~1,3–1,5 apuestas independientes (correlación 0,7–0,8), así que los
  productos son solo descriptivos. Media, IC 95 % y p unilateral por bootstrap estacionario de bloques (semilla
  20261012); Holm sobre las 3 estrategias, α = 0,05.
- **Controles**: 20 semillas × 3 horizontes de entradas aleatorias por la misma maquinaria; dan la línea base «solo
  costes» y el p de control.
- **Combinador (brazo B)** contra el brazo A: operaciones ejecutables, diferencia de bp netos por operación con IC por
  bloques de días. Solo supera si el IC excluye 0.
- **DSR** con 4 configuraciones declaradas y con 60 (estimación de todo lo probado sobre estos datos, que no está
  registrado). **CPCV y PBO** son diagnóstico: con reglas congeladas no hay selección dentro de la muestra y no deciden.

## Regla de «pasa validación» (todas)

1. Al menos 300 episodios y 60 días activos; si no, **evidencia insuficiente**.
2. IC 95 % del PnL diario con límite inferior > 0 y p ajustado por Holm < 0,05.
3. Lo mismo con un coste de ida y vuelta de 30 bp.
4. Media positiva en al menos 2 de 3 tercios cronológicos (con purga y embargo).
5. Ningún producto aporta más de la mitad del PnL neto.
6. Los bp netos por episodio superan a los controles aleatorios del mismo horizonte (p < α).

«Pasa» solo habilita seguir: queda la reserva ciega y el forward. Si los 240 días ya inspiraron las reglas, no son una
muestra limpia fuera de muestra.

## Uso

```
PYTHONPATH=python python3 -m balancita_engine.multi_validation run     --market-db <base> --out <dir>
PYTHONPATH=python python3 -m balancita_engine.multi_validation analyze --market-db <base> --out <dir>   # validation-report.json
PYTHONPATH=python python3 -m balancita_engine.multi_validation holdout --market-db <base> --out <dir>   # una sola vez
```

`run` guarda un checkpoint por bloque de 7 días y se puede parar y reanudar. Tests: `python/tests/test_multi_validation.py`.
