import { appendFile, mkdir, stat } from "node:fs/promises"
import path from "node:path"

export type ResultadoControl = "creada" | "bloqueada" | "pendiente" | "idempotente" | "error"

export type FilaControl = {
  solicitud_id: string
  resultado: ResultadoControl
  numero_oc: string | null
  retroactiva: boolean
  bloqueos: string[]
  confirmaciones: string[]
}

const COLUMNAS = ["solicitud_id", "resultado", "numero_oc", "retroactiva", "bloqueos", "confirmaciones", "ts"]

function celda(valor: string): string {
  return /[",\n]/.test(valor) ? `"${valor.replace(/"/g, '""')}"` : valor
}

/** Agrega una fila a OUT_DIR/control.csv (crea el encabezado la primera vez). */
export async function registrarControl(outDir: string, fila: FilaControl): Promise<void> {
  await mkdir(outDir, { recursive: true })
  const ruta = path.join(outDir, "control.csv")
  const existe = await stat(ruta).then(
    () => true,
    () => false,
  )
  const valores = [
    fila.solicitud_id,
    fila.resultado,
    fila.numero_oc ?? "",
    String(fila.retroactiva),
    fila.bloqueos.join("|"),
    fila.confirmaciones.join("|"),
    new Date().toISOString(),
  ]
  const encabezado = existe ? "" : `${COLUMNAS.join(",")}\n`
  await appendFile(ruta, `${encabezado}${valores.map(celda).join(",")}\n`, "utf8")
}
