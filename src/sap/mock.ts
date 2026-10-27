import { appendFile, mkdir, readFile, stat } from "node:fs/promises"
import path from "node:path"
import type { Proveedor } from "../lib/tipos.ts"
import type { OrdenCompra, SapAdapter } from "./adapter.ts"

const PRIMER_NUMERO = 4500000001

type Registro = { numero_oc: string; fecha: string; orden: OrdenCompra }

/** SAP simulado: numera desde 4500000001 y persiste en OUT_DIR/sap/ordenes.jsonl. */
export class SapMock implements SapAdapter {
  private readonly archivo: string

  constructor(
    outDir: string,
    private readonly proveedores: Proveedor[],
  ) {
    this.archivo = path.join(outDir, "sap", "ordenes.jsonl")
  }

  async consultarProveedor(nit: string): Promise<{ codigo_sap: string; activo: boolean } | null> {
    const p = this.proveedores.find((x) => x.nit === nit)
    return p ? { codigo_sap: p.codigo_sap, activo: p.activo } : null
  }

  async crearOrden(orden: OrdenCompra): Promise<{ numero_oc: string; fecha: string }> {
    const registros = await this.leer()
    const numero_oc = String(PRIMER_NUMERO + registros.length)
    const fecha = new Date().toISOString()
    await mkdir(path.dirname(this.archivo), { recursive: true })
    await appendFile(this.archivo, `${JSON.stringify({ numero_oc, fecha, orden } satisfies Registro)}\n`, "utf8")
    return { numero_oc, fecha }
  }

  async buscarOrdenPorReferencia(solicitud_id: string): Promise<{ numero_oc: string } | null> {
    const r = (await this.leer()).find((x) => x.orden.referencia.solicitud_id === solicitud_id)
    return r ? { numero_oc: r.numero_oc } : null
  }

  private async leer(): Promise<Registro[]> {
    const existe = await stat(this.archivo).then(
      () => true,
      () => false,
    )
    if (!existe) return []
    const texto = await readFile(this.archivo, "utf8")
    return texto
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as Registro)
  }
}
