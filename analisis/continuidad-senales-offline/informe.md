# Demostración: continuidad durable de señales (offline)

Generada por `python -m balancita_engine.signal_continuity_demo`. Cada escenario usa procesos Python nuevos que solo comparten archivos. Datos sintéticos; sin red, sin reloj de pared, sin holdout.

## Referencia (sin caídas)

- 502 señales registradas, 145 podían abrir posición, 0 huecos, verificación ok: True.
- Cabeza de la cadena: `c6c71da37e6d8a9a70b2a3ea6f4d675c5274e553d88ba67a4a2431212b325572`.

## caida antes de persistir sin reenvio

- senales originales: 39
- senales reconstruidas: 463
- decisiones distintas de la referencia: 0
- posiciones abribles: 0
- mismas posiciones abribles que la referencia: None
- reconstruidas que abririan posicion: 0
- efectos duplicados: 0
- verificacion ok: True
- codigo de salida primer proceso: 137

## caida a mitad de persistir con reenvio

- senales originales: 502
- senales reconstruidas: 0
- decisiones distintas de la referencia: 0
- posiciones abribles: 145
- mismas posiciones abribles que la referencia: True
- reconstruidas que abririan posicion: 0
- efectos duplicados: 0
- verificacion ok: True
- codigo de salida primer proceso: 137
- bytes de cola descartados: 1754

## caida despues de persistir con reenvio

- senales originales: 502
- senales reconstruidas: 0
- decisiones distintas de la referencia: 0
- posiciones abribles: 145
- mismas posiciones abribles que la referencia: True
- reconstruidas que abririan posicion: 0
- efectos duplicados: 0
- verificacion ok: True
- codigo de salida primer proceso: 137

## caida despues de persistir reinicio tardio

- senales originales: 56
- senales reconstruidas: 446
- decisiones distintas de la referencia: 0
- posiciones abribles: 0
- mismas posiciones abribles que la referencia: None
- reconstruidas que abririan posicion: 0
- efectos duplicados: 0
- verificacion ok: True
- originales vencidas sin posicion: 1
- motivos: ['signal_expired']

## caida antes de confirmar con reenvio

- senales originales: 502
- senales reconstruidas: 0
- decisiones distintas de la referencia: 0
- posiciones abribles: 145
- mismas posiciones abribles que la referencia: True
- reconstruidas que abririan posicion: 0
- efectos duplicados: 0
- verificacion ok: True
- codigo de salida primer proceso: 137

## eventos perdidos y duplicados

- senales originales: 236
- senales reconstruidas: 262
- decisiones distintas de la referencia: 0
- posiciones abribles: 59
- mismas posiciones abribles que la referencia: None
- reconstruidas que abririan posicion: 0
- efectos duplicados: 0
- verificacion ok: True
- huecos en la numeracion de origen: [[7, 9], [60, 60]]
- huecos de ciclos: 5

## reconstrucción con versiones incompatibles

| caso | código | motivo | registro intacto | escribió informe |
|---|---|---|---|---|
| version_nueva_sin_congelar | 3 | version_incompatible | True | False |
| mismo_numero_de_version_con_codigo_distinto | 3 | code_changed_same_version | True | False |

## archivos dañados (el segundo proceso debe negarse)

| daño | código | motivo | escribió informe |
|---|---|---|---|
| checkpoint_alterado | 3 | corrupt_checkpoint | False |
| checkpoint_vacio | 3 | corrupt_checkpoint | False |
| checkpoint_ausente | 3 | checkpoint_missing | False |
| registro_ausente | 3 | log_missing | False |
| registro_con_entrada_alterada | 3 | log_corrupt | False |
| registro_reordenado | 3 | log_corrupt | False |
| registro_truncado_antes_del_checkpoint | 3 | log_behind_checkpoint | False |
| registro_de_otra_corrida | 3 | log_mismatch | False |
