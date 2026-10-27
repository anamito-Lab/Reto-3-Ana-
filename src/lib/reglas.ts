/**
 * Reglas de control RC1–RC10 (PRD 7.3). Funciones puras: sin I/O, sin fechas del sistema.
 * Cada una recibe solo lo que necesita y devuelve su veredicto (bloqueo / confirmación) o null.
 */
import type {
  Aprobacion,
  CentroCosto,
  CodigoRegla,
  CondicionPago,
  Cotizacion,
  Derivados,
  Factura,
  IndicadorIva,
  Maestros,
  Paquete,
  Proveedor,
  ProveedorEncontrado,
  ResultadoValidacion,
  Solicitud,
  ValorDerivado,
  Veredicto,
} from "./tipos.ts"
import { cop, dia, normalizarNit, normalizarNombre } from "./util.ts"

const TOLERANCIA_COTIZACION = 0.02
const TOLERANCIA_ARITMETICA = 1

const bloqueo = (codigo: CodigoRegla, detalle: string, accion_sugerida: string): Veredicto => ({
  tipo: "bloqueo",
  hallazgo: { codigo, detalle, accion_sugerida },
})

const confirmacion = (codigo: CodigoRegla, detalle: string, accion_sugerida: string): Veredicto => ({
  tipo: "confirmacion",
  hallazgo: { codigo, detalle, accion_sugerida },
})

const mismoEmail = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

/** Texto que indica qué aprobadores del centro tienen tope suficiente (supuesto 7). */
function suficienciaDeTope(centro: CentroCosto, valor: number, moneda: string): string {
  const aptos = centro.aprobadores.filter((a) => a.tope >= valor)
  if (aptos.length === 0) {
    return `Ninguno de los aprobadores de ${centro.centro_costo} tiene tope suficiente para ${cop(valor, moneda)}: se requiere escalar la aprobación o ampliar el tope en la matriz.`
  }
  return `Aprobadores de ${centro.centro_costo} con tope suficiente: ${aptos.map((a) => a.email).join(", ")}.`
}

/** RC1: el proveedor existe (por NIT; sin NIT, por nombre normalizado) y está activo. */
export function rc1Proveedor(
  sol: Solicitud,
  proveedores: Proveedor[],
): { proveedor: ProveedorEncontrado | null; veredicto: Veredicto | null } {
  const nit = sol.proveedor_nit?.trim() ? normalizarNit(sol.proveedor_nit) : null
  const encontrado = nit
    ? proveedores.find((p) => p.nit === nit)
    : proveedores.find((p) => normalizarNombre(p.nombre) === normalizarNombre(sol.proveedor_nombre))
  const criterio = nit ? `NIT ${nit}` : `nombre "${sol.proveedor_nombre}" (la solicitud no trae NIT)`

  if (!encontrado) {
    return {
      proveedor: null,
      veredicto: bloqueo(
        "RC1",
        `El proveedor ${sol.proveedor_nombre} con ${criterio} no existe en el maestro de proveedores.`,
        "Verificar el NIT con el solicitante o solicitar la creación del proveedor en SAP (RUT y certificación bancaria) antes de crear la OC.",
      ),
    }
  }
  const proveedor: ProveedorEncontrado = { ...encontrado, encontrado_por: nit ? "nit" : "nombre" }
  if (!encontrado.activo) {
    return {
      proveedor,
      veredicto: bloqueo(
        "RC1",
        `El proveedor ${encontrado.nombre} (${encontrado.codigo_sap}) está inactivo en el maestro.`,
        "Solicitar a datos maestros la reactivación del proveedor o elegir un proveedor activo.",
      ),
    }
  }
  return { proveedor, veredicto: null }
}

/** RC2: la aprobación existe, dice "Aprobado" y viene de un aprobador del centro de costo. */
export function rc2Aprobador(sol: Solicitud, aprobacion: Aprobacion | null, centro: CentroCosto | null): Veredicto | null {
  if (!aprobacion) {
    return bloqueo("RC2", "No hay correo de aprobación en el paquete.", `Pedir al solicitante el correo de aprobación de un aprobador de ${sol.centro_costo}.`)
  }
  if (!aprobacion.aprobado) {
    return bloqueo("RC2", `El correo de ${aprobacion.de} no contiene la palabra "Aprobado".`, "Pedir al líder una aprobación explícita (\"Aprobado\").")
  }
  if (!centro) {
    return bloqueo("RC2", `No se puede verificar el aprobador: el centro de costo ${sol.centro_costo} no existe.`, "Corregir el centro de costo en la solicitud.")
  }
  if (!centro.aprobadores.some((a) => mismoEmail(a.email, aprobacion.de))) {
    const listado = centro.aprobadores.map((a) => `${a.email} (tope ${cop(a.tope, sol.moneda)})`).join(", ")
    return bloqueo(
      "RC2",
      `${aprobacion.de} no es aprobador del centro de costo ${centro.centro_costo}.`,
      `Solicitar la aprobación a un aprobador de ${centro.centro_costo}: ${listado}. ${suficienciaDeTope(centro, sol.valor_total, sol.moneda)}`,
    )
  }
  return null
}

/** RC3: valor_total ≤ tope del aprobador en ese centro. Solo aplica si el aprobador está listado (supuesto 7). */
export function rc3Tope(sol: Solicitud, aprobacion: Aprobacion | null, centro: CentroCosto | null): Veredicto | null {
  if (!aprobacion || !centro) return null
  const aprobador = centro.aprobadores.find((a) => mismoEmail(a.email, aprobacion.de))
  if (!aprobador || sol.valor_total <= aprobador.tope) return null
  return bloqueo(
    "RC3",
    `${cop(sol.valor_total, sol.moneda)} supera el tope de ${aprobador.email} en ${centro.centro_costo} (${cop(aprobador.tope, sol.moneda)}).`,
    suficienciaDeTope(centro, sol.valor_total, sol.moneda),
  )
}

/** RC4: la subárea pertenece al centro de costo. */
export function rc4Subarea(sol: Solicitud, centro: CentroCosto | null): Veredicto | null {
  if (!centro) {
    return bloqueo("RC4", `El centro de costo ${sol.centro_costo} no existe en el maestro.`, "Corregir el centro de costo en la solicitud.")
  }
  if (centro.subareas.includes(sol.subarea)) return null
  return bloqueo(
    "RC4",
    `La subárea "${sol.subarea}" no pertenece a ${centro.centro_costo}.`,
    `Corregir la subárea; las válidas para ${centro.centro_costo} son: ${centro.subareas.join(", ")}.`,
  )
}

/** RC5: diferencia cotización vs solicitud ≤ 2 %; si excede o no hay cotización, confirmación con ambos valores. */
export function rc5Cotizacion(sol: Solicitud, cotizacion: Cotizacion | null): Veredicto | null {
  if (!cotizacion) {
    const v = confirmacion("RC5", "No hay cotización para contrastar el valor de la solicitud.", "Confirmar que se crea la OC sin cotización o pedirla al solicitante.")
    v.hallazgo.valores = { solicitud: sol.valor_total, cotizacion: null, diferencia_pct: null }
    return v
  }
  const base = sol.valor_total === 0 ? 1 : sol.valor_total
  const diferencia = Math.abs(cotizacion.total - sol.valor_total) / base
  if (diferencia <= TOLERANCIA_COTIZACION) return null
  const pct = Math.round(diferencia * 1000) / 10
  const v = confirmacion(
    "RC5",
    `La cotización (${cop(cotizacion.total, cotizacion.moneda)}) difiere ${pct} % de la solicitud (${cop(sol.valor_total, sol.moneda)}); el máximo es 2 %.`,
    `Si confirmas, la OC sale por el valor de la solicitud (${cop(sol.valor_total, sol.moneda)}) y la diferencia queda como excepción. Si no, pedir al solicitante una solicitud y aprobación ajustadas a la cotización.`,
  )
  v.hallazgo.valores = { solicitud: sol.valor_total, cotizacion: cotizacion.total, diferencia_pct: pct }
  return v
}

/** RC6: sin indicador de IVA → se deriva del proveedor y se pide confirmación. */
export function rc6Iva(
  sol: Solicitud,
  proveedor: Proveedor | null,
  ivas: IndicadorIva[],
  cotizacion: Cotizacion | null,
): { derivado: ValorDerivado | null; veredicto: Veredicto | null } {
  if (sol.indicador_iva) return { derivado: null, veredicto: null }
  if (!proveedor) {
    return {
      derivado: null,
      veredicto: confirmacion("RC6", "La solicitud no informa indicador de IVA y no se puede derivar porque el proveedor no se encontró.", "Pedir al solicitante el indicador de IVA."),
    }
  }
  const codigo = proveedor.indicador_iva_default
  const descripcion = ivas.find((i) => i.codigo === codigo)?.descripcion ?? "sin descripción en el maestro"
  const ivaCotizacion = cotizacion ? /IVA\s*(\d+)\s*%/i.exec(cotizacion.texto)?.[1] : undefined
  const apoyo = ivaCotizacion ? ` La cotización muestra IVA ${ivaCotizacion} %.` : ""
  return {
    derivado: { valor: codigo, descripcion, fuente: "maestro.proveedores", regla: "RC6" },
    veredicto: confirmacion(
      "RC6",
      `La solicitud no informa indicador de IVA; se deriva ${codigo} (${descripcion}) del maestro del proveedor ${proveedor.nombre.replace(/\.$/, "")}.${apoyo}`,
      `Confirmar el indicador ${codigo} o indicar el correcto.`,
    ),
  }
}

/** RC7: sin condiciones de pago → se derivan del proveedor. Solo se informa. */
export function rc7CondicionesPago(sol: Solicitud, proveedor: Proveedor | null, condiciones: CondicionPago[]): ValorDerivado | null {
  if (sol.condiciones_pago || !proveedor) return null
  const codigo = proveedor.condiciones_pago_default
  const descripcion = condiciones.find((c) => c.codigo === codigo)?.descripcion ?? "sin descripción en el maestro"
  return { valor: codigo, descripcion, fuente: "maestro.proveedores", regla: "RC7" }
}

/** RC8: factura con fecha anterior a la solicitud → OC retroactiva, confirmación. */
export function rc8Retroactiva(sol: Solicitud, factura: Factura | null): { retroactiva: boolean; veredicto: Veredicto | null } {
  if (!factura || dia(factura.fecha) >= dia(sol.fecha_solicitud)) return { retroactiva: false, veredicto: null }
  return {
    retroactiva: true,
    veredicto: confirmacion(
      "RC8",
      `La factura ${factura.numero} (${dia(factura.fecha)}) es anterior a la solicitud (${dia(sol.fecha_solicitud)}): la OC es retroactiva.`,
      "Confirmar la creación como OC retroactiva; quedará marcada retroactiva=true en el log de control para medición.",
    ),
  }
}

/** RC9: la aprobación no puede ser anterior a la solicitud (comparación por día calendario, supuesto 1). */
export function rc9FechaAprobacion(sol: Solicitud, aprobacion: Aprobacion | null): Veredicto | null {
  if (!aprobacion || dia(aprobacion.fecha) >= dia(sol.fecha_solicitud)) return null
  return confirmacion(
    "RC9",
    `La aprobación (${dia(aprobacion.fecha)}) es anterior a la fecha de la solicitud (${dia(sol.fecha_solicitud)}).`,
    "Confirmar que la aprobación corresponde a esta solicitud o pedir una aprobación posterior.",
  )
}

/** RC10: cantidad × valor_unitario = valor_total (± 1 unidad monetaria). */
export function rc10Aritmetica(sol: Solicitud): Veredicto | null {
  const calculado = sol.cantidad * sol.valor_unitario
  if (Math.abs(calculado - sol.valor_total) <= TOLERANCIA_ARITMETICA) return null
  return bloqueo(
    "RC10",
    `cantidad × valor unitario = ${cop(calculado, sol.moneda)}, pero el valor total es ${cop(sol.valor_total, sol.moneda)}.`,
    "Pedir al solicitante que corrija cantidad, valor unitario o valor total en la solicitud.",
  )
}

/** Aplica RC1–RC10 y consolida el resultado. Pura: misma entrada, misma salida. */
export function evaluar(paquete: Paquete, maestros: Maestros): ResultadoValidacion {
  const sol = paquete.solicitud
  const centro = maestros.centros.find((c) => c.centro_costo === sol.centro_costo) ?? null

  const r1 = rc1Proveedor(sol, maestros.proveedores)
  const r6 = rc6Iva(sol, r1.proveedor, maestros.ivas, paquete.cotizacion)
  const r7 = rc7CondicionesPago(sol, r1.proveedor, maestros.condiciones)
  const r8 = rc8Retroactiva(sol, paquete.factura)

  const veredictos = [
    r1.veredicto,
    rc2Aprobador(sol, paquete.aprobacion, centro),
    rc3Tope(sol, paquete.aprobacion, centro),
    rc4Subarea(sol, centro),
    rc5Cotizacion(sol, paquete.cotizacion),
    r6.veredicto,
    r8.veredicto,
    rc9FechaAprobacion(sol, paquete.aprobacion),
    rc10Aritmetica(sol),
  ].filter((v): v is Veredicto => v !== null)

  const derivados: Derivados = {}
  if (r1.proveedor) {
    const { codigo_sap, nit, nombre, encontrado_por } = r1.proveedor
    derivados.proveedor = { codigo_sap, nit, nombre, encontrado_por }
  }
  if (r6.derivado) derivados.indicador_iva = r6.derivado
  if (r7) derivados.condiciones_pago = r7

  const bloqueos = veredictos.filter((v) => v.tipo === "bloqueo").map((v) => v.hallazgo)
  const confirmaciones = veredictos.filter((v) => v.tipo === "confirmacion").map((v) => v.hallazgo)
  return { apta: bloqueos.length === 0, bloqueos, confirmaciones, derivados, retroactiva: r8.retroactiva }
}
