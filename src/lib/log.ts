import { appendFile, mkdir } from "node:fs/promises"
import path from "node:path"

/** Agrega una línea a OUT_DIR/log.jsonl (CA4). Nunca lanza: un fallo de log no debe tumbar el turno. */
export async function registrarLog(outDir: string, entrada: Record<string, unknown>): Promise<void> {
  try {
    await mkdir(outDir, { recursive: true })
    await appendFile(path.join(outDir, "log.jsonl"), `${JSON.stringify({ ts: new Date().toISOString(), ...entrada })}\n`, "utf8")
  } catch (e) {
    console.error("No se pudo escribir log.jsonl:", e instanceof Error ? e.message : e)
  }
}
