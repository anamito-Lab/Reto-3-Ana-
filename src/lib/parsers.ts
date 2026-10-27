import type { z } from "zod"
import type { Aprobacion, AprobacionRawSchema, Cotizacion, Factura, Resultado } from "./tipos.ts"
import { normalizarNit, parsearMonto, sumarDias } from "./util.ts"

function grupo(texto: string, regex: RegExp, indice = 1): string | null {
  return regex.exec(texto)?.[indice]?.trim() ?? null
}

/** Extrae proveedor, NIT, total, moneda y validez del texto de la cotización. */
export function parsearCotizacion(texto: string): Resultado<Cotizacion> {
  const proveedor = grupo(texto, /^Proveedor:\s*(.+)$/m)
  if (!proveedor) return { ok: false, error: "cotizacion.txt no indica el proveedor (línea 'Proveedor:')" }

  const total = /TOTAL[^:\n]*:\s*(COP|USD)\s*([\d.,]+)/.exec(texto)
  const monto = total?.[2] ? parsearMonto(total[2]) : null
  if (!total || monto === null) {
    return { ok: false, error: "cotizacion.txt no tiene un TOTAL numérico legible" }
  }

  const nit = grupo(texto, /^NIT:\s*([\d.\s-]+)$/m)
  const fecha = grupo(texto, /^Fecha:\s*(\d{4}-\d{2}-\d{2})/m)
  const dias = grupo(texto, /Validez de la oferta:\s*(\d+)\s*d[ií]as/i)

  return {
    ok: true,
    data: {
      referencia: grupo(texto, /COTIZACI[ÓO]N\s+([A-Z0-9-]+)/i),
      fecha,
      proveedor,
      nit: nit ? normalizarNit(nit) : null,
      total: monto,
      moneda: total[1] ?? "COP",
      validez_hasta: fecha && dias ? sumarDias(fecha, Number(dias)) : null,
      texto,
    },
  }
}

/** Extrae número, fecha de emisión y total de la factura. */
export function parsearFactura(texto: string): Resultado<Factura> {
  const numero = grupo(texto, /FACTURA[^\n]*?No\.\s*([A-Z0-9-]+)/i)
  const fecha = grupo(texto, /Fecha de emisi[óo]n:\s*(\d{4}-\d{2}-\d{2})/i)
  const totalTxt = grupo(texto, /^TOTAL:\s*(?:COP|USD)\s*([\d.,]+)/m)
  const total = totalTxt ? parsearMonto(totalTxt) : null
  if (!numero || !fecha || total === null) {
    return { ok: false, error: "factura.txt no tiene número, fecha de emisión o TOTAL numérico legibles" }
  }
  return { ok: true, data: { numero, fecha, total } }
}

/** "Aprobado" en el cuerpo cuenta como aprobación salvo que diga "no aprobado". */
export function normalizarAprobacion(raw: z.infer<typeof AprobacionRawSchema>): Aprobacion {
  const aprobado = /\baprobad[oa]\b/i.test(raw.cuerpo) && !/\bno\s+aprobad[oa]\b/i.test(raw.cuerpo)
  return { de: raw.de, para: raw.para, fecha: raw.fecha, asunto: raw.asunto, aprobado, texto: raw.cuerpo }
}
