import { z } from "zod"
import type { Paquete, Resultado, ResultadoValidacion } from "./tipos.ts"
import { erroresZod } from "./util.ts"

export const LARGO_DESCRIPCION_SAP = 40

/** Esquema OrdenCompra (PRD 7.4). */
export const OrdenCompraSchema = z.object({
  referencia: z.object({ solicitud_id: z.string(), correo_id: z.string(), cotizacion_ref: z.string().nullable() }),
  sociedad: z.literal("1000"),
  organizacion_compras: z.literal("1000"),
  proveedor: z.object({ codigo_sap: z.string().min(1), nit: z.string().min(1), nombre: z.string().min(1) }),
  moneda: z.enum(["COP", "USD"]),
  condiciones_pago: z.string().min(1),
  aprobador: z.object({ email: z.string().min(1), fecha_aprobacion: z.string(), evidencia_sha256: z.string().length(64) }),
  posiciones: z
    .array(
      z.object({
        numero: z.number().int().positive(),
        descripcion: z.string().min(1).max(LARGO_DESCRIPCION_SAP),
        cantidad: z.number().positive(),
        unidad: z.enum(["UN", "H", "MES"]),
        precio_unitario: z.number().nonnegative(),
        centro_costo: z.string().min(1),
        subarea: z.string().min(1),
        indicador_iva: z.string().min(1),
      }),
    )
    .min(1),
  excepciones: z.array(z.object({ codigo: z.string(), detalle: z.string(), confirmado_por: z.string().nullable() })),
})
export type OrdenCompra = z.infer<typeof OrdenCompraSchema>

export type Fuente = "solicitud" | "cotizacion" | "correo" | "aprobacion" | `maestro.${string}` | "derivado"
export type Trazabilidad = Record<string, { valor: unknown; fuente: Fuente; nota?: string }>

/** Supuesto 3: "H" si la descripción habla de horas; "UN" en los demás casos. */
export function unidadDe(descripcion: string): "H" | "UN" {
  return /\bhoras?\b/i.test(descripcion) ? "H" : "UN"
}

/** Supuesto 2: se trunca a 40 caracteres (texto breve SAP) sin bloquear. */
export function descripcionSap(descripcion: string): string {
  return descripcion.slice(0, LARGO_DESCRIPCION_SAP).trimEnd()
}

type Opciones = { evidenciaSha256: string; confirmadoPor: string | null }

/**
 * Construye la OC solo desde el paquete y la validación (nunca desde valores del modelo).
 * Supuestos 4 y 5: los montos salen siempre de la solicitud (IVA incluido).
 */
export function construirOrden(
  paquete: Paquete,
  validacion: ResultadoValidacion,
  opciones: Opciones,
): Resultado<{ orden: OrdenCompra; trazabilidad: Trazabilidad }> {
  const { solicitud: sol, aprobacion, cotizacion, correo } = paquete
  const prov = validacion.derivados.proveedor
  if (!validacion.apta || !prov || !aprobacion) {
    const codigos = validacion.bloqueos.map((b) => b.codigo).join(", ") || "datos incompletos"
    return { ok: false, error: `La solicitud no es apta para construir la OC (${codigos}).` }
  }

  const indicadorIva = sol.indicador_iva ?? validacion.derivados.indicador_iva?.valor
  const condicionesPago = sol.condiciones_pago ?? validacion.derivados.condiciones_pago?.valor
  const descripcion = descripcionSap(sol.descripcion)
  const unidad = unidadDe(sol.descripcion)

  const candidata = {
    referencia: { solicitud_id: sol.solicitud_id, correo_id: correo.id, cotizacion_ref: cotizacion?.referencia ?? null },
    sociedad: "1000",
    organizacion_compras: "1000",
    proveedor: { codigo_sap: prov.codigo_sap, nit: prov.nit, nombre: prov.nombre },
    moneda: sol.moneda,
    condiciones_pago: condicionesPago,
    aprobador: { email: aprobacion.de, fecha_aprobacion: aprobacion.fecha, evidencia_sha256: opciones.evidenciaSha256 },
    posiciones: [
      {
        numero: 10,
        descripcion,
        cantidad: sol.cantidad,
        unidad,
        precio_unitario: sol.valor_unitario,
        centro_costo: sol.centro_costo,
        subarea: sol.subarea,
        indicador_iva: indicadorIva,
      },
    ],
    excepciones: validacion.confirmaciones.map((c) => ({ codigo: c.codigo, detalle: c.detalle, confirmado_por: opciones.confirmadoPor })),
  }

  const r = OrdenCompraSchema.safeParse(candidata)
  if (!r.success) return { ok: false, error: `El payload no cumple el esquema OrdenCompra: ${erroresZod(r.error)}` }

  const truncada = descripcion !== sol.descripcion
  const trazabilidad: Trazabilidad = {
    "referencia.solicitud_id": { valor: sol.solicitud_id, fuente: "solicitud" },
    "referencia.correo_id": { valor: correo.id, fuente: "correo" },
    "referencia.cotizacion_ref": { valor: cotizacion?.referencia ?? null, fuente: "cotizacion" },
    sociedad: { valor: "1000", fuente: "derivado", nota: "constante de la sociedad" },
    organizacion_compras: { valor: "1000", fuente: "derivado", nota: "constante de la organización de compras" },
    "proveedor.codigo_sap": { valor: prov.codigo_sap, fuente: "maestro.proveedores", nota: `encontrado por ${prov.encontrado_por}` },
    "proveedor.nit": { valor: prov.nit, fuente: "maestro.proveedores" },
    "proveedor.nombre": { valor: prov.nombre, fuente: "maestro.proveedores" },
    moneda: { valor: sol.moneda, fuente: "solicitud" },
    condiciones_pago: sol.condiciones_pago
      ? { valor: condicionesPago, fuente: "solicitud" }
      : { valor: condicionesPago, fuente: "maestro.proveedores", nota: "RC7: derivado del proveedor" },
    "aprobador.email": { valor: aprobacion.de, fuente: "aprobacion" },
    "aprobador.fecha_aprobacion": { valor: aprobacion.fecha, fuente: "aprobacion" },
    "aprobador.evidencia_sha256": { valor: opciones.evidenciaSha256, fuente: "derivado", nota: "sha256 de aprobacion.txt" },
    "posiciones[0].numero": { valor: 10, fuente: "derivado", nota: "numeración SAP 10, 20, 30…" },
    "posiciones[0].descripcion": truncada
      ? { valor: descripcion, fuente: "derivado", nota: `truncada a ${LARGO_DESCRIPCION_SAP} caracteres desde la solicitud: "${sol.descripcion}"` }
      : { valor: descripcion, fuente: "solicitud" },
    "posiciones[0].cantidad": { valor: sol.cantidad, fuente: "solicitud" },
    "posiciones[0].unidad": { valor: unidad, fuente: "derivado", nota: unidad === "H" ? "la descripción menciona horas" : "unidad por defecto" },
    "posiciones[0].precio_unitario": { valor: sol.valor_unitario, fuente: "solicitud", nota: "IVA incluido" },
    "posiciones[0].centro_costo": { valor: sol.centro_costo, fuente: "solicitud" },
    "posiciones[0].subarea": { valor: sol.subarea, fuente: "solicitud" },
    "posiciones[0].indicador_iva": sol.indicador_iva
      ? { valor: indicadorIva, fuente: "solicitud" }
      : { valor: indicadorIva, fuente: "maestro.proveedores", nota: "RC6: derivado del proveedor, requiere confirmación" },
    excepciones: { valor: r.data.excepciones.map((e) => e.codigo), fuente: "derivado", nota: "confirmaciones de oc_validar" },
  }

  return { ok: true, data: { orden: r.data, trazabilidad } }
}
