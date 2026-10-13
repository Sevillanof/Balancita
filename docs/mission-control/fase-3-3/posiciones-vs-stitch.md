# #148 — posiciones a 1440×900 (React vs Stitch v5)

React: medido por Playwright sobre la app corriendo con fixtures B1/B2 de ejemplo
(`posiciones-react-1440x900.json`). Stitch: medido a ojo sobre `screen.png`
escalado a 1440 de ancho (su HTML no renderiza sin CDN), valores aproximados.

| Elemento                        | Stitch (aprox.)  | React antes                  | React ahora    |
| ------------------------------- | ---------------- | ---------------------------- | -------------- |
| Alto de cabecera                | ~55 px           | 64 px + franja de 4 tarjetas | 53 px          |
| Inicio del área del gráfico (y) | ~145 px          | ~220 px                      | 152 px         |
| Alto del lienzo del gráfico     | —                | ~420 px visibles             | 602 px         |
| Ancho del observador            | ~320 px          | 380 px                       | 380 px         |
| AHORA (alto)                    | ~150 px          | ~190 px                      | 100 px         |
| ACTIVIDAD (alto)                | ~170 px          | ~230 px                      | 196 px         |
| RESULTADOS (alto)               | —                | cortado                      | 214 px         |
| HISTORIAL                       | fuera de captura | fuera de captura             | visible, y=670 |

Todas las capturas con fixtures llevan la etiqueta «DATOS DE EJEMPLO».
