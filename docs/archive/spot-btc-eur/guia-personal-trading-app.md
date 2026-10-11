# Guía personal para construir la trading app

> [!important] Uso personal
> Este archivo es tu guía de ejecución. No forma parte de la fuente de verdad técnica y no debes entregarlo a la IA. El archivo que debes pasarle al agente es `personal-trading-app.md`.

## Ruta rápida

1. Crea un repositorio vacío fuera de `spa-eventsmanagement`.
2. Lleva `personal-trading-app.md` a la raíz del nuevo repositorio.
3. Abre ese repositorio en VS Code.
4. Ejecuta únicamente el prompt correspondiente a la fase actual.
5. Revisa y valida el resultado antes de avanzar.

## Cómo usar esta guía

- Consulta aquí qué debes preparar, revisar y decidir tú.
- Consulta `personal-trading-app.md` para obtener el prompt de cada fase.
- Ejecuta una sola fase por vez.
- No pegues claves ni credenciales en el chat.
- Si una validación falla, mantén la fase abierta.

## Paso 1: separar el nuevo proyecto

- [ ] Crea una carpeta vacía para la aplicación, fuera de `spa-eventsmanagement`.
- [ ] Abre esa carpeta como un workspace independiente en VS Code.
- [ ] Inicializa un repositorio Git vacío.
- [ ] Coloca `personal-trading-app.md` en la raíz.
- [ ] Confirma que no haya código, credenciales ni archivos de otro proyecto.

Resultado esperado: un repositorio independiente que contiene la fuente de verdad técnica.

## Paso 2: preparar el entorno

- [ ] Verifica que Git, Node.js y pnpm estén disponibles.
- [ ] No configures todavía Coinbase, Alpaca, Gemini ni ninguna tarjeta o cuenta de facturación.
- [ ] Abre el chat de tu asistente de programación dentro del nuevo workspace.
- [ ] Adjunta o referencia `personal-trading-app.md` en cada sesión.

No fijes una versión de Node.js por memoria. El Prompt 0 debe comprobar la versión soportada por Vite en ese momento y documentarla en el repositorio.

## Paso 3: ejecutar el Prompt 0

- [ ] Copia únicamente el contenido de **Prompt 0: crear el proyecto** desde `personal-trading-app.md`.
- [ ] Permite que el agente inspeccione la carpeta y proponga el trabajo de esa fase.
- [ ] No autorices funcionalidades de las fases 1 a 12.
- [ ] Comprueba que el agente haya observado un test fallando antes de implementar.
- [ ] Exige resultados reales para tests, typecheck, lint y build.
- [ ] Inicia la aplicación y abre la URL local indicada por el agente.
- [ ] Confirma que aparece la pantalla mínima y que no solicita claves.

Punto de control: la fase 0 sólo termina cuando puedes cerrar el servidor, volver a iniciarlo siguiendo el README y obtener el mismo resultado.

## Paso 4: cerrar correctamente una fase

Repite esta rutina al finalizar cada fase:

1. Ejecuta el **Prompt de cierre de fase** de `personal-trading-app.md`.
2. Revisa primero cualquier defecto o criterio pendiente que reporte el agente.
3. Ejecuta tú mismo la aplicación y prueba el recorrido visible de la fase.
4. Confirma que tests, typecheck, lint y build pasan.
5. Revisa `git status` y asegúrate de entender cada archivo modificado.
6. Verifica que `personal-trading-app.md` contiene la evidencia observada.
7. Cierra la unidad de trabajo siguiendo la política de commits del repositorio.
8. Si el contexto ya es demasiado largo, inicia una sesión nueva con el **Prompt de reanudación**.

Si un control falla, la fase continúa abierta. No cambies `[ ]` por `[x]` sólo porque la interfaz parece funcionar.

## Paso 5: construir el primer hito local

Ejecuta estas fases en orden:

| Orden | Prompt | Qué debes comprobar personalmente |
|-------|--------|------------------------------------|
| 1 | Prompt 1 | Las mismas entradas producen siempre los mismos precios mock |
| 2 | Prompt 2 | Los tres instrumentos se actualizan sin recargar la página |
| 3 | Prompt 3 | Puedes seleccionar un instrumento y ver su gráfico sin Internet |

Al terminar la fase 3:

- [ ] Usa la aplicación durante varias sesiones locales.
- [ ] Anota las fricciones reales en `personal-trading-app.md`.
- [ ] Decide si la watchlist y el gráfico justifican continuar.
- [ ] No conectes APIs sólo para que el proyecto parezca más completo.

Punto de parada recomendado: si todavía no utilizas la aplicación con mocks, corrige la experiencia antes de avanzar.

## Paso 6: convertirla en herramienta personal

Continúa sólo si el primer hito resulta útil:

| Orden | Prompt | Qué debes probar personalmente |
|-------|--------|---------------------------------|
| 4 | Prompt 4 | Crear, editar, borrar y recuperar una cartera al reiniciar |
| 5 | Prompt 5 | Disparar y reconocer una alerta sin recibir duplicados |
| 6 | Prompt 6 | Previsualizar, confirmar y auditar una orden completamente simulada |
| 7 | Prompt 7 | Solicitar un análisis local y comprobar que no puede enviar órdenes |

Durante estas fases todos los datos siguen siendo ficticios. No introduzcas una API para compensar defectos del modelo de dominio o de la interfaz.

## Paso 7: decidir si Gemini aporta valor

Antes de ejecutar el Prompt 8:

- [ ] Usa el análisis determinista de la fase 7 y define qué respuesta no puede producir adecuadamente.
- [ ] Escribe un caso concreto que Gemini deba mejorar, por ejemplo explicar en lenguaje natural una variación ya calculada.
- [ ] Entra en Google AI Studio y confirma que el proyecto de la clave figura como **Free**.
- [ ] Confirma que no hay una cuenta de facturación vinculada al proyecto.
- [ ] Consulta los límites activos del modelo; no uses cifras guardadas en los documentos como garantía futura.
- [ ] Crea una clave exclusiva para este proyecto si la actual está compartida con otras aplicaciones.

Después ejecuta el Prompt 8. Cuando el agente solicite la clave, configúrala directamente en el archivo local de entorno que esté ignorado por Git. Nunca la pegues en el chat.

Prueba obligatoria: elimina temporalmente la variable de entorno y confirma que la aplicación sigue funcionando mediante `MockAnalysisProvider`.

## Paso 8: evaluar el resultado de Gemini

Usa un conjunto fijo de ejemplos mock para comparar el análisis local y Gemini.

- [ ] ¿Gemini añade una explicación útil y verificable?
- [ ] ¿La respuesta estructurada se valida siempre?
- [ ] ¿La aplicación controla timeout, cuota y errores?
- [ ] ¿Las llamadas ocurren sólo al pulsar **Analyze**?
- [ ] ¿El panel de uso de AI Studio coincide con las llamadas esperadas?
- [ ] ¿La aplicación sigue sin poder convertir el análisis en una orden?

Si Gemini no aporta valor claro, desactívalo y conserva el proveedor mock. Tener una API key disponible no obliga a usarla.

## Paso 9: incorporar precios reales

Sólo después de validar la aplicación local, ejecuta el Prompt 9.

1. Confirma la identidad exacta de `SPCX` antes de aceptar cualquier implementación.
2. Revisa qué símbolos ofrece cada proveedor y si los datos son completos, parciales o retrasados.
3. Crea cuentas gratuitas únicamente cuando el proveedor elegido las requiera.
4. Mantén el modo mock disponible desde configuración.
5. Prueba desconexión, reconexión y datos obsoletos antes de confiar en el precio mostrado.
6. Compara algunas cotizaciones con la fuente oficial y documenta diferencias esperadas.

Los precios reales de esta fase son sólo informativos. No deben activar órdenes.

## Paso 10: practicar con un broker sin dinero real

Ejecuta el Prompt 10 únicamente cuando quieras validar el flujo de órdenes externo.

- [ ] Verifica que el broker permita una cuenta paper en tu país.
- [ ] Crea credenciales exclusivas del entorno paper.
- [ ] Concede sólo los permisos mínimos necesarios.
- [ ] Confirma que ningún endpoint ni credencial corresponde a producción.
- [ ] Ejecuta primero previews y órdenes pequeñas ficticias.
- [ ] Compara órdenes, fills y posiciones entre la app y el panel del broker.
- [ ] Prueba reintentos y reconexiones sin duplicar órdenes.

Mantén el simulador local. El broker paper es un segundo adaptador, no un reemplazo irreversible.

## Paso 11: detenerse antes del trading real

El Prompt 11 sólo produce una evaluación. No habilita trading real.

Después de leer esa evaluación debes decidir explícitamente si aceptas:

- costos y comisiones reales;
- diferencias entre cotización y ejecución;
- órdenes parciales o rechazadas;
- riesgo de credenciales comprometidas;
- límites, auditoría y recuperación necesarios;
- responsabilidad financiera y fiscal aplicable.

Sin una decisión explícita posterior, el proyecto termina de forma válida en paper trading.

## Paso 12: evaluar Jev al final

Ejecuta el Prompt 12 sólo si tienes acceso a Jev y un caso medible que Gemini o las reglas locales no resuelvan bien. No lo incorpores por novedad tecnológica.

El experimento debe responder una pregunta concreta: ¿mejora calidad, latencia o costo en una clasificación atómica sin aumentar el riesgo? Si no hay evidencia, se descarta y `AnalysisProvider` permanece sin cambios.

## Tu siguiente acción

- [ ] Crea y abre el repositorio vacío de la aplicación.
- [ ] Lleva `personal-trading-app.md` a su raíz.
- [ ] Inicia una conversación nueva en ese workspace.
- [ ] Ejecuta **Prompt 0: crear el proyecto**.
- [ ] Detente al terminar la fase 0 y revisa sus controles antes de continuar.