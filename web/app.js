// Front del chat: HTML + JS plano. Habla solo con /api/*; nunca ve la API key.
const $ = (sel) => document.querySelector(sel)
const chat = $("#chat")
const bienvenida = $("#bienvenida")
const form = $("#formulario")
const entrada = $("#mensaje")
const botonEnviar = $("#enviar")

const TEXTO_CONFIRMAR = "Confirmo"
const TEXTO_RECHAZAR = "No confirmo, no crees la OC"
const CLAVE_SESION = "oc-agente-sesion"

let sessionId = leerSesion() || nuevaId()
let ocupado = false

function nuevaId() {
  return window.crypto?.randomUUID?.() ?? `s-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}
function leerSesion() {
  try { return localStorage.getItem(CLAVE_SESION) } catch { return null }
}
function guardarSesion(id) {
  try { localStorage.setItem(CLAVE_SESION, id) } catch { /* sin almacenamiento: la sesión vive solo en esta pestaña */ }
}

// ---------- Markdown mínimo y seguro (escapa todo antes de dar formato) ----------

function escapar(texto) {
  return String(texto).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])
}
function enLinea(texto) {
  return escapar(texto)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])_([^_]+)_(?=[\s.,;:)]|$)/g, "$1<em>$2</em>")
}
function celdas(linea) {
  return linea.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim())
}
function markdown(texto) {
  const lineas = String(texto).replace(/\r/g, "").split("\n")
  const html = []
  let i = 0
  while (i < lineas.length) {
    const l = lineas[i]
    if (!l.trim()) { i++; continue }
    if (l.trim().startsWith("|")) {
      const filas = []
      while (i < lineas.length && lineas[i].trim().startsWith("|")) filas.push(lineas[i++])
      const cuerpo = filas.filter((f) => !/^\s*\|?\s*:?-{2,}/.test(f))
      const [cabecera, ...resto] = cuerpo
      html.push(`<div class="tabla"><table><thead><tr>${celdas(cabecera).map((c) => `<th>${enLinea(c)}</th>`).join("")}</tr></thead><tbody>${resto.map((f) => `<tr>${celdas(f).map((c) => `<td>${enLinea(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`)
      continue
    }
    const titulo = /^(#{1,4})\s+(.*)$/.exec(l)
    if (titulo) { html.push(`<h4>${enLinea(titulo[2])}</h4>`); i++; continue }
    if (/^\s*[-*]\s+/.test(l) || /^\s*\d+\.\s+/.test(l)) {
      const ordenada = /^\s*\d+\.\s+/.test(l)
      const items = []
      while (i < lineas.length && (/^\s*[-*]\s+/.test(lineas[i]) || /^\s*\d+\.\s+/.test(lineas[i]))) {
        items.push(`<li>${enLinea(lineas[i].replace(/^\s*([-*]|\d+\.)\s+/, ""))}</li>`)
        i++
      }
      html.push(ordenada ? `<ol>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`)
      continue
    }
    const parrafo = []
    while (i < lineas.length && lineas[i].trim() && !lineas[i].trim().startsWith("|") && !/^(#{1,4})\s/.test(lineas[i]) && !/^\s*([-*]|\d+\.)\s+/.test(lineas[i])) {
      parrafo.push(enLinea(lineas[i++]))
    }
    html.push(`<p>${parrafo.join("<br>")}</p>`)
  }
  return html.join("")
}

// ---------- Render ----------

function el(etiqueta, clase, html) {
  const n = document.createElement(etiqueta)
  if (clase) n.className = clase
  if (html !== undefined) n.innerHTML = html
  return n
}

function bajar() {
  chat.scrollTop = chat.scrollHeight
}

function json(valor) {
  const t = JSON.stringify(valor, null, 2) ?? ""
  return t.length > 6000 ? `${t.slice(0, 6000)}\n… (recortado)` : t
}

function tarjetaHerramienta(t) {
  const clases = ["tool"]
  if (!t.ok) clases.push("fallo")
  if (t.confirmaciones.length) clases.push("con-confirmacion")
  if (t.bloqueos.length) clases.push("con-bloqueo")
  const d = el("details", clases.join(" "))
  const chips = [
    ...t.bloqueos.map((c) => `<span class="chip bloqueo">${escapar(c)}</span>`),
    ...t.confirmaciones.map((c) => `<span class="chip confirmacion">${escapar(c)}</span>`),
  ].join("")
  d.innerHTML = `
    <summary><span class="tool-nombre">${escapar(t.nombre)}</span>${chips}<span class="tool-resumen">${escapar(t.resumen)}</span></summary>
    <div class="tool-cuerpo">
      <h5>Argumentos</h5><pre>${escapar(json(t.argumentos))}</pre>
      <h5>Resultado</h5><pre>${escapar(json(t.resultado))}</pre>
    </div>`
  return d
}

function desactivarConfirmaciones() {
  document.querySelectorAll(".confirmacion-barra button").forEach((b) => { b.disabled = true })
}

function pintarUsuario(texto) {
  bienvenida.hidden = true
  const m = el("div", "mensaje usuario")
  const b = el("div", "burbuja")
  b.textContent = texto
  m.append(b)
  chat.append(m)
  bajar()
}

function pintarAgente({ reply, toolCalls = [], needsConfirmation = false, error = false }, interactivo = true) {
  bienvenida.hidden = true
  const m = el("div", "mensaje agente")
  if (toolCalls.length) {
    const lista = el("div", "herramientas")
    toolCalls.forEach((t) => lista.append(tarjetaHerramienta(t)))
    m.append(lista)
  }
  const clase = ["burbuja", error ? "error" : "", needsConfirmation ? "pide-confirmacion" : ""].filter(Boolean).join(" ")
  m.append(el("div", clase, markdown(reply)))
  if (needsConfirmation) {
    const barra = el("div", "confirmacion-barra")
    barra.append(el("span", "", "⚠️ El agente necesita tu confirmación para continuar"))
    const si = el("button", "boton confirmar", "Confirmar")
    const no = el("button", "boton rechazar", "Rechazar")
    si.type = no.type = "button"
    si.onclick = () => enviar(TEXTO_CONFIRMAR)
    no.onclick = () => enviar(TEXTO_RECHAZAR)
    si.disabled = no.disabled = !interactivo
    barra.append(si, no)
    m.append(barra)
  }
  chat.append(m)
  bajar()
}

function pintarPensando() {
  const m = el("div", "mensaje agente pensando")
  m.append(el("div", "burbuja", '<span>Pensando</span><span class="punto"></span><span class="punto"></span><span class="punto"></span>'))
  chat.append(m)
  bajar()
  return m
}

// ---------- Acciones ----------

function bloquear(valor) {
  ocupado = valor
  botonEnviar.disabled = valor
  entrada.disabled = valor
  document.querySelectorAll(".sugerencias button").forEach((b) => { b.disabled = valor })
}

async function enviar(texto) {
  const mensaje = texto.trim()
  if (!mensaje || ocupado) return
  desactivarConfirmaciones()
  pintarUsuario(mensaje)
  bloquear(true)
  const pensando = pintarPensando()
  try {
    const r = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, message: mensaje }),
    })
    const datos = await r.json().catch(() => ({}))
    pensando.remove()
    if (!r.ok) {
      pintarAgente({ reply: `⚠️ ${datos.error ?? `Error ${r.status}`}`, error: true })
    } else {
      sessionId = datos.sessionId ?? sessionId
      guardarSesion(sessionId)
      pintarAgente(datos)
    }
  } catch {
    pensando.remove()
    pintarAgente({ reply: "⚠️ No se pudo contactar al servidor. Revisa tu conexión e inténtalo de nuevo.", error: true })
  } finally {
    bloquear(false)
    entrada.focus()
  }
}

async function restaurar() {
  try {
    const r = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`)
    if (!r.ok) return
    const s = await r.json()
    const ultimo = s.transcript.length - 1
    s.transcript.forEach((e, i) => {
      if (e.rol === "usuario") pintarUsuario(e.texto)
      else pintarAgente({ reply: e.texto, toolCalls: e.toolCalls, needsConfirmation: e.needsConfirmation, error: e.error }, i === ultimo)
    })
  } catch { /* sin historial previo */ }
}

async function salud() {
  const estado = $("#estado")
  try {
    const r = await fetch("/api/health")
    const s = await r.json()
    estado.textContent = `${s.provider} · ${s.model}${s.apiKeyConfigurada ? "" : " · sin API key"}`
    estado.classList.toggle("mal", !s.apiKeyConfigurada)
  } catch {
    estado.textContent = "Servidor no disponible"
    estado.classList.add("mal")
  }
}

function nuevaSesion() {
  if (ocupado) return
  sessionId = nuevaId()
  guardarSesion(sessionId)
  chat.querySelectorAll(".mensaje").forEach((n) => n.remove())
  bienvenida.hidden = false
  entrada.focus()
}

form.addEventListener("submit", (e) => {
  e.preventDefault()
  const texto = entrada.value
  entrada.value = ""
  entrada.style.height = "auto"
  enviar(texto)
})
entrada.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault()
    form.requestSubmit()
  }
})
entrada.addEventListener("input", () => {
  entrada.style.height = "auto"
  entrada.style.height = `${Math.min(entrada.scrollHeight, 160)}px`
})
document.querySelectorAll(".sugerencias button").forEach((b) => b.addEventListener("click", () => enviar(b.dataset.texto)))
$("#nueva").addEventListener("click", nuevaSesion)

guardarSesion(sessionId)
salud()
restaurar()
