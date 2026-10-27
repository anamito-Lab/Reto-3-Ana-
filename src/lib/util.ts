import { createHash } from "node:crypto"
import path from "node:path"
import type { z } from "zod"

/** Raíz de salida: OUT_DIR puede ser relativo (a la raíz del proyecto) o absoluto (ej. /tmp/out). */
export function dirSalida(directory: string): string {
  return path.resolve(directory, process.env.OUT_DIR || "out")
}

/** Minúsculas, sin tildes, sin puntuación y sin sufijos societarios (S.A.S., S.A., Ltda.). */
export function normalizarNombre(nombre: string): string {
  const base = nombre
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim()
  return base.replace(/\s+(sas|sa|ltda)$/, "").trim()
}

/** "900.555.111-2" → "900555111" (sin puntos ni dígito de verificación). */
export function normalizarNit(nit: string): string {
  return (nit.replace(/[.\s]/g, "").split("-")[0] ?? "").trim()
}

/** Monto en formato colombiano ("11.400.000" o "1.234,50") → número; null si no es numérico. */
export function parsearMonto(texto: string): number | null {
  const limpio = texto.trim().replace(/\./g, "").replace(",", ".")
  if (!/^\d+(\.\d+)?$/.test(limpio)) return null
  return Number(limpio)
}

/** Día calendario de una fecha ISO (ignora la hora): "2026-08-21T10:02:00-05:00" → "2026-08-21". */
export function dia(fechaIso: string): string {
  return fechaIso.slice(0, 10)
}

export function sumarDias(fecha: string, dias: number): string {
  const d = new Date(`${dia(fecha)}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + dias)
  return d.toISOString().slice(0, 10)
}

/** 74000000 → "COP 74.000.000" (determinista, sin depender de Intl). */
export function cop(valor: number, moneda = "COP"): string {
  const entero = Math.round(valor).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".")
  return `${moneda} ${entero}`
}

export function sha256(texto: string): string {
  return createHash("sha256").update(texto, "utf8").digest("hex")
}

export function mensajeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export function erroresZod(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join(".") || "(raíz)"}: ${i.message}`).join("; ")
}
