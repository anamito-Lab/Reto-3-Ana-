/**
 * API HTTP (Hono sobre Bun) + front estático. El ciclo del agente vive en src/agent/loop.ts.
 * La API key solo se lee aquí y se entrega al adaptador; nunca se registra ni se devuelve.
 */
import { readFile } from "node:fs/promises"
import path from "node:path"
import { Hono } from "hono"
import { serveStatic } from "hono/bun"
import { z } from "zod"
import { ejecutarTurno, type Dependencias } from "./agent/loop.ts"
import { HERRAMIENTAS } from "./agent/registro.ts"
import { nuevaSesion, type Sesion } from "./agent/sesion.ts"
import { ProveedorAnthropic } from "./llm/anthropic.ts"
import { dirSalida, erroresZod } from "./lib/util.ts"

const RAIZ = path.resolve(import.meta.dir, "..")

function entero(nombre: string, porDefecto: number): number {
  const v = Number(process.env[nombre])
  return Number.isInteger(v) && v > 0 ? v : porDefecto
}

const config = {
  puerto: entero("PORT", 3000),
  modelo: process.env.LLM_MODEL || "claude-opus-5-5",
  maxIteraciones: entero("MAX_ITERACIONES", 25),
  maxTokensSesion: entero("MAX_TOKENS_SESION", 200_000),
  timeoutMs: entero("LLM_TIMEOUT_MS", 60_000),
}

/** Comportamiento (agent/prompt.md) + conocimiento del proceso (src/knowledge/) = system prompt. */
async function cargarSistema(): Promise<string> {
  const [prompt, conocimiento] = await Promise.all([
    readFile(path.join(RAIZ, "agent", "prompt.md"), "utf8"),
    readFile(path.join(RAIZ, "src", "knowledge", "ordenes-compra.md"), "utf8"),
  ])
  return `${prompt}\n\n---\n\n# Conocimiento del proceso\n\n${conocimiento}`
}

const llm = new ProveedorAnthropic({
  apiKey: process.env.ANTHROPIC_API_KEY || undefined,
  modelo: config.modelo,
  timeoutMs: config.timeoutMs,
  sistema: await cargarSistema(),
})

const deps: Dependencias = {
  llm,
  herramientas: HERRAMIENTAS,
  directory: RAIZ,
  outDir: dirSalida(RAIZ),
  maxIteraciones: config.maxIteraciones,
  maxTokensSesion: config.maxTokensSesion,
}

const sesiones = new Map<string, Sesion>()
const ChatBody = z.object({
  sessionId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "sessionId inválido").optional(),
  message: z.string().trim().min(1, "El mensaje está vacío").max(4000, "El mensaje es demasiado largo (máx. 4000 caracteres)"),
})

const app = new Hono()

app.get("/api/health", (c) =>
  c.json({ ok: true, provider: llm.proveedor, model: llm.modelo, apiKeyConfigurada: Boolean(process.env.ANTHROPIC_API_KEY) }),
)

app.post("/api/chat", async (c) => {
  const body = ChatBody.safeParse(await c.req.json().catch(() => null))
  if (!body.success) return c.json({ error: erroresZod(body.error) }, 400)

  const sessionId = body.data.sessionId ?? crypto.randomUUID()
  const sesion = sesiones.get(sessionId) ?? nuevaSesion(sessionId)
  sesiones.set(sessionId, sesion)
  if (sesion.ocupada) return c.json({ error: "La sesión está procesando otro mensaje; espera la respuesta." }, 409)

  sesion.ocupada = true
  const mensaje = body.data.message
  sesion.transcript.push({ rol: "usuario", texto: mensaje, ts: new Date().toISOString() })
  try {
    const r = await ejecutarTurno(sesion, mensaje, deps)
    sesion.transcript.push({ rol: "agente", texto: r.reply, toolCalls: r.toolCalls, needsConfirmation: r.needsConfirmation, error: r.error, ts: new Date().toISOString() })
    return c.json({ sessionId, reply: r.reply, toolCalls: r.toolCalls, needsConfirmation: r.needsConfirmation })
  } finally {
    sesion.ocupada = false
  }
})

app.get("/api/sessions/:id", (c) => {
  const s = sesiones.get(c.req.param("id"))
  if (!s) return c.json({ error: "Sesión no encontrada (las sesiones viven en memoria y se pierden al reiniciar)." }, 404)
  return c.json({ id: s.id, creada: s.creada, tokensUsados: s.tokensUsados, confirmacionPendiente: s.confirmacionPendiente, transcript: s.transcript })
})

app.use("/*", serveStatic({ root: path.relative(process.cwd(), path.join(RAIZ, "web")) || "." }))

app.onError((e, c) => {
  console.error("Error no controlado:", e instanceof Error ? e.message : e)
  return c.json({ error: "Error interno del servidor. La sesión sigue activa; inténtalo de nuevo." }, 500)
})

console.log(`Agente OC escuchando en http://localhost:${config.puerto} · modelo ${config.modelo} · API key ${process.env.ANTHROPIC_API_KEY ? "configurada" : "NO configurada"}`)

export default {
  port: config.puerto,
  fetch: app.fetch,
  // Las llamadas al modelo pueden tardar más que el idle timeout por defecto de Bun (10 s).
  idleTimeout: 255,
}
