import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { PDFDocument, StandardFonts } from "pdf-lib"
import type { Aprobacion } from "./tipos.ts"
import { sha256 } from "./util.ts"

/** Contenido canónico de la evidencia: el sha256 se calcula sobre este texto. */
export function contenidoEvidencia(a: Aprobacion): string {
  return [`De: ${a.de}`, `Para: ${a.para}`, `Fecha: ${a.fecha}`, `Asunto: ${a.asunto}`, "", a.texto].join("\n")
}

export function huellaEvidencia(a: Aprobacion): string {
  return sha256(contenidoEvidencia(a))
}

/** Helvetica estándar usa WinAnsi: reemplaza lo que no se puede codificar. */
function aWinAnsi(texto: string): string {
  return texto.replace(/[^\x20-\x7E\xA0-\xFF]/g, "?")
}

function partirLinea(linea: string, ancho: number): string[] {
  if (linea.length <= ancho) return [linea]
  const partes: string[] = []
  let actual = ""
  for (const palabra of linea.split(" ")) {
    if (actual && (actual + " " + palabra).length > ancho) {
      partes.push(actual)
      actual = palabra
    } else actual = actual ? `${actual} ${palabra}` : palabra
  }
  if (actual) partes.push(actual)
  return partes
}

async function pdfEvidencia(contenido: string, huella: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  doc.setTitle("Evidencia de aprobación")
  const fuente = await doc.embedFont(StandardFonts.Helvetica)
  const negrita = await doc.embedFont(StandardFonts.HelveticaBold)
  const pagina = doc.addPage([595, 842])
  let y = 790
  pagina.drawText("Evidencia de aprobación de orden de compra", { x: 50, y, size: 14, font: negrita })
  y -= 30
  for (const linea of contenido.split("\n").flatMap((l) => partirLinea(aWinAnsi(l), 90))) {
    pagina.drawText(linea, { x: 50, y, size: 10, font: fuente })
    y -= 15
  }
  y -= 15
  pagina.drawText(`sha256: ${huella}`, { x: 50, y, size: 8, font: fuente })
  return doc.save()
}

/** Escribe aprobacion.txt (contenido + sha256) y aprobacion.pdf en la carpeta del caso. */
export async function escribirEvidencia(dirCaso: string, a: Aprobacion): Promise<{ txt: string; pdf: string; sha256: string }> {
  await mkdir(dirCaso, { recursive: true })
  const contenido = contenidoEvidencia(a)
  const huella = sha256(contenido)
  const txt = path.join(dirCaso, "aprobacion.txt")
  const pdf = path.join(dirCaso, "aprobacion.pdf")
  await writeFile(txt, `${contenido}\n\n---\nsha256: ${huella}\n`, "utf8")
  await writeFile(pdf, await pdfEvidencia(contenido, huella))
  return { txt, pdf, sha256: huella }
}
