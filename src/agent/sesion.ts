import type { Mensaje } from "../llm/adapter.ts"

/** Llamada a herramienta tal como se muestra en el chat y se devuelve por la API. */
export type LlamadaVisible = {
  id: string
  nombre: string
  argumentos: unknown
  ok: boolean
  resumen: string
  bloqueos: string[]
  confirmaciones: string[]
  resultado: unknown
  ts: string
}

export type EntradaChat =
  | { rol: "usuario"; texto: string; ts: string }
  | { rol: "agente"; texto: string; toolCalls: LlamadaVisible[]; needsConfirmation: boolean; error?: boolean; ts: string }

export type ConfirmacionPendiente = { caso: string; codigos: string[] }

export type Sesion = {
  id: string
  creada: string
  /** Historial para el modelo (incluye resultados de herramientas). */
  historial: Mensaje[]
  /** Historial visible para la persona (lo que devuelve GET /api/sessions/:id). */
  transcript: EntradaChat[]
  tokensUsados: number
  /** Doble seguro CA3: qué caso quedó esperando confirmación explícita al cerrar el último turno. */
  confirmacionPendiente: ConfirmacionPendiente | null
  ocupada: boolean
}

export function nuevaSesion(id: string): Sesion {
  return { id, creada: new Date().toISOString(), historial: [], transcript: [], tokensUsados: 0, confirmacionPendiente: null, ocupada: false }
}

/** "sí", "confirmo", "apruebo", "dale", "procede" al inicio del mensaje y sin negación. */
export function esConfirmacionExplicita(mensaje: string): boolean {
  const t = mensaje
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .trim()
  if (/\bno\b/.test(t)) return false
  return /^(si|confirmo|apruebo|dale|procede)\b/.test(t)
}
