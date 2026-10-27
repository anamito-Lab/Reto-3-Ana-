/**
 * Verificación sin modelo (PRD 6.6): llama directamente a las herramientas para los 6 casos.
 * Uso: bun run demo   → sale con código 1 si algún resultado difiere de lo esperado.
 */
import { rm } from "node:fs/promises"
import type { ResultadoValidacion } from "./src/lib/tipos.ts"
import { dirSalida } from "./src/lib/util.ts"
import * as oc from "./src/tools/oc.ts"

type Respuesta<T> = { ok: true; data: T } | { ok: false; error: string; detalle?: unknown }
type DatosCrear = { numero_oc: string; idempotente: boolean; evidencia?: string }

type Esperado = {
  apta: boolean
  bloqueos: string[]
  confirmaciones: string[]
  retroactiva: boolean
  /** Número de OC esperado, o null si no debe crearse. */
  oc: string | null
  idempotente?: boolean
  /** Verificación adicional; devuelve un mensaje si falla. */
  extra?: (v: ResultadoValidacion) => string | null
}

type Paso = { caso: string; etiqueta: string; confirmado?: boolean; esperado: Esperado }

const PASOS: Paso[] = [
  { caso: "sol-001", etiqueta: "sol-001", esperado: { apta: true, bloqueos: [], confirmaciones: [], retroactiva: false, oc: "4500000001", idempotente: false } },
  { caso: "sol-001", etiqueta: "sol-001 (2ª vez)", esperado: { apta: true, bloqueos: [], confirmaciones: [], retroactiva: false, oc: "4500000001", idempotente: true } },
  { caso: "sol-002", etiqueta: "sol-002", esperado: { apta: false, bloqueos: ["RC1"], confirmaciones: [], retroactiva: false, oc: null } },
  {
    caso: "sol-003",
    etiqueta: "sol-003",
    esperado: {
      apta: false,
      bloqueos: ["RC2"],
      confirmaciones: [],
      retroactiva: false,
      oc: null,
      extra: (v) =>
        v.bloqueos[0]?.accion_sugerida.includes("Ninguno de los aprobadores de CC-2020") ? null : "la acción de RC2 no advierte que ningún aprobador de CC-2020 tiene tope",
    },
  },
  {
    caso: "sol-004",
    etiqueta: "sol-004 (sin confirmar)",
    esperado: {
      apta: true,
      bloqueos: [],
      confirmaciones: ["RC5"],
      retroactiva: false,
      oc: null,
      extra: (v) => {
        const val = v.confirmaciones[0]?.valores
        return val?.solicitud === 25000000 && val.cotizacion === 26500000 && val.diferencia_pct === 6 ? null : "RC5 no trae 25.000.000 vs 26.500.000 (6 %)"
      },
    },
  },
  { caso: "sol-004", etiqueta: "sol-004 (confirmado)", confirmado: true, esperado: { apta: true, bloqueos: [], confirmaciones: ["RC5"], retroactiva: false, oc: "4500000002", idempotente: false } },
  { caso: "sol-005", etiqueta: "sol-005", esperado: { apta: true, bloqueos: [], confirmaciones: ["RC8"], retroactiva: true, oc: null } },
  {
    caso: "sol-006",
    etiqueta: "sol-006",
    esperado: {
      apta: true,
      bloqueos: [],
      confirmaciones: ["RC6"],
      retroactiva: false,
      oc: null,
      extra: (v) => {
        const d = v.derivados
        if (d.proveedor?.encontrado_por !== "nombre") return "el proveedor no se encontró por nombre"
        if (d.indicador_iva?.valor !== "C1") return "RC6 no derivó C1"
        if (d.condiciones_pago?.valor !== "Z030") return "RC7 no derivó Z030"
        return null
      },
    },
  },
]

const ctx = { directory: import.meta.dir, sessionId: "demo" }
const parse = <T>(s: string) => JSON.parse(s) as Respuesta<T>
const lista = (xs: string[]) => (xs.length ? xs.join(", ") : "—")
const igual = (a: string[], b: string[]) => a.join() === b.join()

function comparar(e: Esperado, v: ResultadoValidacion, numero: string | null, idempotente: boolean | null): string[] {
  const errores: string[] = []
  const bloqueos = v.bloqueos.map((b) => b.codigo)
  const confirmaciones = v.confirmaciones.map((c) => c.codigo)
  if (v.apta !== e.apta) errores.push(`apta=${v.apta}, esperado ${e.apta}`)
  if (!igual(bloqueos, e.bloqueos)) errores.push(`bloqueos [${bloqueos}], esperado [${e.bloqueos}]`)
  if (!igual(confirmaciones, e.confirmaciones)) errores.push(`confirmaciones [${confirmaciones}], esperado [${e.confirmaciones}]`)
  if (v.retroactiva !== e.retroactiva) errores.push(`retroactiva=${v.retroactiva}, esperado ${e.retroactiva}`)
  if (numero !== e.oc) errores.push(`OC ${numero ?? "ninguna"}, esperado ${e.oc ?? "ninguna"}`)
  if (e.idempotente !== undefined && idempotente !== e.idempotente) errores.push(`idempotente=${idempotente}, esperado ${e.idempotente}`)
  const extra = e.extra?.(v)
  if (extra) errores.push(extra)
  return errores
}

type Fila = { paso: string; apta: string; bloqueos: string; confirmaciones: string; retro: string; resultado: string; ok: boolean }

async function ejecutar(paso: Paso): Promise<Fila> {
  console.log(`\n━━━ ${paso.etiqueta} ━━━`)
  const validacion = parse<ResultadoValidacion>(await oc.validar.execute({ caso: paso.caso }, ctx))
  if (!validacion.ok) {
    console.log(`  error: ${validacion.error}`)
    return { paso: paso.etiqueta, apta: "?", bloqueos: "?", confirmaciones: "?", retro: "?", resultado: validacion.error, ok: false }
  }
  const v = validacion.data
  console.log(`  apta: ${v.apta}   retroactiva: ${v.retroactiva}`)
  for (const b of v.bloqueos) console.log(`  ✖ ${b.codigo} ${b.detalle}\n      → ${b.accion_sugerida}`)
  for (const c of v.confirmaciones) console.log(`  ? ${c.codigo} ${c.detalle}\n      → ${c.accion_sugerida}`)
  for (const [campo, d] of Object.entries(v.derivados)) console.log(`  ↳ derivado ${campo}: ${JSON.stringify(d)}`)

  if (v.apta) {
    const payload = parse<{ trazabilidad: string }>(await oc.construir_payload.execute({ caso: paso.caso }, ctx))
    console.log(`  payload: ${payload.ok ? `ok, trazabilidad en ${payload.data.trazabilidad}` : payload.error}`)
    const ev = parse<{ ruta: string; sha256: string }>(await oc.generar_evidencia.execute({ caso: paso.caso }, ctx))
    console.log(`  evidencia: ${ev.ok ? `${ev.data.ruta} (sha256 ${ev.data.sha256.slice(0, 12)}…)` : ev.error}`)
  }

  const crear = parse<DatosCrear>(await oc.crear.execute({ caso: paso.caso, confirmado: paso.confirmado }, ctx))
  const numero = crear.ok ? crear.data.numero_oc : null
  const idempotente = crear.ok ? crear.data.idempotente : null
  const resultado = crear.ok ? `OC ${crear.data.numero_oc}${crear.data.idempotente ? " (idempotente)" : ""}` : crear.error
  console.log(`  crear${paso.confirmado ? " [confirmado=true]" : ""}: ${resultado}`)

  const errores = comparar(paso.esperado, v, numero, idempotente)
  for (const e of errores) console.log(`  ✗ DIFIERE: ${e}`)
  return {
    paso: paso.etiqueta,
    apta: String(v.apta),
    bloqueos: lista(v.bloqueos.map((b) => b.codigo)),
    confirmaciones: lista(v.confirmaciones.map((c) => c.codigo)),
    retro: String(v.retroactiva),
    resultado: crear.ok ? resultado : crear.error.includes("bloqueos") ? "bloqueada" : "pendiente de confirmación",
    ok: errores.length === 0,
  }
}

function tabla(filas: Fila[]): void {
  const columnas: Array<[keyof Fila, string]> = [
    ["paso", "Paso"],
    ["apta", "Apta"],
    ["bloqueos", "Bloqueos"],
    ["confirmaciones", "Confirm."],
    ["retro", "Retro"],
    ["resultado", "Resultado"],
    ["ok", "OK"],
  ]
  const texto = (f: Fila, k: keyof Fila) => (k === "ok" ? (f.ok ? "✓" : "✗") : String(f[k]))
  const anchos = columnas.map(([k, t]) => Math.max(t.length, ...filas.map((f) => texto(f, k).length)))
  const linea = (celdas: string[]) => celdas.map((c, i) => c.padEnd(anchos[i] ?? 0)).join(" │ ")
  console.log(`\n${linea(columnas.map(([, t]) => t))}`)
  console.log(anchos.map((a) => "─".repeat(a)).join("─┼─"))
  for (const f of filas) console.log(linea(columnas.map(([k]) => texto(f, k))))
}

const out = dirSalida(ctx.directory)
await rm(out, { recursive: true, force: true })
console.log(`OUT_DIR limpio: ${out}`)

const filas: Fila[] = []
for (const paso of PASOS) filas.push(await ejecutar(paso))
tabla(filas)

const fallidos = filas.filter((f) => !f.ok).length
console.log(fallidos === 0 ? "\n✓ Todos los resultados coinciden con lo esperado." : `\n✗ ${fallidos} paso(s) difieren de lo esperado.`)
process.exit(fallidos === 0 ? 0 : 1)
