# Estrategias: detalle de estrategia (C29 como primer caso)

Capturas de la app React a 1440x900 (Playwright `desktop-1440x900`), generadas por
`e2e/estrategias-inventario.pw.ts` contra el registro S real (proceso Python) con una
base temporal y una copia de solo lectura de `config/`. Llevan el rótulo
«DATOS DE EJEMPLO · SANDBOX»: los estados de registro están sembrados, no son los de la Mac.
Ninguna base real, proceso de captura, estrategia ni WebSocket se tocó.
Tipografía Inter / IBM Plex Mono cargada localmente (se permitió el directorio de
`node_modules` solo para la captura; no se cambió la configuración de Vite).

- `detalle-c29.png`: detalle de C29 a 1440x900.
- `detalle-c29-completo.png`: página completa.
- `comparacion-stitch-vs-react.png`: Stitch v5 (izquierda) y React (derecha).
- Botón de la cabecera: «Abrir la Terminal →» abre la Terminal general (`/terminal`, sin estado de selección); la nota «Abre la Terminal general; no selecciona el experimento C29.» lo aclara y no promete navegar al experimento. Stitch decía «Ver en Terminal».
- `solicitudes.json`: solicitudes `/api-*` de la captura (ninguna 4xx/5xx).

## Qué sale de qué fuente (C29)

- Backtest: `config/strategy-reliability.json` (727 ops, +24,02 pb/op, +174,59 USD, t 0,87, veredicto `no_edge`).
- Rangos: 2 de 237 días reales (primer/último bucket de los datos), no los 240 de la maqueta ni de la etiqueta de la fuente.
- Fuera de muestra (OOS): No disponible. La fuente no marca ningún tramo OOS; los parámetros se buscaron entre 1.000 configuraciones sobre estos mismos rangos.
- Forward: inicio y umbral de `config/forward-strategies.json`; resultados No disponible (B5).
- Configuración, parámetros, plan: registro de estrategias (S). Operaciones almacenadas: B2.
- El detalle es genérico para toda estrategia de reglas (C30, C32 verificadas en e2e).

## Diferencias con Stitch que quedan

- Stitch muestra PnL bruto, costes de fricción, Profit Factor, Max Drawdown, Sharpe, curva de equity, tasa de paso y descartes con números: no existen fuentes (B3/B5); aquí figuran «No disponible» y no se dibuja gráfico.
- Brazos A/B/C y consistencia OOS «Retención 80,4 %» de Stitch: sin fuente, no se muestran.
- Stitch dice «Evidencia: Robusta (118 ops)» y «Activa en paper»; la app dice «Sin ventaja demostrada» y «Activa en el registro».
- Condiciones L2 / Order Book y EMA 21: C29 es momentum de retorno logarítmico; se muestran las condiciones reales del spec.
- Cabecera de Stitch (PF_XBTUSD · 5m, SYNC: KRAKEN-L2): la estrategia opera 8 perpetuos; no hay ese chip.
