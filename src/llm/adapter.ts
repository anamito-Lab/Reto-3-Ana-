/**
 * Interfaz propia del proveedor LLM. El ciclo del agente solo conoce estos tipos:
 * cambiar de proveedor significa escribir otra implementación de ProveedorLLM.
 */

export type BloqueTexto = { tipo: "texto"; texto: string }
export type BloqueLlamada = { tipo: "llamada"; id: string; nombre: string; argumentos: unknown }
export type BloqueResultado = { tipo: "resultado"; id: string; contenido: string; esError: boolean }
export type Bloque = BloqueTexto | BloqueLlamada | BloqueResultado

export type Mensaje = {
  rol: "usuario" | "asistente"
  bloques: Bloque[]
  /**
   * Respuesta original del proveedor. Se reenvía sin cambios en el siguiente request
   * (algunos proveedores exigen devolver bloques internos, como el razonamiento, tal cual).
   */
  crudo?: { proveedor: string; contenido: unknown }
}

export type DefinicionHerramienta = { nombre: string; descripcion: string; esquema: Record<string, unknown> }

export type MotivoFin = "fin" | "herramientas" | "limite_tokens" | "rechazo" | "otro"

export type RespuestaLLM = {
  mensaje: Mensaje
  motivoFin: MotivoFin
  uso: { entrada: number; salida: number }
}

export type TipoErrorLLM = "sin_clave" | "autenticacion" | "limite" | "timeout" | "conexion" | "proveedor"

/** Error del proveedor ya traducido a lenguaje claro (nunca incluye la clave). */
export class ErrorLLM extends Error {
  constructor(
    message: string,
    readonly tipo: TipoErrorLLM,
  ) {
    super(message)
  }
}

export interface ProveedorLLM {
  readonly proveedor: string
  readonly modelo: string
  enviar(mensajes: Mensaje[], herramientas: DefinicionHerramienta[]): Promise<RespuestaLLM>
}
