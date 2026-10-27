/**
 * Herramientas del agente, importables sin el servidor. Cada export se publica como oc_<export>.
 * No es una copia: reexporta exactamente los mismos objetos que usa la aplicación (src/tools/oc.ts).
 * Requiere ctx.directory = raíz del proyecto (donde vive fixtures/reto-03/).
 */
export { leer_paquete, validar, construir_payload, generar_evidencia, crear } from "../../src/tools/oc.ts"
