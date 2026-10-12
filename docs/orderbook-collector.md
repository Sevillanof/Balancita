# Colector independiente del libro BTC/ETH (PR 5, 2026-10-12)

Proceso aparte del forward y de la captura: `pnpm --dir server book:collect`. Feed público de Kraken Futures (`book`), sin credenciales, solo `PF_XBTUSD` y `PF_ETHUSD` por defecto. Base propia (`--out`, por defecto `server/data/book/book.sqlite`) y candado propio (`<base>.writer.lock`); no lee ni escribe la base de mercado.

**Qué guarda.** Reconstruye cada libro en memoria (snapshot + deltas con control de secuencia) y cada 5 s guarda por producto: mejor bid/ask, spread en pb, cantidad apilada a ±5/10/25/50/100 pb del mid por lado, 5 mejores niveles y número de niveles. No guarda cada delta (unos 900 mensajes/s) ni el libro completo.

**Huecos.** Se anotan en `book_gap` con producto, desde, hasta y motivo: salto de secuencia (se resuscribe para pedir un snapshot nuevo), mensaje inválido, socket cerrado, sin mensajes durante 15 s (se reconecta), parada (señal o poco disco) y caída del proceso sin parada limpia (se detecta al arrancar: la run anterior queda sin cierre y el silencio se registra). Un libro desincronizado no escribe filas: nunca se rellena ni se interpola.

**Límites.** 14 días y 400 MB (se borran primero las filas más viejas), parada limpia con registro si quedan menos de 5 GB libres, `SIGINT`/`SIGTERM` cierran la run y anotan el hueco. `collector_stat` guarda cada minuto mensajes/s, RSS, tamaño de la base y p99 de procesar un mensaje.

**Prueba de carga** (sin red): `pnpm --dir server book:loadtest --rate 2000 --seconds 60`. En la nube, 2.000 msg/s con 1.000 niveles por lado: la máquina procesa ~280.000 msg/s (≈0,7 % de un núcleo al ritmo real), un snapshot de profundidad cuesta ~5 ms, RSS ~83 MB y la proyección es de ~11 MB/día. También se probó 40 s contra el feed real: ~19 filas por producto y parada limpia.

**En la Mac, sin activar todavía.** Plantilla `ops/launchd/com.balancita.book-collector.plist` (reemplazar `__REPO__` y `__DATA__`; `KeepAlive` solo ante salida con error, así la parada por poco disco no reinicia en bucle; `Nice` 10). `caffeinate` es opcional y condicionado a estar enchufado y a la temperatura: `caffeinate -i -w <pid>` solo mientras haya corriente; no está en el plist. Antes de dejarlo continuo hay que medir CPU, memoria y temperatura unas horas con `collector_stat` y `top`.

No se calcula nada predictivo con estos datos antes de la revisión del 2026-12-07.

## Limitaciones explícitas (Fran, 2026-10-12)

Una fotografía de profundidad cada 5 s sirve para estudiar liquidez, spread y costes estimados. **No** permite reconstruir lo ocurrido entre fotografías (cancelaciones, órdenes que aparecen y desaparecen) y **no** permite demostrar que una orden maker se habría ejecutado: eso exigiría deltas y trades con prioridad de cola. Todo análisis futuro con estos datos debe declararlo.

## Estado

PR #111 aprobado solo para un piloto de varias horas en la Mac (CPU, RAM, temperatura, disco y huecos), sin `launchd`. Orden: auditoría y funding, piloto, validación de recursos, activación continua.
