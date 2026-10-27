import type { z } from "zod"

export type ContextoHerramienta = { directory: string; sessionId: string }

/** Contrato PRD 6.2: description + args (zod) + execute que devuelve JSON string y nunca lanza. */
export type Herramienta<S extends z.ZodRawShape> = {
  description: string
  args: S
  execute(args: z.infer<z.ZodObject<S>>, ctx: ContextoHerramienta): Promise<string>
}

/** Identidad tipada: infiere el tipo de args en execute a partir del shape zod. */
export function herramienta<S extends z.ZodRawShape>(def: Herramienta<S>): Herramienta<S> {
  return def
}
