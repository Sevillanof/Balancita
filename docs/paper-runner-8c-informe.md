# Informe de la sesión demo del paper runner (etapa 8C)

Generado por `python -m balancita_engine.paper_runner_demo informe`. Eventos sintéticos y reproducibles; todos los
números salen del motor real (`paper_runner_report.observability`). No mide rentabilidad: mide integración,
consistencia, recuperación y trazabilidad.

## Resultado

```text
BALANCITA PAPER RUNNER

Estado:                    FINALIZADO
Modo:                      OFFLINE / PAPER

Capital inicial:           1000.00 USD
Capital final:             1002.93 USD
Capital utilizable:        989.31 USD

Señales generadas:         5
Señales aceptadas:         3
Señales rechazadas:        2

Operaciones abiertas:      1
Operaciones cerradas:      2

Ganancias:                 1
Pérdidas:                  1

Comisiones:                0.73 USD
Funding:                   0.00 USD

P&L neto:                  2.93 USD
Máximo drawdown:           13.63 USD

Eventos procesados:        18
Eventos duplicados:        2
Huecos sin resolver:       1

Recuperaciones:            0
Violaciones contables:     0

Hash ejecución continua:   616e91e399d5d2ffe9dceee737d14188
Hash ejecución recuperada: 616e91e399d5d2ffe9dceee737d14188
```

## Operaciones y decisiones

| Producto  | Lado  | Estado   | Motivo             | Resultado | P&L (USD) | Funding              |
| --------- | ----- | -------- | ------------------ | --------- | --------- | -------------------- |
| PF_XBTUSD | LONG  | opened   | -                  | closed    | 13.6262   | complete (disputado) |
| PF_ETHUSD | SHORT | opened   | -                  | closed    | -10.6949  | complete             |
| PF_SOLUSD | LONG  | rejected | open_risk_limit    | rejected  | -         | -                    |
| PF_SOLUSD | LONG  | opened   | -                  | open      | -         | -                    |
| PF_XBTUSD | LONG  | rejected | no_quote_in_window | rejected  | -         | -                    |

## Rechazos

- PF_SOLUSD LONG: open_risk_limit
- PF_XBTUSD LONG: no_quote_in_window

Eventos rechazados por el runner: duplicate_event (2)

## Riesgos y alertas

- `funding_conflict` (warning): {"periods": [[1791026400000, 1791033600000, "0.0002"]], "product_id": "PF_XBTUSD"}
- `offset_holes` (warning): {"holes": 1}
- `insufficient_market_data` (warning): {"positions": ["PF_SOLUSD"]}
- `closed_trade_coverage_incomplete` (warning): {"trades": ["7dba728a09f22cafe9141ced"]}

Funding en cuarentena: {"PF_XBTUSD": [[1791026400000, 1791033600000, "0.0002"]]}
Posiciones abiertas y vigilancia de su stop: PF_SOLUSD unobserved

## Comparación entre ejecución continua y recuperada

La ejecución recuperada murió 4 veces (`os._exit`, sin limpieza); cada proceso nuevo recuperó desde los archivos
y recibió de nuevo todos los eventos.

| Punto de la muerte                     | Recuperación (ms) |
| -------------------------------------- | ----------------- |
| after_journal / decision (n.º 1)       | 1791030002000     |
| after_apply / event_accepted (n.º 9)   | 1791030180000     |
| after_journal / reconciliation (n.º 1) | 1791033900000     |
| mid_journal / event_accepted (n.º 1)   | 1791034200000     |

| Comprobación      | Continua = recuperada |
| ----------------- | --------------------- |
| financial         | sí                    |
| accounting        | sí                    |
| ledger            | sí                    |
| executor          | sí                    |
| positions         | sí                    |
| trades            | sí                    |
| capital_log       | sí                    |
| adjustments       | sí                    |
| reclassifications | sí                    |

Hash financiero continuo: `616e91e399d5d2ffe9dceee737d141889d1ca85afbda79149a26e856bb8f4718`
Hash financiero recuperado: `616e91e399d5d2ffe9dceee737d141889d1ca85afbda79149a26e856bb8f4718`
