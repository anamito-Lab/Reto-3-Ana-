import { z } from "zod"

/** Resultado tipado que usan todas las capas: nunca se lanza, se devuelve. */
export type Resultado<T> = { ok: true; data: T } | { ok: false; error: string }

/** Acepta números o strings numéricos; cualquier otra cosa produce un error legible. */
const numero = (campo: string) =>
  z.preprocess(
    (v) => (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v)) ? Number(v) : v),
    z.number({ error: `${campo} debe ser numérico` }),
  )

const fechaIso = z.string().regex(/^\d{4}-\d{2}-\d{2}/, "debe ser una fecha AAAA-MM-DD")

// ---------- Fixtures del caso ----------

export const CorreoSchema = z.object({
  id: z.string().min(1),
  de: z.string(),
  asunto: z.string(),
  fecha: fechaIso,
  adjuntos: z.array(z.string()).default([]),
})

export const SolicitudSchema = z.object({
  solicitud_id: z.string().min(1),
  solicitante: z.string(),
  proveedor_nombre: z.string().min(1),
  proveedor_nit: z.string().optional(),
  descripcion: z.string().min(1),
  centro_costo: z.string().min(1),
  subarea: z.string().min(1),
  cantidad: numero("cantidad"),
  valor_unitario: numero("valor_unitario"),
  valor_total: numero("valor_total"),
  moneda: z.enum(["COP", "USD"]),
  indicador_iva: z.string().optional(),
  condiciones_pago: z.string().optional(),
  fecha_solicitud: fechaIso,
})
export type Solicitud = z.infer<typeof SolicitudSchema>

export const AprobacionRawSchema = z.object({
  de: z.string(),
  para: z.string(),
  fecha: fechaIso,
  asunto: z.string(),
  cuerpo: z.string(),
})

// ---------- Maestros ----------

export const ProveedorSchema = z.object({
  codigo_sap: z.string(),
  nit: z.string(),
  nombre: z.string(),
  condiciones_pago_default: z.string(),
  indicador_iva_default: z.string(),
  activo: z.boolean(),
})
export type Proveedor = z.infer<typeof ProveedorSchema>

export const CentroCostoSchema = z.object({
  centro_costo: z.string(),
  nombre: z.string().optional(),
  subareas: z.array(z.string()),
  aprobadores: z.array(z.object({ email: z.string(), nombre: z.string().optional(), tope: z.number() })),
})
export type CentroCosto = z.infer<typeof CentroCostoSchema>

export const IndicadorIvaSchema = z.object({ codigo: z.string(), descripcion: z.string(), tasa: z.number() })
export type IndicadorIva = z.infer<typeof IndicadorIvaSchema>

export const CondicionPagoSchema = z.object({ codigo: z.string(), descripcion: z.string(), dias: z.number() })
export type CondicionPago = z.infer<typeof CondicionPagoSchema>

export type Maestros = {
  proveedores: Proveedor[]
  centros: CentroCosto[]
  ivas: IndicadorIva[]
  condiciones: CondicionPago[]
}

// ---------- Paquete normalizado (PRD 7.2) ----------

export type Cotizacion = {
  referencia: string | null
  fecha: string | null
  proveedor: string
  nit: string | null
  total: number
  moneda: string
  validez_hasta: string | null
  texto: string
}

export type Aprobacion = { de: string; para: string; fecha: string; asunto: string; aprobado: boolean; texto: string }

export type Factura = { numero: string; fecha: string; total: number }

export type Paquete = {
  caso: string
  correo: { id: string; de: string; asunto: string; fecha: string }
  solicitud: Solicitud
  cotizacion: Cotizacion | null
  aprobacion: Aprobacion | null
  factura: Factura | null
  /** Qué adjuntos faltan o no se pudieron interpretar. */
  avisos: string[]
}

// ---------- Validación (PRD 7.3) ----------

export type CodigoRegla = "RC1" | "RC2" | "RC3" | "RC4" | "RC5" | "RC6" | "RC7" | "RC8" | "RC9" | "RC10"

export type Hallazgo = {
  codigo: CodigoRegla
  detalle: string
  accion_sugerida: string
  /** Solo RC5: ambos valores y la diferencia. */
  valores?: { solicitud: number; cotizacion: number | null; diferencia_pct: number | null }
}

export type Veredicto = { tipo: "bloqueo" | "confirmacion"; hallazgo: Hallazgo }

export type ProveedorEncontrado = Proveedor & { encontrado_por: "nit" | "nombre" }

export type ValorDerivado = { valor: string; descripcion: string; fuente: "maestro.proveedores"; regla: CodigoRegla }

export type Derivados = {
  proveedor?: { codigo_sap: string; nit: string; nombre: string; encontrado_por: "nit" | "nombre" }
  indicador_iva?: ValorDerivado
  condiciones_pago?: ValorDerivado
}

export type ResultadoValidacion = {
  apta: boolean
  bloqueos: Hallazgo[]
  confirmaciones: Hallazgo[]
  derivados: Derivados
  retroactiva: boolean
}
