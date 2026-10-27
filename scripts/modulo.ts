/**
 * Genera y verifica el módulo reutilizable (PRD 9.4) desde las fuentes de la aplicación:
 *   modulo/agent.md                        ← frontmatter + agent/prompt.md
 *   modulo/skill/ordenes-compra/SKILL.md   ← frontmatter + src/knowledge/ordenes-compra.md
 *   modulo/tools/oc.ts                     ← reexporta src/tools/oc.ts
 *
 *   bun run modulo         regenera agent.md y SKILL.md
 *   bun run modulo:check   falla (código 1) si alguna pieza diverge de la aplicación
 */
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import * as app from "../src/tools/oc.ts"
import * as modulo from "../modulo/tools/oc.ts"

const RAIZ = path.resolve(import.meta.dir, "..")
const ruta = (...p: string[]) => path.join(RAIZ, ...p)

const PIEZAS = [
  {
    destino: ruta("modulo", "agent.md"),
    fuente: ruta("agent", "prompt.md"),
    frontmatter: [
      "description: Prepara, valida (RC1–RC10) y crea órdenes de compra en SAP a partir del paquete de una solicitud; devuelve las excepciones al humano y pide confirmación explícita antes de crear.",
      "mode: primary",
      "permission:",
      "  edit: deny",
      "  bash: deny",
    ],
  },
  {
    destino: ruta("modulo", "skill", "ordenes-compra", "SKILL.md"),
    fuente: ruta("src", "knowledge", "ordenes-compra.md"),
    frontmatter: [
      "name: ordenes-compra",
      "description: Conocimiento del proceso de órdenes de compra de Periferia (cómo llega una compra, maestros, reglas RC1–RC10, convenciones SAP y qué pedir al solicitante). Úsala al procesar o explicar una solicitud de OC.",
    ],
  },
]

const normalizar = (t: string) => t.replace(/\r\n/g, "\n")
const componer = (frontmatter: string[], cuerpo: string) => `---\n${frontmatter.join("\n")}\n---\n\n${normalizar(cuerpo)}`

async function verificar(): Promise<string[]> {
  const errores: string[] = []
  for (const p of PIEZAS) {
    const esperado = componer(p.frontmatter, await readFile(p.fuente, "utf8"))
    const actual = normalizar(await readFile(p.destino, "utf8").catch(() => ""))
    if (actual !== esperado) errores.push(`${path.relative(RAIZ, p.destino)} difiere de ${path.relative(RAIZ, p.fuente)}`)
  }
  const nombres = Object.keys(app).sort()
  if (Object.keys(modulo).sort().join() !== nombres.join()) errores.push("modulo/tools/oc.ts no exporta las mismas herramientas que src/tools/oc.ts")
  for (const n of nombres) {
    if (modulo[n as keyof typeof modulo] !== app[n as keyof typeof app]) errores.push(`oc_${n} del módulo no es el mismo objeto que el de la aplicación`)
  }
  return errores
}

if (process.argv.includes("--check")) {
  const errores = await verificar()
  for (const e of errores) console.error(`✗ ${e}`)
  if (errores.length) {
    console.error("Ejecuta `bun run modulo` para regenerar el módulo.")
    process.exit(1)
  }
  console.log(`✓ modulo/ coincide con la aplicación (agent.md, SKILL.md y ${Object.keys(app).length} herramientas oc_*).`)
} else {
  for (const p of PIEZAS) {
    await writeFile(p.destino, componer(p.frontmatter, await readFile(p.fuente, "utf8")), "utf8")
    console.log(`generado ${path.relative(RAIZ, p.destino)}`)
  }
}
