/**
 * Ciclo del agente (PRD 6.3): mensaje → modelo → herramientas → modelo … → respuesta.
 * CA1 tope de iteraciones y de tokens · CA3 doble seguro de confirmación · CA4 log de cada llamada · CA5 errores claros.
 */
import { z } from "zod"
import { ErrorLLM, type BloqueLlamada, type BloqueResultado, type ProveedorLLM } from "../llm/adapter.ts"
import { redactar } from "../llm/anthropic.ts"
import { registrarLog } from "../lib/log.ts"
import { mensajeError } from "../lib/util.ts"
import type { HerramientaRegistrada } from "./registro.ts"
import { esConfirmacionExplicita, type ConfirmacionPendiente, type LlamadaVisible, type Sesion } from "./sesion.ts"

export type Dependencias = {
  llm: ProveedorLLM
  herramientas: Map<string, HerramientaRegistrada>
  directory: string
  outDir: string
  maxIteraciones: number
  maxTokensSesion: number
}

export type ResultadoTurno = { reply: string; toolCalls: LlamadaVisible[]; needsConfirmation: boolean; error?: boolean }

// Lectura tolerante de los resultados de herramientas, solo para resumir y detectar confirmaciones.
const Codigos = z.array(z.object({ codigo: z.string() })).catch([])
const RespuestaHerramienta = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  data: z
    .object({
      apta: z.boolean().optional(),
      retroactiva: z.boolean().optional(),
      bloqueos: Codigos.optional(),
      confirmaciones: Codigos.optional(),
      confirmaciones_pendientes: Codigos.optional(),
      numero_oc: z.string().optional(),
      idempotente: z.boolean().optional(),
      ruta: z.string().optional(),
      solicitud: z.object({ solicitud_id: z.string() }).optional(),
      avisos: z.array(z.string()).optional(),
    })
    .optional(),
  detalle: z.object({ bloqueos: Codigos.optional(), confirmaciones: Codigos.optional() }).optional(),
})
type RespuestaHerramienta = z.infer<typeof RespuestaHerramienta>

const ArgsCaso = z.object({ caso: z.string().optional(), confirmado: z.boolean().optional() })

const cods = (xs: Array<{ codigo: string }> | undefined) => (xs ?? []).map((x) => x.codigo)
const lista = (xs: string[]) => (xs.length ? xs.join(", ") : "ninguna")

function resumir(nombre: string, r: RespuestaHerramienta): string {
  if (!r.ok) return `Error: ${r.error ?? "sin detalle"}`
  const d = r.data
  if (!d) return "ok"
  switch (nombre) {
    case "oc_leer_paquete":
      return `Paquete ${d.solicitud?.solicitud_id ?? ""} leído${d.avisos?.length ? ` · ${d.avisos.length} aviso(s)` : ""}`
    case "oc_validar":
      return `apta=${d.apta} · bloqueos: ${lista(cods(d.bloqueos))} · confirmaciones: ${lista(cods(d.confirmaciones))}${d.retroactiva ? " · RETROACTIVA" : ""}`
    case "oc_construir_payload":
      return `Payload válido · confirmaciones pendientes: ${lista(cods(d.confirmaciones_pendientes))}`
    case "oc_generar_evidencia":
      return `Evidencia en ${d.ruta ?? "?"}`
    case "oc_crear":
      return `OC ${d.numero_oc ?? "?"}${d.idempotente ? " (ya existía, idempotente)" : " creada"}`
    default:
      return "ok"
  }
}

/** Qué confirmaciones dejó pendientes una llamada (para el doble seguro CA3). */
function pendienteDe(nombre: string, caso: string | undefined, r: RespuestaHerramienta): ConfirmacionPendiente | null {
  if (!caso) return null
  const codigos =
    nombre === "oc_validar" && r.ok && r.data?.apta
      ? cods(r.data.confirmaciones)
      : nombre === "oc_construir_payload" && r.ok
        ? cods(r.data?.confirmaciones_pendientes)
        : nombre === "oc_crear" && !r.ok
          ? cods(r.detalle?.confirmaciones)
          : []
  return codigos.length ? { caso, codigos } : null
}

function parsearResultado(texto: string): RespuestaHerramienta {
  try {
    const r = RespuestaHerramienta.safeParse(JSON.parse(texto))
    return r.success ? r.data : { ok: false, error: "Respuesta de herramienta con formato inesperado" }
  } catch {
    return { ok: false, error: "Respuesta de herramienta no es JSON" }
  }
}

type Turno = { confirmoAhora: boolean; pendienteAlInicio: ConfirmacionPendiente | null }

/** Ejecuta una llamada aplicando el doble seguro: oc_crear con confirmado=true exige confirmación explícita previa. */
async function ejecutarLlamada(llamada: BloqueLlamada, sesion: Sesion, deps: Dependencias, turno: Turno): Promise<{ resultado: string; visible: LlamadaVisible }> {
  const args = ArgsCaso.safeParse(llamada.argumentos)
  const caso = args.success ? args.data.caso : undefined
  const herramienta = deps.herramientas.get(llamada.nombre)

  let resultado: string
  if (!herramienta) {
    resultado = JSON.stringify({ ok: false, error: `La herramienta ${llamada.nombre} no existe` })
  } else if (llamada.nombre === "oc_crear" && args.success && args.data.confirmado === true && !(turno.confirmoAhora && turno.pendienteAlInicio?.caso === caso)) {
    resultado = JSON.stringify({
      ok: false,
      error:
        "Bloqueado por el servidor: confirmado=true solo se acepta si el turno anterior terminó pidiendo confirmación para este caso y el último mensaje del usuario la da explícitamente (sí / confirmo / apruebo / dale / procede). Pregunta al usuario y espera su respuesta.",
    })
  } else {
    try {
      resultado = await herramienta.ejecutar(llamada.argumentos, { directory: deps.directory, sessionId: sesion.id })
    } catch (e) {
      resultado = JSON.stringify({ ok: false, error: `Fallo al ejecutar ${llamada.nombre}: ${mensajeError(e)}` })
    }
  }

  const r = parsearResultado(resultado)
  const visible: LlamadaVisible = {
    id: llamada.id,
    nombre: llamada.nombre,
    argumentos: llamada.argumentos,
    ok: r.ok,
    resumen: resumir(llamada.nombre, r),
    bloqueos: cods(r.data?.bloqueos ?? r.detalle?.bloqueos),
    confirmaciones: cods(r.data?.confirmaciones ?? r.data?.confirmaciones_pendientes ?? r.detalle?.confirmaciones),
    resultado: JSON.parse(resultado) as unknown,
    ts: new Date().toISOString(),
  }

  const pendiente = pendienteDe(llamada.nombre, caso, r)
  if (pendiente) sesion.confirmacionPendiente = pendiente
  if (llamada.nombre === "oc_crear" && r.ok && sesion.confirmacionPendiente?.caso === caso) sesion.confirmacionPendiente = null

  await registrarLog(deps.outDir, { sessionId: sesion.id, herramienta: llamada.nombre, argumentos: llamada.argumentos, ok: r.ok, resumen: visible.resumen, resultado: visible.resultado })
  return { resultado, visible }
}

function textoDe(bloques: Array<{ tipo: string; texto?: string }>): string {
  return bloques
    .filter((b) => b.tipo === "texto" && b.texto)
    .map((b) => b.texto)
    .join("\n\n")
    .trim()
}

function resumenPorTope(llamadas: LlamadaVisible[], max: number): string {
  const hechas = llamadas.map((l) => `- ${l.nombre}: ${l.resumen}`).join("\n") || "- (ninguna)"
  return `Alcancé el tope de ${max} iteraciones en este turno, así que me detengo aquí.\n\n**Lo que tengo:**\n${hechas}\n\n**Lo que falta:** terminar el proceso del caso. Escribe "continúa" para seguir desde este punto.`
}

/** Procesa un mensaje del usuario. Nunca lanza: los errores vuelven como respuesta legible (CA5). */
export async function ejecutarTurno(sesion: Sesion, mensaje: string, deps: Dependencias): Promise<ResultadoTurno> {
  const turno: Turno = { confirmoAhora: esConfirmacionExplicita(mensaje), pendienteAlInicio: sesion.confirmacionPendiente }
  sesion.confirmacionPendiente = null
  const llamadas: LlamadaVisible[] = []
  const cierre = (reply: string, error = false): ResultadoTurno => ({ reply, toolCalls: llamadas, needsConfirmation: !error && sesion.confirmacionPendiente !== null, error })

  if (sesion.tokensUsados >= deps.maxTokensSesion) {
    sesion.confirmacionPendiente = turno.pendienteAlInicio
    return cierre(`Esta sesión alcanzó su tope de ${deps.maxTokensSesion} tokens. Abre una nueva sesión para continuar.`, true)
  }

  sesion.historial.push({ rol: "usuario", bloques: [{ tipo: "texto", texto: mensaje }] })
  const definiciones = [...deps.herramientas.values()].map((h) => h.definicion)

  for (let i = 0; i < deps.maxIteraciones; i++) {
    if (sesion.tokensUsados >= deps.maxTokensSesion) {
      return cierre(`Se alcanzó el tope de ${deps.maxTokensSesion} tokens de la sesión a mitad del turno. ${resumenPorTope(llamadas, deps.maxIteraciones)}`, true)
    }
    let respuesta
    try {
      respuesta = await deps.llm.enviar(sesion.historial, definiciones)
    } catch (e) {
      const texto = e instanceof ErrorLLM ? e.message : `Error inesperado: ${redactar(mensajeError(e))}`
      await registrarLog(deps.outDir, { sessionId: sesion.id, evento: "error_llm", tipo: e instanceof ErrorLLM ? e.tipo : "desconocido", mensaje: texto })
      return cierre(`⚠️ ${texto}`, true)
    }

    sesion.tokensUsados += respuesta.uso.entrada + respuesta.uso.salida
    sesion.historial.push(respuesta.mensaje)
    const texto = textoDe(respuesta.mensaje.bloques)

    if (respuesta.motivoFin === "rechazo") return cierre("El modelo declinó responder esta solicitud. Reformúlala o abre una nueva sesión.", true)
    if (respuesta.motivoFin !== "herramientas") {
      const nota = respuesta.motivoFin === "limite_tokens" ? "\n\n_(La respuesta se cortó por longitud.)_" : ""
      return cierre((texto || "(sin texto)") + nota)
    }

    const resultados: BloqueResultado[] = []
    for (const b of respuesta.mensaje.bloques) {
      if (b.tipo !== "llamada") continue
      const { resultado, visible } = await ejecutarLlamada(b, sesion, deps, turno)
      llamadas.push(visible)
      resultados.push({ tipo: "resultado", id: b.id, contenido: resultado, esError: !visible.ok })
    }
    sesion.historial.push({ rol: "usuario", bloques: resultados })
  }

  return cierre(resumenPorTope(llamadas, deps.maxIteraciones))
}
