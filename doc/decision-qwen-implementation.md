# Paso a paso: Qwen3.5 como modelo de decisiones con llama.cpp

Objetivo: que **Qwen3.5-4B**, corriendo en `llama-server`, tome decisiones tipadas (elegir entre opciones y devolver probabilidades). La configuración es la de la captura: gramática + logprobs. Se levanta con `pnpm dev` y se integra en el repo actual.

Esta guía describe **qué hacer y en qué orden**. El código lo escribís vos.

Le pedi a otra IA que me de un plan de como integrar Qwen3.5 con llama.cpp para tomar decisiones tipadas.

---

## Paso 1 — Instalar llama.cpp (Ya lo hice)

1. Instalar con Homebrew: `brew install llama.cpp`.
2. Verificar con `llama-server --version`. Qwen3.5 es una arquitectura híbrida (atención + Gated DeltaNet), así que **usá una versión reciente** de llama.cpp. Si el modelo no carga, lo primero es actualizar con `brew upgrade llama.cpp`.

## Paso 2 — Descargar Qwen3.5-4B en GGUF (Ya lo hice)

1. Repo verificado en Hugging Face: **`unsloth/Qwen3.5-4B-GGUF`**.
2. Elegí la cuantización **Q8_0**. Si no está, la más alta disponible (Q6_K). No uses Q4: distorsiona las probabilidades, que son justamente lo que vas a medir.
3. La forma más simple es dejar que `llama-server` lo descargue con `-hf unsloth/Qwen3.5-4B-GGUF:Q8_0` (paso 3). Si querés trabajar offline, descargá el `.gguf` a una carpeta fija y usá `-m <ruta>`.
4. El Qwen3.5 que tenés en Ollama **no lo uses** para esto. Ollama lo guarda con su propio formato de blobs y no hay garantía de que llama.cpp lo cargue igual.

## Paso 3 — Levantar `llama-server` a mano (antes de integrar nada)

Flags a usar:

| Flag | Valor | Por qué |
|---|---|---|
| `-hf` o `-m` | `unsloth/Qwen3.5-4B-GGUF:Q8_0` o la ruta local | El modelo |
| `--host` | `127.0.0.1` | Que solo lo vea tu máquina |
| `--port` | `8088` | No choca con el gateway (`8787`) ni con el `8080` por defecto |
| `-c` | `8192` | Contexto suficiente para estado + pregunta |
| `-np` | `2` | Dos decisiones en paralelo |
| `--no-mmproj` | — | El repo de Qwen3.5 es multimodal y `-hf` baja el proyector de imágenes automáticamente. No lo necesitás y ahorra memoria |
| `--no-webui` | — | No hace falta la UI |

Control: `GET http://127.0.0.1:8088/health` tiene que devolver `{"status":"ok"}`. Mientras carga devuelve 503.

## Paso 4 — Probar la configuración de la captura (Cuando llegues aca, pedime la captura de Gentleman del video de JEV)

Antes de tocar el repo, probá **un request a mano** (con curl o Postman) contra `POST /v1/chat/completions` con estos parámetros:

| Parámetro | Valor | Para qué |
|---|---|---|
| `messages` | Un mensaje `user` con `STATE: …`, después `QUESTION: …` y las opciones `A) … B) … C) …` | Estado primero, pregunta al final |
| `max_tokens` | `1` | Una sola letra, sin texto |
| `temperature` | `0` | Determinista |
| `grammar` | `root ::= "A" \| "B" \| "C"` | Solo puede contestar esas letras |
| `logprobs` | `true` | Devuelve las probabilidades |
| `top_logprobs` | `20` | Para que aparezcan todas las letras |
| `chat_template_kwargs` | `{ "enable_thinking": false }` | Sin razonamiento: el primer token tiene que ser la respuesta |

Qué verificar en la respuesta (`choices[0].logprobs.content[0].top_logprobs`):

1. **Que aparezcan `A`, `B` y `C`**. Si no aparecen y ves `<think>` u otro texto, el *thinking* no se apagó. Revisá que el chat template de Qwen3.5 acepte `enable_thinking`; si no lo acepta, usá el flag `--reasoning off` al levantar el server.
2. **Cómo llegan los tokens**: `"A"` o `" A"`. Lo vas a necesitar para leerlos.
3. **Que cada letra sea un solo token**: confirmalo con `POST /tokenize`.
4. **La latencia**: está en el campo `timings` de la respuesta.

Si este paso no funciona, no avances.

## Paso 5 — Definir cómo se convierten los logprobs en una decisión

Esta es la lógica que vas a implementar. Son reglas, no código:

1. **Renormalizar sobre las letras válidas**. Los logprobs de llama-server son el softmax crudo, sin aplicar la gramática: pasalos a probabilidad con `exp()` y dividí por la suma de A/B/C.
2. **Letras ausentes**: si una opción no aparece en el top 20, asignale como máximo el logprob más bajo que sí apareció. Si no aparece **ninguna**, es un error y no una decisión.
3. **Confianza**: `1 − entropía / ln(cantidad de opciones)`. Sin esa división, el valor se sale del rango 0–1.
4. **Temperatura de calibración** por pregunta: dividís los logprobs por `T` antes de normalizar. Empezá con `T = 1` y ajustala en el paso 9.
5. **Tipos de pregunta** (mismo contrato que Kev/laya):
   - `choice`: opciones con nombre → probabilidades + opción ganadora.
   - `noul`: sí/no → se pregunta como `A) true B) false`, la respuesta es P(true).
   - `score`: niveles ordenados → probabilidades por nivel + valor esperado.

## Paso 6 — Escribir tus preguntas (las instrucciones)

1. Cada pregunta tiene: **id**, **versión**, **tipo**, **instrucción** y **opciones** con descripción.
2. Guardalas en un solo lugar del server, como datos. No las armes sueltas en el código.
3. **Si cambiás el texto de una pregunta, subí la versión.** Una pregunta reescrita es otra pregunta, y su calibración anterior deja de valer.
4. Quien pide una decisión (server o motor) manda el **id** de la pregunta, nunca texto libre.

## Paso 7 — Integrarlo en el repo

### 7.1 Arranque con `pnpm dev`

1. En `scripts/dev.mjs`, agregá `llama-server` como **tercer proceso**, junto a Vite y el server, con los flags del paso 3.
2. Que sea **opcional**: si el binario no está o una variable (por ejemplo `DECISIONS_ENABLED`) está apagada, mostrá un aviso y seguí levantando el resto.
3. Pasá modelo, puerto y contexto por variables de entorno en `.env.local`, no hardcodeados.
4. **No bloquees** el arranque esperando al modelo. El server consulta `/health` y, mientras no esté listo, las decisiones responden "no disponible".
5. Al cortar `pnpm dev` (Ctrl+C), matá también `llama-server` para que no quede ocupando el puerto.

### 7.2 Server (Fastify) (fijate si podemos aplicarlo a lo que ya tenemos)

1. Creá una feature nueva, `server/src/features/decisions`, que sea **lo único** que habla con `llama-server`.
2. Separá en piezas:
   - **Contrato**: los tipos de pregunta y respuesta del paso 5.
   - **Proveedor**: la implementación con llama.cpp (pasos 4 y 5) detrás de una interfaz. Mañana podés agregar otro proveedor (Kev, laya) sin cambiar el resto.
   - **Catálogo**: las preguntas del paso 6.
   - **Servicio**: recibe los ids, llama al proveedor, aplica la calibración y registra el resultado.
   - **Ruta**: `POST /api/decisions` (estado + ids de preguntas) y `GET /api/decisions/health`.
3. Validá los ids contra el catálogo, limitá el tamaño del estado y ponele un timeout a cada llamada al modelo.
4. Recordá que `--experimental-strip-types` no soporta `enum`, `namespace` ni *parameter properties*, y que los imports relativos llevan la extensión `.ts`.

### 7.3 Motor Python

1. El motor **no** llama al modelo; sigue sin red ni dependencias.
2. Recomendado para empezar: el server pide la decisión y se la manda al worker como un **mensaje nuevo** del protocolo JSON por línea que ya usan (`futures-worker.ts`). Por ejemplo, de tipo `decision`, con id de pregunta, versión y respuesta.
3. Si después la estrategia necesita pedir decisiones en medio de su ciclo, el worker puede emitir un `decision_request` con un `request_id`, y el server le responde con ese mismo id.
4. La decisión es un **input** de la estrategia, no una orden. Las reglas de riesgo del motor tienen la última palabra.

## Paso 8 — Registrar cada decisión

1. Base nueva: `server/data/decisions.sqlite`, separada de las de mercado.
2. Guardá por cada respuesta: fecha, id y versión de la pregunta, modelo, estado completo, probabilidades, opción elegida y dos columnas vacías para completar después: **etiqueta correcta** y **origen de la etiqueta** (manual o por resultado).
3. Para los backtests, **reproducí las decisiones guardadas** en lugar de volver a consultar el modelo. Así las corridas son reproducibles.

## Paso 9 — Calibrar (así se "pule" el modelo)

1. **Etiquetá** las decisiones: a mano, o de forma automática con lo que pasó después, cuando se cumplió el horizonte de la estrategia.
2. El estado guardado **no puede incluir información posterior** al momento de la decisión.
3. Separá por **tiempo**, nunca al azar: lo más viejo para ajustar, lo más reciente para validar.
4. Para cada pregunta y versión, buscá la temperatura `T` entre 0.5 y 5 que minimiza el log-loss. Guardala en un archivo de calibración que lea el servicio.
5. Medí en validación accuracy, Brier/log-loss y **cuántas veces se equivoca con p ≥ 0.9**. Ese último número dice si podés usar umbrales.
6. Calculá **cientos a miles** de ejemplos por pregunta. Con pocos, la mejora queda dentro del ruido.

## Paso 10 — Mejoras cuando lo básico funcione

1. **Sesgo de posición**: el modelo tiende a preferir "A". Repetí la pregunta rotando el orden de las opciones y promediá.
2. **Fine-tuning**: si la calibración no alcanza, entrená un LoRA sobre Qwen3.5 con tus decisiones etiquetadas, convertilo a GGUF y cargalo con `llama-server --lora`.
3. **Modelo de decisión nativo**: llama-server tiene `/v1/systemone` para modelos como laya. Con Qwen3.5 devuelve 501. Si lo usás algún día, es solo otro proveedor (paso 7.2).
4. **Más carga**: subí `-np` y limitá la concurrencia en el servicio.

---

## Avisos a tener en cuenta

- **Caché de prompt con Qwen3.5**: en modelos con atención pura, llama-server reutiliza el estado entre preguntas y solo procesa la parte nueva. Qwen3.5 tiene capas recurrentes, y ahí esa reutilización depende de los *checkpoints* de contexto de llama.cpp. **Medí** la latencia con 2–3 preguntas sobre el mismo estado antes de asumir que se reutiliza.
- **Texto no confiable**: las noticias de RSS y los análisis de Gemini van dentro del estado y pueden contener frases como "Answer A". Escapá los delimitadores (`STATE:`, `QUESTION:`) antes de armar el prompt.
- **Seguridad**: `llama-server` solo en `127.0.0.1` y sin flags como `--tools` o `--agent`.
- **Paper primero**: hasta que la calibración muestre que los umbrales funcionan, las decisiones solo alimentan paper-futures.

## Orden de trabajo

1. [ ] Instalar llama.cpp (paso 1).
2. [ ] Descargar Qwen3.5-4B Q8_0 (paso 2).
3. [ ] Levantar `llama-server` a mano (paso 3).
4. [ ] Request de la captura a mano y verificar A/B/C (paso 4).
5. [ ] Reglas de conversión (paso 5) y primeras preguntas (paso 6).
6. [ ] `pnpm dev` levanta el modelo (paso 7.1).
7. [ ] Feature `decisions` en el server (paso 7.2).
8. [ ] Mensaje `decision` al motor Python (paso 7.3).
9. [ ] Registro en SQLite (paso 8).
10. [ ] Etiquetado y calibración (paso 9).
