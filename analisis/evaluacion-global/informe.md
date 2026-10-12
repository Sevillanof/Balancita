# Evaluación global de Balancita

Fecha: 2026-10-12. Solo paper. Solo resultados ya existentes: no se ejecutó ninguna prueba nueva de rentabilidad, no se tocó ninguna estrategia ni el motor, los últimos 60 días siguen reservados y `holdout` no se ejecutó.

**Respuesta corta a tu pregunta: así como buscamos hasta ahora, no.** Repetimos una búsqueda sobre datos públicos de velas, funding, OI y flujo con muestras demasiado cortas para distinguir una ventaja realista del ruido. Cada vez que apareció algo atractivo, desapareció al ampliar la muestra o corregir por pruebas múltiples. Mi recomendación al final: **detener la búsqueda histórica y mantener Balancita como laboratorio paper con evidencia forward**, salvo que aparezca una hipótesis con información distinta (ver sección 6).

## 1. Qué probamos y qué aprendimos

| Prueba | Resultado | Dependencia |
|---|---|---|
| mx-funding-v1, mx-momentum-v1, mx-meanrev-v1 (169 días activos) | Neto −11,5 / −15,0 / −11,4 pb por episodio ≈ coste de ida y vuelta; azar −14 pb; Holm 1,0; DSR 0; 0 de 3 tercios positivos | independientes entre sí; lo hecho antes (C25–C28, reglas de velas 2 años, eventos vs reloj, impulso+flujo, maker, Qwen) apuntó igual: bruto ≈ 0 |
| Combinador | −14,8 pb, no mejora a las individuales | deriva de las tres anteriores |
| FO-1 (desarme por OI y liquidaciones), 2 corridas | Bruto −3 pb (4 h) y +5 pb (24 h), 354 clusters, indistinguible del azar; la corrida de la Mac (49 clusters) también negativa | independiente |
| RE-1 (reversión de 4 h) | 24 h: bruto +20 pb, neto +7 pb, IC90 −33 a +75; 4 h: −8 pb | **nació de una referencia post hoc de FO-1** (+93 pb), que se redujo a +20 con umbral causal |
| MR-1 (momentum relativo semanal) | Neto +127 pb/semana, no supera el umbral (IC90 del bruto −4 a +316) | independiente, pero con 8 productos vigentes hoy |
| MR-1X (universo ampliado) | Neto +58 pb/semana, p ≈ 0,36 corregido, −5,8 pb sin 3 productos, −49 pb con liquidez ≥ 5 M USD | **nació de ver MR-1 favorable** |

Pruebas de esta línea de investigación: 8 (FO-1 ×4, RE-1 ×2, MR-1, MR-1X), más las 4 declaradas de la validación (estimadas en unas 60 con los controles) y decenas de configuraciones anteriores. Con esa cantidad de intentos, un resultado con p ≈ 0,02 se espera por azar.

Hallazgos que se repiten:
1. **Ningún efecto bruto estable.** En FO-1, RE-1 a 4 h, eventos vs reloj, impulso+flujo y las reglas de velas el bruto es ≈ 0 con muestras suficientes.
2. **Lo atractivo nace de la selección.** El +93 pb de la referencia se redujo a +20 al hacerlo causal; los +127 pb de MR-1 se redujeron a +58 al ampliar; sin tres memecoins quedan en −6.
3. **Las variantes no son descubrimientos independientes.** RE-1 y MR-1X dependen de resultados observados; no suman evidencia, la contaminan.
4. **Las únicas señales positivas son débiles y están en curso:** C29 +1,68 pb (t 1,24), C30 +1,15 (t 1,0), Kronos +6,6 pb con 53 operaciones (t 0,81). Ninguna es estadísticamente distinguible de cero.

## 2. ¿Cuál es el problema principal?

| Hipótesis | Evidencia | Peso |
|---|---|---|
| **Metodología (potencia)** | Con los intervalos observados, el efecto mínimo detectable (3 errores estándar) es de ≈ 40 pb por episodio en FO-1 a 4 h, ≈ 100 pb en RE-1 a 24 h, ≈ 290 pb/semana en MR-1 y ≈ 260 pb/semana en MR-1X. Un edge realista de 10–20 pb por operación necesitaría unos 5.000–6.500 clusters independientes en 4–24 h (años de 8 productos muy correlacionados) y decenas de miles de semanas en la versión semanal. Con 3,5 años disponibles, **no podemos demostrar un edge pequeño aunque exista**. | **Principal** |
| **Información** | A ≤ 4 h el bruto es ≈ 0 de forma repetida y con potencia suficiente para descartar efectos de ≥ 40 pb. Velas, volumen, OI, liquidaciones y flujo agresor públicos no contienen señal explotable a ese horizonte; el techo de dirección de Qwen es 52–53 % (AUC 0,537). | **Alto a corto plazo** |
| **Costes** | Costes ≈ 10 pb (XBT) a 17 pb (NEAR) por ida y vuelta, 10 de ellos comisión. Pesan a ≤ 4 h (igualan o superan el bruto observado) y son despreciables a semanal (27 pb frente a σ de 1.100 pb). Abaratarlos no crea un bruto que no existe. | Medio solo a corto plazo |
| **Estrategias** | Probamos reglas de las mismas cuatro familias sobre las mismas fuentes; el problema no es que falte otra regla sino que la información y la muestra no alcanzan. | Bajo |

## 3. ¿Sigue siendo adecuado Kraken Futures?

- **Observado (público, 2026-10-07):** comisiones nivel 1 (maker 0,02 % y taker 0,05 %), spread e impacto de 1.000 USD en los 8 productos, funding de 30 días. Costes de ida y vuelta: ≈ 10,1 pb XBT, 10,4 ETH, 10,8 SOL, 13,1 XRP, 13,0 HYPE, 14,6 ZEC, 15,5 ADA, 17,1 NEAR.
- **Estimado, no medido:** deslizamiento de salidas por stop, costes de los más de 60 productos fuera de los 8 (los usamos en MR-1X por tramos de liquidez), probabilidad real de relleno maker, bid/ask histórico (Kraken no lo entrega).
- **Movimiento necesario (coste + 3σ/√N, N = 1.000):** XBT 4 h ≈ 19 pb, XBT 24 h ≈ 32 pb, ZEC 24 h ≈ 73 pb. Cuesta menos capturarlo a 24 h o más, donde el coste es 3 % de la desviación.
- **Conclusión:** la comisión de 10 pb es el piso por operación y es la misma que anuncian los competidores revisados (OKX publica 0,02/0,05). No hay evidencia de que otra plataforma ofrezca una mejora significativa y verificable, y como el bruto es ≈ 0, abaratar el coste solo reduciría pérdidas. **No recomiendo migrar.** El maker no ayuda (selección adversa −8,3 pb).

## 4. Información disponible

| Fuente | Qué se probó | Resultado |
|---|---|---|
| Velas y volumen | C25–C28, reglas 2 años, momentum, reversión, RE-1, MR-1 | bruto ≈ 0 en corto; MR-1 débil en semanal |
| Funding | mx-funding, carry delta-neutral, C32 contrarian en forward | carry descartado (+0,8 % anual); contrarian débil a 24 h (~9 pb), en forward |
| Open Interest y liquidaciones | FO-1 | sin ventaja; el disparo no anticipa precio |
| Order flow | impulso+flujo 5 min, eventos vs reloj | flujo no aporta; pierde la comisión |
| Libro de órdenes | maker (selección adversa) | solo se puede capturar hacia adelante; sin historial |
| Entre productos | pares ETH/BTC (0 de 12), MR-1, MR-1X | no concluyente; correlación 0,76–0,90 |

No encontré una fuente pública ya disponible y sin probar que prometa mucho. Lo no aprovechado es de otra naturaleza: horizontes de semanas o más (donde el coste desaparece pero la potencia empeora), datos fuera del precio (noticias, on-chain, posicionamiento), y libro capturado hacia adelante.

## 5. Papel de Qwen

Qwen no ha demostrado capacidad predictiva: sobreconfianza (≈ 97 % de decisiones con p ≥ 0,9 y acierto 48–50 %), sesgo de orden de letras, 41 de 41 WAIT en `multi-test-4`. **No es una prioridad.** Su lugar posible es filtro de oportunidades respaldadas por estrategias que ya tengan ventaja medida; hoy no hay ninguna que filtrar. Se mantiene como brazo paper congelado.

## 6. Los tres caminos

| | Continuar investigando | Cambiar el enfoque | Detener temporalmente |
|---|---|---|---|
| Qué implica | Otra hipótesis con fundamento distinto | Horizontes de semanas/meses, metodología prospectiva, otros mercados o datos | Laboratorio paper, sin nuevas pruebas históricas |
| Potencial | Bajo: mismas fuentes, misma muestra, 5.000+ clusters necesarios | Medio-bajo: el coste deja de importar, pero la potencia empeora y requiere años | Bajo directo, pero no tiene costo ni riesgo |
| Coste de investigación | Alto en tiempo y en sesgo acumulado (cada prueba suma al conteo) | Medio; requiere decisiones de plataforma/datos | Casi nulo |
| Riesgos | Falsos positivos por pruebas múltiples; contaminar la reserva | Dispersión; ADR y reglas de paper pueden requerir enmienda | Perder impulso; la evidencia forward tarda meses |
| Evidencia que justifica seguir | Una hipótesis con información nueva (no OHLCV/OI/funding públicos) y plausibilidad bruta ≥ 3× el coste | Una especificación única, congelada y evaluada solo en forward | Que C29, C30, C32 y Kronos superen 100 operaciones con t > 2 |

**Recomendación: camino 3, con un cambio puntual del 2.** Detener las pruebas históricas nuevas (ya no hay muestra de la que obtener más) y dejar que las evidencias en curso se acumulen: C29, C30, C32 y Kronos hasta 100 operaciones y t > 2 antes de cualquier decisión. Si se quiere seguir invirtiendo esfuerzo, lo que cambiaría la probabilidad de éxito no es una estrategia sino **información nueva**: capturar libro y bid/ask hacia adelante y datos no de precio, con una hipótesis registrada antes de mirar. Si en 6 meses el forward no muestra nada, la conclusión razonable es que con datos públicos de Kraken y horizontes cortos no hay una ventaja explotable, y Balancita queda como laboratorio.

No recomiendo seguir investigando solo porque era el objetivo inicial: tras 8 pruebas y decenas anteriores, otra variante histórica tiene más probabilidad de producir un falso positivo que un hallazgo real.

## Limitaciones de esta evaluación
Los errores estándar son aproximaciones tomadas de los intervalos publicados; las cifras de los estudios anteriores a esta línea provienen de sus informes y de la memoria del proyecto, no se recalcularon; el informe de validación completo está en la Mac, no en el repo.
