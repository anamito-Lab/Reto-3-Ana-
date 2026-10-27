import Anthropic from "@anthropic-ai/sdk"
import { ErrorLLM, type Bloque, type DefinicionHerramienta, type Mensaje, type MotivoFin, type ProveedorLLM, type RespuestaLLM } from "./adapter.ts"

type Config = { apiKey: string | undefined; modelo: string; timeoutMs: number; sistema: string }

const MAX_TOKENS_RESPUESTA = 16000

/** Elimina cualquier cosa con forma de clave antes de mostrar un mensaje. */
export function redactar(texto: string): string {
  return texto.replace(/sk-ant-[A-Za-z0-9_-]+/g, "[clave-redactada]")
}

function aParam(m: Mensaje): Anthropic.Beta.BetaMessageParam {
  if (m.rol === "asistente" && m.crudo?.proveedor === "anthropic") {
    return { role: "assistant", content: m.crudo.contenido as Anthropic.Beta.BetaContentBlockParam[] }
  }
  const content = m.bloques.map((b): Anthropic.Beta.BetaContentBlockParam => {
    switch (b.tipo) {
      case "texto":
        return { type: "text", text: b.texto }
      case "llamada":
        return { type: "tool_use", id: b.id, name: b.nombre, input: b.argumentos }
      case "resultado":
        return { type: "tool_result", tool_use_id: b.id, content: b.contenido, is_error: b.esError }
    }
  })
  return { role: m.rol === "usuario" ? "user" : "assistant", content }
}

function motivo(stop: Anthropic.Beta.BetaMessage["stop_reason"]): MotivoFin {
  switch (stop) {
    case "end_turn":
    case "stop_sequence":
      return "fin"
    case "tool_use":
      return "herramientas"
    case "max_tokens":
      return "limite_tokens"
    case "refusal":
      return "rechazo"
    default:
      return "otro"
  }
}

/** Extrae error.error.message del cuerpo de error del API, si existe. */
function mensajeDelProveedor(cuerpo: unknown): string | null {
  if (typeof cuerpo !== "object" || cuerpo === null || !("error" in cuerpo)) return null
  const interno = cuerpo.error
  if (typeof interno !== "object" || interno === null || !("message" in interno)) return null
  return typeof interno.message === "string" ? interno.message : null
}

function traducirError(e: unknown, timeoutMs: number): ErrorLLM {
  if (e instanceof ErrorLLM) return e
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
    return new ErrorLLM("El proveedor rechazó la API key configurada en el servidor. Revisa ANTHROPIC_API_KEY.", "autenticacion")
  }
  if (e instanceof Anthropic.RateLimitError) {
    return new ErrorLLM("El proveedor está limitando las solicitudes. Espera unos segundos e inténtalo de nuevo.", "limite")
  }
  if (e instanceof Anthropic.APIConnectionTimeoutError) {
    return new ErrorLLM(`El modelo no respondió en ${Math.round(timeoutMs / 1000)} s. Inténtalo de nuevo.`, "timeout")
  }
  if (e instanceof Anthropic.APIConnectionError) {
    return new ErrorLLM("No se pudo conectar con el proveedor del modelo. Revisa la conexión del servidor.", "conexion")
  }
  if (e instanceof Anthropic.APIError) {
    const detalle = mensajeDelProveedor(e.error) ?? e.message
    if (/credit balance/i.test(detalle)) {
      return new ErrorLLM("La cuenta del proveedor no tiene créditos disponibles. Recarga saldo en la consola de Anthropic o usa otra API key.", "proveedor")
    }
    return new ErrorLLM(`El proveedor devolvió un error (${e.status ?? "sin estado"}): ${redactar(detalle)}`, "proveedor")
  }
  return new ErrorLLM(`Error inesperado al llamar al modelo: ${redactar(e instanceof Error ? e.message : String(e))}`, "proveedor")
}

/** Implementación de ProveedorLLM con el SDK oficial de Anthropic. */
export class ProveedorAnthropic implements ProveedorLLM {
  readonly proveedor = "anthropic"
  readonly modelo: string
  private readonly cliente: Anthropic | null
  private readonly timeoutMs: number
  private readonly sistema: string

  constructor(config: Config) {
    this.modelo = config.modelo
    this.timeoutMs = config.timeoutMs
    this.sistema = config.sistema
    this.cliente = config.apiKey ? new Anthropic({ apiKey: config.apiKey, maxRetries: 1 }) : null
  }

  async enviar(mensajes: Mensaje[], herramientas: DefinicionHerramienta[]): Promise<RespuestaLLM> {
    if (!this.cliente) {
      throw new ErrorLLM("El servidor no tiene ANTHROPIC_API_KEY configurada, así que el chat no puede llamar al modelo. Las herramientas siguen disponibles con `bun run demo`.", "sin_clave")
    }
    try {
      const r = await this.cliente.beta.messages.create(
        {
          model: this.modelo,
          max_tokens: MAX_TOKENS_RESPUESTA,
          system: [{ type: "text", text: this.sistema, cache_control: { type: "ephemeral" } }],
          messages: mensajes.map(aParam),
          tools: herramientas.map((h) => ({
            name: h.nombre,
            description: h.descripcion,
            input_schema: h.esquema as Anthropic.Beta.BetaTool.InputSchema,
          })),
          output_config: { effort: "medium" },
          // Si el modelo declina por política, el API reintenta en un modelo alternativo dentro de la misma llamada.
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
        },
        { timeout: this.timeoutMs },
      )
      const bloques: Bloque[] = []
      for (const b of r.content) {
        if (b.type === "text") bloques.push({ tipo: "texto", texto: b.text })
        else if (b.type === "tool_use") bloques.push({ tipo: "llamada", id: b.id, nombre: b.name, argumentos: b.input })
      }
      const u = r.usage
      return {
        mensaje: { rol: "asistente", bloques, crudo: { proveedor: this.proveedor, contenido: r.content } },
        motivoFin: motivo(r.stop_reason),
        uso: {
          entrada: u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
          salida: u.output_tokens,
        },
      }
    } catch (e) {
      throw traducirError(e, this.timeoutMs)
    }
  }
}
