import { readdir, readFile, stat } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { normalizarAprobacion, parsearCotizacion, parsearFactura } from "./parsers.ts"
import {
  AprobacionRawSchema,
  CentroCostoSchema,
  CondicionPagoSchema,
  CorreoSchema,
  IndicadorIvaSchema,
  ProveedorSchema,
  SolicitudSchema,
  type Maestros,
  type Paquete,
  type Resultado,
} from "./tipos.ts"
import { erroresZod, mensajeError } from "./util.ts"

const RAIZ = "fixtures/reto-03"
const CASO_VALIDO = /^[A-Za-z0-9_-]+$/

async function existe(ruta: string): Promise<boolean> {
  return stat(ruta).then(
    () => true,
    () => false,
  )
}

async function leerTexto(ruta: string): Promise<string | null> {
  return (await existe(ruta)) ? readFile(ruta, "utf8") : null
}

/** Lee y valida un JSON; JSON malformado o esquema inválido → error legible con el nombre del archivo. */
async function leerJson<T>(ruta: string, esquema: z.ZodType<T>): Promise<Resultado<T> | null> {
  const texto = await leerTexto(ruta)
  if (texto === null) return null
  const nombre = path.basename(ruta)
  let crudo: unknown
  try {
    crudo = JSON.parse(texto)
  } catch (e) {
    return { ok: false, error: `${nombre} tiene JSON malformado: ${mensajeError(e)}` }
  }
  const r = esquema.safeParse(crudo)
  return r.success ? { ok: true, data: r.data } : { ok: false, error: `${nombre} no es válido: ${erroresZod(r.error)}` }
}

export async function listarCasos(directory: string): Promise<string[]> {
  const dir = path.join(directory, RAIZ, "solicitudes")
  return (await existe(dir)) ? (await readdir(dir)).sort() : []
}

async function leerMaestro<T>(directory: string, nombre: string, esquema: z.ZodType<T>): Promise<Resultado<T[]>> {
  const r = await leerJson(path.join(directory, RAIZ, "maestros", nombre), z.array(esquema))
  return r ?? { ok: false, error: `Falta el maestro ${RAIZ}/maestros/${nombre}` }
}

export async function leerMaestros(directory: string): Promise<Resultado<Maestros>> {
  const proveedores = await leerMaestro(directory, "proveedores.json", ProveedorSchema)
  if (!proveedores.ok) return proveedores
  const centros = await leerMaestro(directory, "centros-costo.json", CentroCostoSchema)
  if (!centros.ok) return centros
  const ivas = await leerMaestro(directory, "indicadores-iva.json", IndicadorIvaSchema)
  if (!ivas.ok) return ivas
  const condiciones = await leerMaestro(directory, "condiciones-pago.json", CondicionPagoSchema)
  if (!condiciones.ok) return condiciones
  return {
    ok: true,
    data: { proveedores: proveedores.data, centros: centros.data, ivas: ivas.data, condiciones: condiciones.data },
  }
}

/** Lee el paquete del caso y lo normaliza según PRD 7.2. Nunca lanza. */
export async function leerPaquete(directory: string, caso: string): Promise<Resultado<Paquete>> {
  if (!CASO_VALIDO.test(caso)) return { ok: false, error: `Nombre de caso inválido: "${caso}"` }
  const dir = path.join(directory, RAIZ, "solicitudes", caso)
  if (!(await existe(dir))) {
    const casos = await listarCasos(directory)
    return { ok: false, error: `No existe el caso "${caso}". Casos disponibles: ${casos.join(", ") || "ninguno"}` }
  }

  const correo = await leerJson(path.join(dir, "correo.json"), CorreoSchema)
  if (correo === null) return { ok: false, error: "Falta correo.json: pedir al solicitante que reenvíe el correo de la solicitud" }
  if (!correo.ok) return correo

  const solicitud = await leerJson(path.join(dir, "solicitud.json"), SolicitudSchema)
  if (solicitud === null) return { ok: false, error: "Falta la solicitud (solicitud.xlsx): pedirla al solicitante" }
  if (!solicitud.ok) return { ok: false, error: `${solicitud.error}. Pedir al solicitante que corrija el Excel de solicitud` }

  const avisos: string[] = []

  const textoCot = await leerTexto(path.join(dir, "cotizacion.txt"))
  let cotizacion: Paquete["cotizacion"] = null
  if (textoCot === null) avisos.push("Falta la cotización (cotizacion.pdf): pedirla al solicitante")
  else {
    const r = parsearCotizacion(textoCot)
    if (!r.ok) return r
    cotizacion = r.data
  }

  const aprobacionRaw = await leerJson(path.join(dir, "aprobacion.json"), AprobacionRawSchema)
  if (aprobacionRaw === null) avisos.push("Falta el correo de aprobación del líder (aprobacion.eml): pedirlo al solicitante")
  else if (!aprobacionRaw.ok) return aprobacionRaw
  const aprobacion = aprobacionRaw?.ok ? normalizarAprobacion(aprobacionRaw.data) : null

  const textoFac = await leerTexto(path.join(dir, "factura.txt"))
  let factura: Paquete["factura"] = null
  if (textoFac === null) {
    if (correo.data.adjuntos.some((a) => a.startsWith("factura"))) {
      avisos.push("El correo menciona una factura adjunta pero no se encontró factura.txt")
    }
  } else {
    const r = parsearFactura(textoFac)
    if (!r.ok) return r
    factura = r.data
  }

  const { id, de, asunto, fecha } = correo.data
  return {
    ok: true,
    data: { caso, correo: { id, de, asunto, fecha }, solicitud: solicitud.data, cotizacion, aprobacion, factura, avisos },
  }
}
