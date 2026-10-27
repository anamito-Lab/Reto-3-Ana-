# Agente conversacional · Órdenes de Compra SAP

Reto técnico 03 · Periferia IT Group. Agente que lee el paquete de una solicitud de compra, lo valida contra los maestros (reglas RC1–RC10), arma la OC, genera la evidencia de aprobación y la crea en un SAP simulado. Las excepciones se devuelven al humano para que decida.

- **Link de prueba:** [COMPLETAR tras el deploy en Render]
- **Clave de acceso al link:** no aplica (el link es público).
- Planteamiento completo de la solución: [SOLUCION.md](SOLUCION.md).

## Requisitos

- [Bun](https://bun.sh) 1.1 o superior (`npm install -g bun`).
- Una API key de Anthropic, solo para el chat. `demo.ts` funciona sin key.

## Levantar en local

```bash
bun install
cp .env.example .env      # luego escribe tu ANTHROPIC_API_KEY en .env
bun run dev               # http://localhost:3000
```

`bun run dev` levanta backend y front juntos con recarga automática. En producción se usa `bun run start`.

Sin `ANTHROPIC_API_KEY` el servidor arranca igual. `/api/health` responde y el chat devuelve un mensaje claro en lugar de fallar.

## Variables de entorno

| Variable | Obligatoria | Por defecto | Descripción |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | Para el chat | — | Clave del proveedor. Solo la lee el backend; nunca llega al front, a los logs ni a las respuestas de la API. |
| `LLM_MODEL` | No | `claude-opus-5-5` | Modelo de Anthropic. |
| `OUT_DIR` | No | `./out` | Carpeta de salida (OC, evidencias, logs). Puede ser absoluta, por ejemplo `/tmp/out`. |
| `MAX_ITERACIONES` | No | `25` | Tope de iteraciones herramienta → modelo por turno. |
| `MAX_TOKENS_SESION` | No | `200000` | Tope de tokens (entrada + salida) por sesión de chat. |
| `LLM_TIMEOUT_MS` | No | `60000` | Timeout por llamada al modelo. |
| `PORT` | No | `3000` | Puerto HTTP. |

## Verificación sin modelo: `demo.ts`

```bash
bun install && bun run demo.ts     # equivalente: bun run demo
```

El demo limpia `OUT_DIR` y llama directamente a las herramientas para los 6 casos de `fixtures/reto-03/solicitudes/`. Ejecuta `sol-001` dos veces para mostrar la idempotencia y confirma `sol-004` de forma explícita. Por caso imprime `apta`, bloqueos, confirmaciones, `retroactiva` y el número de OC o el motivo. Al final muestra una tabla resumen y **sale con código 1 si algún resultado difiere de lo esperado**.

| Caso | Resultado esperado |
|---|---|
| sol-001 | Apta → OC `4500000001`. La segunda ejecución devuelve el mismo número con `idempotente=true`. |
| sol-002 | Bloqueo RC1: el NIT 901999000 no existe. |
| sol-003 | Bloqueo RC2: fvargas no es aprobador de CC-2020. Además, ningún aprobador de CC-2020 tiene tope para COP 74.000.000. |
| sol-004 | Confirmación RC5 (25.000.000 vs 26.500.000, 6 %). Con `confirmado=true` → OC `4500000002`. |
| sol-005 | Confirmación RC8, `retroactiva=true` (factura del 2026-08-10, anterior a la solicitud del 2026-08-27). |
| sol-006 | Proveedor encontrado por nombre. Confirmación RC6 (IVA C1 derivado) y derivado RC7 (condiciones Z030). |

## Probar el chat

Abre `http://localhost:3000` y usa las sugerencias, o escribe por ejemplo:

```
Procesa la solicitud "sol-004". Muéstrame la OC como quedaría en SAP, qué
validaciones pasó y cuáles no, y no la crees hasta que yo lo confirme.
```

Cada llamada a herramienta aparece como una tarjeta plegable con sus argumentos y su resultado. Los bloqueos se marcan en rojo y las confirmaciones en ámbar. Cuando el agente pide confirmación, el mensaje se resalta y aparecen los botones **Confirmar** y **Rechazar**.

## API

| Método | Ruta | Cuerpo / respuesta |
|---|---|---|
| `POST` | `/api/chat` | `{ sessionId?, message }` → `{ sessionId, reply, toolCalls[], needsConfirmation }`. Sin `sessionId`, el servidor crea uno. 400 si el mensaje es inválido; 409 si la sesión ya está procesando otro mensaje. |
| `GET` | `/api/sessions/:id` | `{ id, creada, tokensUsados, confirmacionPendiente, transcript[] }`. El transcript incluye los mensajes y las llamadas a herramientas. 404 si no existe. |
| `GET` | `/api/health` | `{ ok: true, provider, model, apiKeyConfigurada }`. Nunca expone la clave. |

Cada elemento de `toolCalls[]` tiene la forma `{ id, nombre, argumentos, ok, resumen, bloqueos[], confirmaciones[], resultado, ts }`.

Las sesiones viven en memoria y se pierden al reiniciar el servidor.

## Archivos generados en `OUT_DIR`

| Archivo | Contenido |
|---|---|
| `sap/ordenes.jsonl` | OC creadas en el SAP simulado. La numeración empieza en 4500000001. |
| `control.csv` | Una fila por intento de creación: `solicitud_id, resultado, numero_oc, retroactiva, bloqueos, confirmaciones, ts`. |
| `log.jsonl` | Cada llamada a herramienta y cada error del proveedor LLM. |
| `<caso>/trazabilidad.json` | Fuente de cada campo de la OC. |
| `<caso>/aprobacion.txt` · `aprobacion.pdf` | Evidencia de aprobación con su sha256. |

## Estructura

```
agent/prompt.md                 comportamiento del agente (system prompt)
src/knowledge/ordenes-compra.md conocimiento del proceso
src/tools/oc.ts                 herramientas (cada export → oc_<export>)
src/lib/                        reglas RC1–RC10 (puras), fixtures, parsers, payload, evidencia, control
src/sap/adapter.ts · mock.ts    interfaz SapAdapter y SAP simulado
src/llm/adapter.ts · anthropic.ts  interfaz del proveedor LLM e implementación Anthropic
src/agent/                      ciclo del agente, sesiones, registro de herramientas
src/server.ts                   API HTTP (Hono) y front estático
web/                            chat en HTML + JS plano
demo.ts                         verificación sin modelo
modulo/                         bonus: agente empaquetado (agent.md, tools/oc.ts, skill/ordenes-compra/SKILL.md)
scripts/modulo.ts               genera y verifica modulo/ desde las fuentes de la app
fixtures/                       datos entregados (solo lectura)
```

## Bonus: módulo reutilizable

`modulo/` empaqueta el agente para otras plataformas sin depender del servidor (PRD 9.4). Las tres piezas son las mismas que usa la aplicación:

- `modulo/tools/oc.ts` reexporta los objetos de `src/tools/oc.ts`.
- `agent.md` y `SKILL.md` se generan desde `agent/prompt.md` y `src/knowledge/ordenes-compra.md`.

```bash
bun run modulo         # regenera agent.md y SKILL.md
bun run modulo:check   # falla si alguna pieza diverge de la aplicación
```

Detalle en [modulo/README.md](modulo/README.md).

## Deploy en Render

El repositorio trae un `render.yaml` (Blueprint) con toda la configuración. Hay dos caminos; el primero es el más corto.

### Opción A · Blueprint

1. En [render.com](https://render.com), inicia sesión con GitHub y autoriza el acceso al repositorio `anamito-Lab/Reto-3-Ana-`.
2. **New → Blueprint** → elige el repositorio → Render lee `render.yaml`.
3. Cuando lo pida, pega el valor de `ANTHROPIC_API_KEY`. Es la única variable secreta y nunca va en el repositorio.
4. **Apply**. El primer deploy tarda unos 2–3 minutos.

### Opción B · Web Service manual

**New → Web Service** → conecta el repositorio y configura:

| Campo | Valor |
|---|---|
| Language / Runtime | Node |
| Branch | `main` |
| Build Command | `bun install` |
| Start Command | `bun run start` |
| Health Check Path | `/api/health` |
| Instance Type | Free |

Variables de entorno (**Environment**):

| Variable | Valor |
|---|---|
| `BUN_VERSION` | `1.4.4` (la misma versión con que se generó `bun.lock`) |
| `NODE_ENV` | `production` |
| `ANTHROPIC_API_KEY` | tu key de la API (marcada como secreta) |
| `LLM_MODEL` | `claude-opus-5-5` |
| `OUT_DIR` | `/tmp/out` |
| `MAX_ITERACIONES` | `25` |
| `MAX_TOKENS_SESION` | `200000` |
| `LLM_TIMEOUT_MS` | `60000` |

`PORT` no se define: Render la asigna y el servidor la lee automáticamente.

### Verificar el deploy

```bash
curl https://<tu-servicio>.onrender.com/api/health
# {"ok":true,"provider":"anthropic","model":"claude-opus-5-5","apiKeyConfigurada":true}
```

Luego abre `https://<tu-servicio>.onrender.com` y procesa `sol-001`.

### A tener en cuenta

- **Plan gratuito:** el servicio se duerme tras 15 minutos sin tráfico y el primer request tarda unos 50 s en despertarlo. Ábrelo unos minutos antes de la defensa.
- **Disco efímero:** `OUT_DIR=/tmp/out` se borra en cada deploy o reinicio. La numeración de OC vuelve a 4500000001 y las sesiones (en memoria) se pierden. Para la prueba es suficiente; en producción habría un disco persistente o el SAP real.
- **Costo:** el link es público. Los topes `MAX_ITERACIONES` y `MAX_TOKENS_SESION` limitan lo que puede gastar cada sesión.
- **Si el build falla con `bun: command not found`:** revisa que `BUN_VERSION` esté definida. Como alternativa, usa *Language: Docker* con este `Dockerfile` en la raíz:

  ```dockerfile
  FROM oven/bun:1
  WORKDIR /app
  COPY package.json bun.lock ./
  RUN bun install --production
  COPY . .
  ENV NODE_ENV=production OUT_DIR=/tmp/out
  CMD ["bun", "run", "start"]
  ```

## Comandos

| Comando | Qué hace |
|---|---|
| `bun run dev` | Servidor con recarga automática. |
| `bun run start` | Servidor en modo producción. |
| `bun run demo` | Verificación de los 6 casos sin modelo. |
| `bun run typecheck` | `tsc --noEmit` en modo estricto. |
| `bun run modulo` / `bun run modulo:check` | Regenera / verifica el módulo reutilizable. |
