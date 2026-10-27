/**
 * Herramientas de órdenes de compra. Cada export se expone al modelo como oc_<export>.
 * Todas devuelven JSON { ok: true, data } | { ok: false, error } y nunca lanzan.
 * Las decisiones se recalculan siempre desde fixtures y maestros: no se confía en valores del modelo.
 */
import { mkdir, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { registrarControl } from "../lib/control.ts"
import { escribirEvidencia, huellaEvidencia } from "../lib/evidencia.ts"
import { leerMaestros, leerPaquete } from "../lib/fixtures.ts"
import { construirOrden } from "../lib/orden.ts"
import { evaluar } from "../lib/reglas.ts"
import type { Maestros, Paquete, Resultado, ResultadoValidacion } from "../lib/tipos.ts"
import { dirSalida, mensajeError } from "../lib/util.ts"
import { SapMock } from "../sap/mock.ts"
import { herramienta, type ContextoHerramienta } from "./herramienta.ts"

const caso = z.string().describe('Nombre de la carpeta del caso en fixtures/reto-03/solicitudes/, por ejemplo "sol-001"')

const ok = (data: unknown): string => JSON.stringify({ ok: true, data })
const fallo = (error: string, detalle?: unknown): string =>
  JSON.stringify(detalle === undefined ? { ok: false, error } : { ok: false, error, detalle })

async function seguro(fn: () => Promise<string>): Promise<string> {
  try {
    return await fn()
  } catch (e) {
    return fallo(`Error inesperado en la herramienta: ${mensajeError(e)}`)
  }
}

const relativa = (ctx: ContextoHerramienta, ruta: string) => path.relative(ctx.directory, ruta).replace(/\\/g, "/")

type CasoPreparado = { paquete: Paquete; maestros: Maestros; validacion: ResultadoValidacion }

/** Relee el caso y los maestros y vuelve a aplicar RC1–RC10. */
async function prepararCaso(ctx: ContextoHerramienta, nombre: string): Promise<Resultado<CasoPreparado>> {
  const paquete = await leerPaquete(ctx.directory, nombre)
  if (!paquete.ok) return paquete
  const maestros = await leerMaestros(ctx.directory)
  if (!maestros.ok) return maestros
  return { ok: true, data: { paquete: paquete.data, maestros: maestros.data, validacion: evaluar(paquete.data, maestros.data) } }
}

const codigos = (v: ResultadoValidacion) => ({
  bloqueos: v.bloqueos.map((b) => b.codigo),
  confirmaciones: v.confirmaciones.map((c) => c.codigo),
})

export const leer_paquete = herramienta({
  description:
    "Lee el paquete de una solicitud (correo, solicitud, cotización, aprobación y factura si existe) y lo devuelve normalizado, con avisos de lo que falta.",
  args: { caso },
  async execute(args, ctx) {
    return seguro(async () => {
      const r = await leerPaquete(ctx.directory, args.caso)
      return r.ok ? ok(r.data) : fallo(r.error)
    })
  },
})

export const validar = herramienta({
  description:
    "Aplica las reglas de control RC1–RC10 a un caso y devuelve si es apto, los bloqueos, las confirmaciones que requieren al humano, los valores derivados de maestros y si es retroactiva.",
  args: {
    caso,
    paquete: z.unknown().optional().describe("Opcional. Se ignora para decidir: la herramienta relee el caso desde los fixtures"),
  },
  async execute(args, ctx) {
    return seguro(async () => {
      const r = await prepararCaso(ctx, args.caso)
      return r.ok ? ok(r.data.validacion) : fallo(r.error)
    })
  },
})

export const construir_payload = herramienta({
  description:
    "Construye la orden de compra tal como quedaría en SAP (esquema OrdenCompra) y guarda la trazabilidad de cada campo; no crea nada en SAP.",
  args: {
    caso,
    paquete: z.unknown().optional().describe("Opcional. Se ignora: el payload se arma desde los fixtures releídos"),
    derivados: z.unknown().optional().describe("Opcional. Se ignora: los derivados se recalculan con oc_validar internamente"),
  },
  async execute(args, ctx) {
    return seguro(async () => {
      const r = await prepararCaso(ctx, args.caso)
      if (!r.ok) return fallo(r.error)
      const { paquete, validacion } = r.data
      if (!paquete.aprobacion || !validacion.apta) {
        return fallo("La solicitud tiene bloqueos y no se puede construir la OC.", { bloqueos: validacion.bloqueos })
      }
      const orden = construirOrden(paquete, validacion, { evidenciaSha256: huellaEvidencia(paquete.aprobacion), confirmadoPor: null })
      if (!orden.ok) return fallo(orden.error)

      const dirCaso = path.join(dirSalida(ctx.directory), args.caso)
      await mkdir(dirCaso, { recursive: true })
      const rutaTraza = path.join(dirCaso, "trazabilidad.json")
      await writeFile(rutaTraza, JSON.stringify(orden.data.trazabilidad, null, 2), "utf8")
      return ok({
        orden: orden.data.orden,
        trazabilidad: relativa(ctx, rutaTraza),
        confirmaciones_pendientes: validacion.confirmaciones,
        derivados: validacion.derivados,
      })
    })
  },
})

export const generar_evidencia = herramienta({
  description: "Genera la evidencia del correo de aprobación (aprobacion.txt con sha256 y aprobacion.pdf) en la carpeta de salida del caso.",
  args: { caso },
  async execute(args, ctx) {
    return seguro(async () => {
      const r = await leerPaquete(ctx.directory, args.caso)
      if (!r.ok) return fallo(r.error)
      if (!r.data.aprobacion) return fallo("El caso no tiene correo de aprobación; pedirlo al solicitante.")
      const ev = await escribirEvidencia(path.join(dirSalida(ctx.directory), args.caso), r.data.aprobacion)
      return ok({ ruta: relativa(ctx, ev.txt), ruta_pdf: relativa(ctx, ev.pdf), sha256: ev.sha256 })
    })
  },
})

export const crear = herramienta({
  description:
    "Crea la orden de compra en SAP (simulado) si el caso es apto; si tiene confirmaciones solo procede con confirmado=true tras la aprobación explícita del usuario. Es idempotente por solicitud.",
  args: {
    caso,
    payload: z.unknown().optional().describe("Opcional. Se ignora: la OC se reconstruye y revalida desde los fixtures"),
    confirmado: z
      .boolean()
      .optional()
      .describe("true solo si el usuario confirmó explícitamente las confirmaciones pendientes en su último mensaje"),
  },
  async execute(args, ctx) {
    return seguro(async () => {
      const outDir = dirSalida(ctx.directory)
      const r = await prepararCaso(ctx, args.caso)
      if (!r.ok) {
        await registrarControl(outDir, { solicitud_id: args.caso, resultado: "error", numero_oc: null, retroactiva: false, bloqueos: [], confirmaciones: [] })
        return fallo(r.error)
      }
      const { paquete, maestros, validacion } = r.data
      const sol = paquete.solicitud
      const base = { solicitud_id: sol.solicitud_id, retroactiva: validacion.retroactiva, ...codigos(validacion) }
      const sap = new SapMock(outDir, maestros.proveedores)

      const existente = await sap.buscarOrdenPorReferencia(sol.solicitud_id)
      if (existente) {
        await registrarControl(outDir, { ...base, resultado: "idempotente", numero_oc: existente.numero_oc })
        return ok({ numero_oc: existente.numero_oc, fecha: null, idempotente: true, retroactiva: validacion.retroactiva })
      }

      if (!validacion.apta || !paquete.aprobacion) {
        await registrarControl(outDir, { ...base, resultado: "bloqueada", numero_oc: null })
        return fallo("No se crea la OC: la solicitud tiene bloqueos.", { bloqueos: validacion.bloqueos })
      }
      if (validacion.confirmaciones.length > 0 && args.confirmado !== true) {
        await registrarControl(outDir, { ...base, resultado: "pendiente", numero_oc: null })
        return fallo("No se crea la OC: hay confirmaciones pendientes del usuario.", { confirmaciones: validacion.confirmaciones })
      }

      const dirCaso = path.join(outDir, args.caso)
      const rutaTxt = path.join(dirCaso, "aprobacion.txt")
      const evidencia = (await stat(rutaTxt).catch(() => null))
        ? { txt: rutaTxt, sha256: huellaEvidencia(paquete.aprobacion) }
        : await escribirEvidencia(dirCaso, paquete.aprobacion)

      const confirmadoPor = validacion.confirmaciones.length > 0 ? `analista (sesión ${ctx.sessionId})` : null
      const orden = construirOrden(paquete, validacion, { evidenciaSha256: evidencia.sha256, confirmadoPor })
      if (!orden.ok) {
        await registrarControl(outDir, { ...base, resultado: "error", numero_oc: null })
        return fallo(orden.error)
      }

      const creada = await sap.crearOrden(orden.data.orden)
      await registrarControl(outDir, { ...base, resultado: "creada", numero_oc: creada.numero_oc })
      return ok({
        numero_oc: creada.numero_oc,
        fecha: creada.fecha,
        idempotente: false,
        retroactiva: validacion.retroactiva,
        evidencia: relativa(ctx, evidencia.txt),
        excepciones: orden.data.orden.excepciones,
      })
    })
  },
})
