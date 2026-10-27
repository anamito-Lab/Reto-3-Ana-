# Módulo reutilizable · Agente de Órdenes de Compra

El agente empaquetado para integrarse en otras plataformas de agentes, sin depender del servidor HTTP de este repositorio (PRD 9.4).

| Pieza | Qué es | De dónde sale |
|---|---|---|
| `agent.md` | Agente primario. Frontmatter con `description`, `mode: primary` y `permission { edit: deny, bash: deny }`; el cuerpo es el system prompt. | Se genera desde `agent/prompt.md` |
| `tools/oc.ts` | Herramientas `oc_leer_paquete`, `oc_validar`, `oc_construir_payload`, `oc_generar_evidencia` y `oc_crear`. | Reexporta `src/tools/oc.ts` (los mismos objetos) |
| `skill/ordenes-compra/SKILL.md` | Skill con el conocimiento del proceso. Frontmatter con `name` y `description`. | Se genera desde `src/knowledge/ordenes-compra.md` |

## Por qué no hay copias divergentes

- Las herramientas no se copian: `tools/oc.ts` reexporta los mismos objetos que usa la aplicación.
- `agent.md` y `SKILL.md` se regeneran con `bun run modulo` a partir de los archivos que lee el servidor.
- `bun run modulo:check` falla con código 1 si alguna pieza difiere de su fuente. Comprueba que el texto coincida y que las herramientas sean exactamente los mismos objetos que usa la aplicación.

Si cambias el prompt o el conocimiento, edita la fuente (`agent/prompt.md` o `src/knowledge/ordenes-compra.md`) y ejecuta `bun run modulo`.

## Uso desde otra plataforma

- Las herramientas siguen el contrato del PRD 6.2: `{ description, args (zod), execute(args, ctx) }`. Devuelven un string JSON `{ ok, data | error }` y nunca lanzan.
- `ctx.directory` debe apuntar a la raíz del proyecto, donde vive `fixtures/reto-03/`. La salida se escribe en `OUT_DIR` (por defecto `<raíz>/out`).
- La plataforma debe cargar `agent.md` como agente primario y `SKILL.md` como skill, y registrar `tools/oc.ts`. El nombre del archivo (`oc`) más el export dan el nombre que ve el modelo.
- El permiso `bash: deny` y `edit: deny` es coherente con el diseño: el agente solo actúa a través de sus herramientas.
- En la aplicación web, el servidor agrega además un **segundo seguro** para `oc_crear` con `confirmado=true` (ver SOLUCION.md §3). En otra plataforma, ese control queda a cargo de su mecanismo de aprobación de herramientas. La herramienta igual revalida el caso y nunca crea una OC con bloqueos.
