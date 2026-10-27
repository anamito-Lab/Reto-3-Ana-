import { z } from "zod"
import type { DefinicionHerramienta } from "../llm/adapter.ts"
import type { ContextoHerramienta, Herramienta } from "../tools/herramienta.ts"
import * as oc from "../tools/oc.ts"
import { erroresZod } from "../lib/util.ts"

export type HerramientaRegistrada = {
  definicion: DefinicionHerramienta
  /** Valida los argumentos con zod antes de ejecutar; un error vuelve al modelo como resultado. */
  ejecutar(args: unknown, ctx: ContextoHerramienta): Promise<string>
}

/** Cada export de un módulo de herramientas se publica como <prefijo>_<export>. */
function registrar(prefijo: string, modulo: Record<string, Herramienta<z.ZodRawShape>>): Map<string, HerramientaRegistrada> {
  const registro = new Map<string, HerramientaRegistrada>()
  for (const [nombreExport, h] of Object.entries(modulo)) {
    const esquema = z.object(h.args)
    const { $schema, ...json } = z.toJSONSchema(esquema) as Record<string, unknown>
    const nombre = `${prefijo}_${nombreExport}`
    registro.set(nombre, {
      definicion: { nombre, descripcion: h.description, esquema: json },
      async ejecutar(args, ctx) {
        const r = esquema.safeParse(args ?? {})
        if (!r.success) return JSON.stringify({ ok: false, error: `Argumentos inválidos para ${nombre}: ${erroresZod(r.error)}` })
        return h.execute(r.data, ctx)
      },
    })
  }
  return registro
}

export const HERRAMIENTAS = registrar("oc", oc)
