# RE-1: Reversión Extrema de 4 Horas. Resultado

Solo paper, una única especificación causal congelada y subida antes de ejecutar (`re1_spec.json`): movimiento de 4 h con |retorno| ≥ percentil 99 de los 90 días previos, entrada contraria en t+2, horizontes 24 h (principal) y 4 h (diagnóstico). Datos hasta 2026-08-01; lo reservado no se usó y `holdout` no se ejecutó. El historial está contaminado para confirmar la hipótesis (nació de una referencia post hoc), así que esto no es validación independiente.

**Veredicto: 24 h ventaja no demostrada; 4 h evidencia desfavorable. No es candidata a implementar.**

| | 24 h (principal) | 4 h (diagnóstico) |
|---|---|---|
| Episodios / clusters | 742 / 262 | 742 / 262 |
| Bruto medio | +20,2 pb (IC90 −33 a +75) | −8,2 pb (IC90 −29 a +14) |
| Neto medio | +7,2 pb | −21,3 pb |
| Umbral exigido | 91,9 pb | 45,8 pb |
| Acierto bruto | 53,8 % | 48,5 % |
| Mediana / media recortada 5 % (bruto) | +38,4 / +24,5 pb | −4,9 / −2,3 pb |
| Sin HYPE ni ZEC (neto) | +6,7 pb | −16,0 pb |
| Tercios cronológicos (neto) | +24,3 / +3,5 / −6,3 | −15,7 / −23,0 / −25,1 |
| Con funding observado (solo desde oct-2025, 77 clusters) | neto −3,4 pb, evidencia insuficiente | neto −25,0 pb |
| Control aleatorio equivalente (producto, trimestre, volatilidad, lado) | neto −38,8 pb; solo el 1 % de sorteos iguala a RE-1 | neto −16,2 pb; el 76 % iguala o supera |
| Espejo (continuación) | neto −33,2 pb | neto −4,8 pb |

## Lectura
- El +93 pb de la referencia era en gran parte un efecto de selección: con umbral causal el bruto a 24 h baja a +20 pb y su IC90 incluye cero y una pérdida de 33 pb.
- El efecto se apoya en pocos episodios: los 10 mayores suman 22.128 pb, más que el total (14.988 pb). Sin ellos el resto es negativo, aunque la mediana es positiva (+38 pb): hay colas de pérdida grandes.
- Los tercios se degradan en el tiempo (+24, +3,5, −6 pb) y por producto el signo cambia (SOL −49 pb, ADA −11 pb, NEAR +60 pb, XBT +50 pb).
- Con funding, en la ventana disponible, el neto pasa a −3,4 pb.
- Contra el control a 24 h gana, pero ese control tiene bruto −26 pb, así que la comparación es favorable en parte porque entrar al azar con el mismo lado pierde en esa muestra. No lo leo como ventaja.
- A 4 h no hay señal.

## Pruebas registradas
RE-1 suma 2 pruebas (24 h y 4 h). Acumulado de esta línea de investigación: 6 (FO-1 ×4, RE-1 ×2). No se cambió ningún parámetro tras ver resultados.

Archivos: `re1_spec.json`, `re1_run.py`, `re1_test.py`, `re1_resultados.json`, `../registro-pruebas.json`.
