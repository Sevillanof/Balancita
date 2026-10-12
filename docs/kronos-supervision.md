# Kronos: supervisión y reanudación sin decisiones retroactivas (2026-10-12)

Kronos corría con `nohup`; un reinicio de la Mac (11-oct 20:32 UTC) lo mató y quedó parado hasta el 12-oct. Para que no se repita:

- **Supervisión.** `ops/launchd/com.balancita.kronos.plist` (plantilla, reemplazar `__WORKTREE__`, `__KRONOS_REPO__`, `__DATA__`) lo arranca al iniciar sesión y lo reinicia si cae. Usa el mismo comando de siempre; no cambia estrategia, parámetros ni costes.
- **Una sola instancia.** El modo `forward` toma un `flock` sobre `<out>/kronos.lock`; una segunda instancia, sea de launchd, `nohup` o a mano, sale sin escribir.
- **Sin decisiones retroactivas.** El archivo `forward-start-ms` (la identidad original del experimento) **no se toca**. Cada pasada se anota en `run_log`; si el proceso estuvo parado más de 2 h, al volver se escribe la interrupción en `interruption` (desde, hasta, motivo) y se abre un segmento `resume` en la tabla `segment` que empieza en la primera hora cerrada posterior al arranque. Las horas anteriores se cargan solo para calentar el modelo y no producen decisiones ni operaciones. Las tablas son de solo añadir.
- **Posiciones abiertas.** Las decisiones ya guardadas con lado y sin operación se liquidan con las velas oficiales de su hora de salida (comportamiento previo, sin cambios), y una decisión anterior al segmento sigue bloqueando nuevas entradas del mismo producto hasta su salida.
- **Resumen.** `kronos-summary.json` agrega `segments` (con operaciones forward de cada tramo) e `interruptions`, para separar lo anterior y lo posterior a la interrupción.
