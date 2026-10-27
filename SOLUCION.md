# SOLUCIÓN · Reto 03 · Agente de Órdenes de Compra SAP

## 1. Problema en una frase

La analista administrativa digita a mano en SAP cada orden de compra y valida de memoria que proveedor, aprobador, tope y montos cuadren. Esto le cuesta tiempo a ella, le genera correcciones en el cierre a Contabilidad y le impide a la dirección medir cuántas OC se crean después de recibir la factura.

## 2. Arquitectura

```
┌───────────────────┐  POST /api/chat     ┌──────────────────────────────────────────────┐
│ web/ (HTML + JS)  │ ──────────────────▶ │ src/server.ts (Hono sobre Bun)               │
│ historial, tool   │ ◀────────────────── │  sesiones en memoria · topes · health        │
│ cards, confirmar  │ reply, toolCalls,   │                                              │
└───────────────────┘ needsConfirmation   │  src/agent/loop.ts  ── ciclo propio ──┐      │
                                          │      │                                │      │
                                          │      ▼                                ▼      │
                                          │  src/llm/adapter.ts          src/agent/registro.ts
                                          │  └ anthropic.ts (SDK)        └ src/tools/oc.ts
                                          └──────────────────────────────────┬───────────┘
                                                                             │
                          ┌──────────────────────────────────────────────────┼─────────────────┐
                          ▼                                                  ▼                 ▼
               src/lib/ (reglas puras RC1–RC10,                  src/sap/mock.ts       OUT_DIR/
               fixtures, parsers, payload, evidencia)            (SapAdapter)          control.csv, log.jsonl,
                          │                                           │               <caso>/trazabilidad.json,
                          ▼                                           ▼               aprobacion.txt/.pdf
               fixtures/reto-03/ (solo lectura)               OUT_DIR/sap/ordenes.jsonl
```

| Capa | Dónde vive | Qué contiene |
|---|---|---|
| **Comportamiento** | `agent/prompt.md` | Rol, reglas no negociables (CA2, CA3), flujo y formato de respuesta. |
| **Conocimiento** | `src/knowledge/ordenes-compra.md` | Cómo llega una compra, maestros, reglas RC, convenciones SAP, qué pedir al solicitante. |
| **Ejecución** | `src/tools/oc.ts` → `src/lib/` | Herramientas tipadas con zod. La lógica de negocio está en funciones puras (`reglas.ts`, `orden.ts`). |

El servidor arma el system prompt concatenando `prompt.md` y el archivo de conocimiento. Un cambio en las reglas de negocio toca `src/lib/reglas.ts` y `src/knowledge/`, nunca el servidor ni el ciclo.

**Dependencias**

| Paquete | Por qué |
|---|---|
| `hono` | Router HTTP mínimo que corre nativo en Bun y sirve archivos estáticos. |
| `@anthropic-ai/sdk` | SDK oficial del proveedor. Va encapsulado detrás de `src/llm/adapter.ts`. |
| `zod` | Obligatorio: argumentos de herramientas, esquema `OrdenCompra`, fixtures y cuerpo de la API. Su `toJSONSchema` genera el esquema que ve el modelo. |
| `pdf-lib` | Evidencia en PDF (P1) sin dependencias nativas. |
| `typescript`, `@types/bun` (dev) | Chequeo estricto (`strict`, sin `any`). |

## 3. Ciclo del agente

Lo implementé a mano en `src/agent/loop.ts`, sin frameworks de agentes:

1. Llega el mensaje del usuario y se agrega al historial de la sesión.
2. `llm.enviar(historial, herramientas)`. El adaptador devuelve bloques neutrales (texto o llamada) y guarda la respuesta original del proveedor para reenviarla sin cambios en el siguiente request.
3. Si el modelo pidió herramientas, el ciclo valida los argumentos con zod, ejecuta cada una, registra la llamada en `OUT_DIR/log.jsonl` (CA4) y agrega todos los resultados en un solo mensaje. Luego vuelve al paso 2.
4. Si el modelo terminó, su texto es la respuesta del turno.

**Topes (CA1 y costo).** El turno se detiene si alcanza `MAX_ITERACIONES` vueltas modelo → herramientas. En ese caso responde con un resumen determinista de lo que obtuvo y lo que falta. Ese resumen lo arma el código, sin llamar otra vez al modelo. También se acumulan los tokens de entrada y salida por sesión: al llegar a `MAX_TOKENS_SESION` no se hacen más llamadas.

**Errores (CA5).** El adaptador traduce los errores del SDK (key inválida, sin créditos, límite de solicitudes, timeout, sin conexión) a `ErrorLLM` con un mensaje claro en español. El ciclo los devuelve como respuesta del turno y la sesión sigue viva. Todo texto con forma de clave (`sk-ant-…`) se tapa antes de mostrarse.

**Confirmación humana con doble seguro (CA3).**

- **(a) Prompt.** Cuando hay confirmaciones, el agente debe cerrar el turno con una pregunta explícita y no llamar `oc_crear` con `confirmado=true` en ese mismo turno.
- **(b) Backend.** El ciclo lee los resultados de `oc_validar`, `oc_construir_payload` y `oc_crear`. Si quedaron confirmaciones pendientes, guarda en la sesión `confirmacionPendiente = { caso, codigos }` y la API responde `needsConfirmation=true`. En el turno siguiente, `oc_crear` con `confirmado=true` solo se ejecuta si se cumplen tres condiciones:
  1. El turno anterior terminó con una confirmación pendiente.
  2. Esa confirmación es **para el mismo caso**.
  3. El mensaje actual del usuario es una confirmación explícita: empieza por sí / confirmo / apruebo / dale / procede y no contiene "no".

  Si no se cumplen, el servidor no ejecuta la herramienta y le devuelve al modelo un error que le indica preguntar.
- **Además, la herramienta no confía en nada de lo que envía el modelo.** `oc_crear` vuelve a leer el caso, reaplica RC1–RC10 y reconstruye la OC desde los fixtures. Ignora cualquier `payload` que el modelo envíe, así que tampoco puede alterar montos.

Probé el doble seguro con un modelo falso que sigue un guion fijo, sin gastar tokens:
- Crear sin haber preguntado: bloqueado.
- Crear después de "No confirmo": bloqueado.
- Confirmar un caso distinto del que se preguntó: bloqueado.
- Confirmar sol-004 después de preguntar: OC creada.

## 4. Elección del modelo

- **Proveedor y modelo:** Anthropic, `claude-opus-5-5`. Se cambia con `LLM_MODEL`.
- **Por qué:** el flujo es corto pero exige seguir instrucciones con rigor: no inventar valores, detenerse a preguntar y presentar tablas fieles a lo que devolvieron las herramientas. Para eso conviene un modelo fuerte en uso de herramientas. Es además el modelo por defecto recomendado por el proveedor y cuesta menos que la generación anterior de Opus.
- **Configuración:**
  - Esfuerzo `medium`, suficiente para un flujo guiado de 4 o 5 herramientas.
  - System prompt marcado para caché.
  - Reintento automático en un modelo alternativo si el modelo declina por política (beta del proveedor).
  - Timeout configurable y un reintento.
- **Costo estimado por caso**, con los precios publicados de USD 4 por millón de tokens de entrada y USD 20 por millón de salida:

| Componente | Estimación |
|---|---|
| System prompt + definiciones de herramientas | ≈ 3.000 tokens fijos por llamada |
| Llamadas al modelo por caso | 4–6 (leer, validar, payload + evidencia, crear, respuesta) |
| Entrada acumulada por caso | ≈ 20.000–30.000 tokens → USD 0,08–0,12 |
| Salida (texto + razonamiento) | ≈ 2.000–4.000 tokens → USD 0,04–0,08 |
| **Total por caso** | **≈ USD 0,10–0,20**; un turno extra de confirmación suma ≈ USD 0,05 |

**Medición real** (tokens de entrada + salida que reporta el API, acumulados por sesión):

| Caso | Turnos | Tokens | Costo aproximado | Tiempo |
|---|---|---|---|---|
| sol-001 (creación directa) | 1 | 26.618 | ≈ USD 0,12–0,15 | 10,5 s |
| sol-004 (revisión + confirmación) | 2 | 38.790 | ≈ USD 0,17–0,21 | 14,7 s + 5,5 s |

El rango de costo sale de suponer que entre el 90 % y el 95 % de los tokens son de entrada. El gasto exacto se ve en la consola de Anthropic. Confirma la estimación inicial: un caso cuesta entre USD 0,10 y 0,20. Con `MAX_TOKENS_SESION=200000`, una sesión no puede gastar más de ≈ USD 1.

## 5. Matriz de controles

Cada regla es una función pura en `src/lib/reglas.ts` (sin I/O ni fecha del sistema). `evaluar()` las combina en `{ apta, bloqueos, confirmaciones, derivados, retroactiva }`.

| Regla | Función | Implementación | Caso que la ejerce |
|---|---|---|---|
| RC1 | `rc1Proveedor` | Busca por NIT normalizado (sin puntos ni dígito de verificación). Sin NIT, compara el nombre normalizado. Bloquea si no existe o si está inactivo. | sol-002 (bloqueo), sol-006 (por nombre) |
| RC2 | `rc2Aprobador` | Aprobación presente, con "Aprobado" sin negación, y remitente listado en el centro. La acción sugerida lista los aprobadores del centro y si alguno tiene tope suficiente. | sol-003 |
| RC3 | `rc3Tope` | Solo si el aprobador está listado (si no, ya bloquea RC2). Compara `valor_total` con el tope. | — |
| RC4 | `rc4Subarea` | La subárea pertenece al centro; un centro inexistente también bloquea. | — |
| RC5 | `rc5Cotizacion` | `abs(cot − sol) / sol > 2 %` → confirmación con `valores { solicitud, cotizacion, diferencia_pct }`. Sin cotización, también se confirma. | sol-004 (6 %) |
| RC6 | `rc6Iva` | Sin indicador, se deriva `indicador_iva_default` del proveedor y se pide confirmación. Si la cotización muestra la tasa, se cita como apoyo. | sol-006 (C1) |
| RC7 | `rc7CondicionesPago` | Sin condiciones, se derivan del proveedor. Solo se informan. | sol-006 (Z030) |
| RC8 | `rc8Retroactiva` | Factura con fecha anterior a la solicitud → `retroactiva=true` + confirmación. | sol-005 |
| RC9 | `rc9FechaAprobacion` | La aprobación no puede ser anterior a la solicitud; se compara por día calendario. | — (sol-004 aprueba el mismo día: válida) |
| RC10 | `rc10Aritmetica` | `abs(cantidad × valor_unitario − valor_total) ≤ 1`. | — |

**La más difícil: RC2 con RC3 (sol-003).** El código es sencillo. Lo difícil es decidir cómo se combinan las dos reglas y qué devolverle al humano. Si fvargas no es aprobador de CC-2020, evaluar RC3 contra su tope en otro centro (CC-3030, 80 M) daría un "pasa" engañoso. Por eso RC3 solo se evalúa cuando el aprobador está listado en el centro.

Aun así, decir solo "no es aprobador" no basta. El único aprobador de CC-2020 (rtorres, tope 30 M) tampoco podría aprobar 74 M. Si la analista solo pidiera "la firma de rtorres", el caso volvería a bloquearse. Por eso la acción sugerida de RC2 adelanta el análisis de tope de todo el centro: "ninguno tiene tope suficiente: escalar".

## 6. Diseño del adaptador SAP real

**Elección: OData `API_PURCHASEORDER_PROCESS_SRV` expuesto a través de SAP Integration Suite / API Management. Si el sistema es ECC, `BAPI_PO_CREATE1` vía RFC.** El agente no cambia: ambas opciones implementan la misma interfaz `SapAdapter`.

| Opción | A favor | En contra | Decisión |
|---|---|---|---|
| OData `API_PURCHASEORDER_PROCESS_SRV` | API estándar de S/4HANA, REST/JSON, admite payload profundo (cabecera + posiciones + imputación en una llamada) y `$filter` para la idempotencia. | Requiere S/4HANA y la API activada. | **Primera opción** |
| RFC / `BAPI_PO_CREATE1` | Disponible en ECC y S/4. Es lo que hoy hace la transacción ME21N. | Necesita conector RFC (JCo/NCo o un middleware), es más difícil de operar desde la nube y devuelve errores en tabla `RETURN`. | Si el sistema es ECC |
| SAP Integration Suite | Desacopla: el agente llama una API propia y la iFlow decide OData o BAPI. Centraliza credenciales y monitoreo. | Costo de licencia y de desarrollo de la iFlow. | **Recomendado como capa intermedia** si ya existe |
| Carga por archivo | No requiere conexión en línea. | Asíncrona, sin número de OC inmediato. | Plan B |

**Mapeo del payload (7.4) a OData.** Nombres de referencia; hay que validarlos contra el `$metadata` del sistema real.

| Payload | OData (cabecera `A_PurchaseOrder` / posición `A_PurchaseOrderItem`) | Nota |
|---|---|---|
| `sociedad` | `CompanyCode` | `1000` |
| `organizacion_compras` | `PurchasingOrganization` | `1000`. También hacen falta `PurchasingGroup` y `PurchaseOrderType` (p. ej. `NB`), que deben venir de configuración. |
| `proveedor.codigo_sap` | `Supplier` | |
| `moneda` | `DocumentCurrency` | |
| `condiciones_pago` | `PaymentTerms` | |
| `referencia.solicitud_id` | Campo de referencia externa de cabecera (p. ej. `CorrespncExternalReference`) | Llave de idempotencia. |
| `posiciones[].numero` | `PurchaseOrderItem` | 10, 20… |
| `posiciones[].descripcion` | `PurchaseOrderItemText` | 40 caracteres |
| `posiciones[].cantidad` / `unidad` | `OrderQuantity` / `PurchaseOrderQuantityUnit` | Mapear `UN`/`H` a las unidades ISO del sistema. |
| `posiciones[].precio_unitario` | `NetPriceAmount` | **Ojo:** SAP espera el precio **neto**. Como el payload trae el precio con IVA (supuesto 5), el adaptador real debe calcular `precio / (1 + tasa)` según el indicador. |
| `posiciones[].indicador_iva` | `TaxCode` | |
| `posiciones[].centro_costo` | Imputación `K` → `CostCenter` | También requiere `GLAccount`, que se derivaría de una tabla subárea → cuenta. |
| `posiciones[].subarea` | Según el modelo contable: orden interna, segmento o campo Z | Decisión pendiente con Contabilidad. |
| `aprobador.*`, evidencia | Texto de cabecera + adjunto vía servicio de adjuntos (`API_CV_ATTACHMENT_SRV`) | El PDF se adjunta después de crear la OC. |
| `excepciones` | Texto de cabecera | Visible para auditoría dentro de SAP. |

En BAPI, el mapeo equivalente va a `POHEADER`, `POITEM`, `POACCOUNT` y `POTEXTHEADER`, con sus tablas `X` de marcado.

**Autenticación y credenciales.** OAuth 2.0 client credentials (o certificado X.509) para un usuario técnico con permisos mínimos: crear OC solo para la sociedad `1000` y leer proveedores. Las credenciales viven en un gestor de secretos (Azure Key Vault, AWS Secrets Manager o las credenciales de Integration Suite) y se inyectan al backend como variables de entorno. Nunca llegan al agente, al prompt, al front ni a los logs. El modelo ni siquiera sabe que existen: solo ve la herramienta `oc_crear`.

**Idempotencia y errores parciales.**

1. Antes de crear, `buscarOrdenPorReferencia(solicitud_id)` consulta la referencia externa (`$filter`). Si la OC ya existe, se devuelve su número. El mock ya hace esto.
2. Un candado por `solicitud_id` en el backend evita dobles clics concurrentes.
3. Si hay timeout o error de red después de enviar, **no se reintenta a ciegas**: se vuelve a consultar por referencia. Si la OC aparece, se toma su número; si no, se reintenta.
4. Error parcial: la OC se creó pero el adjunto falló. Se registra en `control.csv` como `creada_sin_evidencia` y se reintenta solo el adjunto. Nunca se crea una segunda OC.
5. Errores de negocio de SAP (proveedor bloqueado, período cerrado) se devuelven al humano como bloqueos, con el mensaje de SAP traducido.

**Plan B si la conexión no es viable.** El agente conserva casi todo el valor, porque lo que más tiempo consume es validar y armar los datos, no teclearlos:

- **OC lista para pegar:** el agente entrega los campos en el orden de la transacción ME21N (cabecera, posiciones, imputación) para copiarlos. La analista solo pega y graba.
- **Archivo de carga masiva:** CSV o plantilla del Migration Cockpit con las OC aptas del día, que se carga una vez al día.
- En ambos casos se mantienen la validación RC1–RC10, la evidencia, la trazabilidad y `control.csv`, incluida la medición de retroactivas. El número de OC se registra cuando SAP lo asigna.

## 7. Lectura del proceso: OC retroactivas

**El caso real (sol-005):** SOL-2026-005, papelería y tóner para el trimestre, Papelería Central Ltda., COP 3.200.000, CC-2020 / Compras.

| Hito | Fecha |
|---|---|
| Cotización PC-5520 | 2026-08-05 |
| **Factura FC-88231 emitida** | **2026-08-10** |
| Solicitud de compra | 2026-08-27 (17 días después de la factura) |
| Aprobación de rtorres | 2026-08-28: *"Aprobado. Ya llegó la factura, por favor crear la OC para poder radicarla."* |

Todo el paquete está en regla: proveedor activo, aprobadora del centro, monto dentro del tope y cotización igual a la factura. Aun así, la compra se hizo antes de pedir permiso. La aprobación de este caso no autorizó el gasto, sino que lo regularizó: la OC se usó como requisito para radicar la factura, no como control previo.

**Qué le diría a la dirección.** Las OC retroactivas no son un error de digitación. Son un síntoma de que crear la OC cuesta más que saltársela. Mientras el control llegue después de la compra, solo deja papel, y la aprobación pierde su valor de decisión porque el dinero ya está comprometido. Hoy no se puede medir. Con el agente, toda OC marcada `retroactiva=true` en `control.csv` da el porcentaje por centro de costo, proveedor y aprobador desde el primer mes.

**Cambio de proceso que propondría:**

1. **Medir 2–3 meses** antes de sancionar, con `control.csv` por centro y proveedor.
2. **"Sin OC no hay pago"** para proveedores habituales: el proveedor debe citar el número de OC en la factura y Cuentas por Pagar rechaza las que no lo traen. Las excepciones se aprueban explícitamente.
3. **OC abiertas o contratos marco** para consumos recurrentes de bajo valor como la papelería de sol-005. Una OC trimestral con entregas parciales elimina la retroactividad estructural.
4. **Bajar la fricción:** con el agente, crear la OC toma minutos. Esto ataca la causa (es lento) y no solo el síntoma.
5. La política final (tolerarlas con marca o rechazarlas) la decide la dirección, como dice el PRD. El agente ya entrega la medición para decidir con datos.

## 8. Decisiones y trade-offs

| # | Decisión | Alternativa descartada | Por qué |
|---|---|---|---|
| 1 | **Ciclo del agente propio** sobre una interfaz `ProveedorLLM` mínima. | Vercel AI SDK, LangChain o el tool runner del SDK. | Necesito meter el doble seguro de CA3, los topes y el log justo entre "el modelo pidió una herramienta" y "la ejecuto". Con un bucle propio de unas 150 líneas el control es explícito, y cambiar de proveedor solo toca `src/llm/`. |
| 2 | **Las herramientas releen el caso y revalidan.** `paquete`, `derivados` y `payload` se aceptan por contrato pero se ignoran. | Pasar el paquete o el payload entre herramientas, como sugiere la firma del PRD. | El modelo no puede alterar un monto ni saltarse una regla aunque lo intente (riesgo de la sección 10 del PRD). También ahorra tokens, porque el modelo solo envía `caso`. El costo es releer los archivos en cada llamada, despreciable aquí. |
| 3 | **Reglas como funciones puras**, una por regla, más `evaluar()`. | Validar dentro de las herramientas o pedirle al modelo que valide. | Son deterministas y testeables sin I/O. `demo.ts` las verifica sin modelo, y un cambio de regla no toca el servidor. |
| 4 | **Parsers con regex** para la cotización y la factura. | Extraer los campos con el LLM. | Los formatos son fijos, la extracción es determinista y gratis, y funciona en `demo.ts` sin key. Si el formato cambia, la herramienta devuelve un error legible en vez de inventar un dato. Ante PDFs heterogéneos reales habría que reconsiderarlo. |
| 5 | **Conocimiento concatenado al system prompt.** | Una herramienta `consultar_conocimiento`. | El documento ocupa ≈ 1.200 tokens y se usa en cada caso. Incluirlo (y cachearlo) es más barato y fiable que una llamada extra. Si crece, se migra a herramienta o skill. |
| 6 | **Front en HTML + JS plano** servido por el mismo servidor. | React o Svelte con un bundler. | Un solo proceso, cero build y despliegue trivial. La interfaz es pequeña y el markdown se renderiza con un parser mínimo que escapa todo antes de dar formato. |
| 7 | **Sesiones en memoria.** | Persistirlas en archivos. | El PRD lo permite y no hay multiusuario. El costo es perder las sesiones al reiniciar; las OC, el log y `control.csv` sí persisten en `OUT_DIR`. |
| 8 | **Módulo (bonus) generado desde las fuentes de la app.** `tools/oc.ts` reexporta y `agent.md`/`SKILL.md` se regeneran con un script que también verifica. | Copiar los archivos a `modulo/`, o hacer que la app lea desde `modulo/`. | Una copia diverge con el primer cambio. Invertir la fuente rompería la estructura que pide el PRD (`agent/prompt.md`, `src/knowledge/`). Con generación y un chequeo que falla, hay una sola fuente de verdad y la divergencia se detecta. |

## 9. Supuestos

**Aprobados antes de construir:**

1. RC9 compara fechas por día calendario: una aprobación del mismo día que la solicitud es válida (sol-004).
2. Si la descripción supera 40 caracteres, se trunca para SAP y queda registrada como derivado en `trazabilidad.json`. No bloquea.
3. Unidad `H` si la descripción menciona horas; `UN` en los demás casos.
4. En RC5, si el humano confirma, la OC sale con los valores de la **solicitud** y la diferencia queda en `excepciones`. El modelo nunca ajusta montos.
5. Precios y totales se tratan como IVA incluido, igual que la cotización.
6. RC1 sin NIT busca por nombre normalizado: minúsculas, sin tildes, sin puntuación y sin sufijos S.A.S., S.A. o Ltda.
7. RC3 solo se evalúa si el aprobador está listado en el centro (si no, ya bloquea RC2). Aun así, la acción sugerida indica si algún aprobador del centro tiene tope suficiente.

**Tomados durante la implementación:**

8. `correo.json` y `solicitud.json` son obligatorios: sin ellos, `oc_leer_paquete` devuelve error. La cotización y la aprobación son adjuntos: si faltan, quedan en `null` con un aviso. La factura solo genera aviso si el correo la lista como adjunto.
9. `validez_hasta` se calcula como fecha de la cotización más los días de validez ("30 días").
10. "Aprobado" cuenta como aprobación salvo que aparezca precedido de "no".
11. RC1 usa el NIT de la **solicitud**. El NIT de la cotización se extrae, pero no se usa para buscar.
12. `trazabilidad.json` usa, además de `solicitud`, `cotizacion`, `maestro.<nombre>` y `derivado`, las fuentes `correo` y `aprobacion`. Así el id del correo y el email del aprobador tienen un origen exacto.
13. La respuesta idempotente de `oc_crear` trae `fecha: null`, porque `buscarOrdenPorReferencia` de la interfaz `SapAdapter` (7.4) solo devuelve `numero_oc`.
14. `control.csv` usa además el resultado `error` (caso ilegible) y `idempotente`, además de creada, bloqueada y pendiente.
15. Una confirmación pendiente dura solo hasta el siguiente mensaje del usuario. Si el usuario cambia de tema, el agente debe volver a validar y preguntar.
16. El demo no confirma sol-005 ni sol-006: quedan pendientes para mostrar que no se crean sin confirmación. Solo confirma sol-004, como pide el PRD.

## 10. Cobertura

| Historia / requisito | Estado | Notas |
|---|---|---|
| HU-1 Leer el paquete | Hecho | Normalización 7.2, adjuntos ausentes → `null` + aviso. |
| HU-2 Validar | Hecho | RC1–RC10 puras, `derivados` y `retroactiva`. |
| HU-3 Construir payload | Hecho | Esquema zod `OrdenCompra` + `trazabilidad.json`. |
| HU-4 Evidencia | Hecho | P0 `.txt` + sha256 y P1 `.pdf`. |
| HU-5 Crear OC | Hecho | Revalida, idempotente, `control.csv`, numeración desde 4500000001. |
| HU-6 Errores | Hecho | JSON malformado, monto no numérico y caso inexistente → `{ ok:false, error }` legible. |
| CA1–CA5 | Hecho | CA3 con doble seguro probado con un modelo falso de guion fijo. |
| Front | Hecho | Tarjetas de herramientas, resaltado de confirmación, botones, responsive. |
| `demo.ts` | Hecho | Compara contra lo esperado y sale con código 1 si difiere. |
| Prueba punta a punta con el modelo | Hecho | Con `claude-opus-5-5`: sol-001 se creó sin intervención humana (OC 4500000001, 5 herramientas, ≈ 10 s). sol-004, con el prompt de la sección 11 del PRD, mostró la tabla y RC5 con ambos valores y cerró el turno preguntando; tras "Confirmo" creó la OC 4500000002 con la excepción registrada. |
| Link público | Hecho | https://reto-03-agente-oc.onrender.com, desplegado en Render (Bun 1.4.4, `OUT_DIR=/tmp/out`). `/api/health`, el front y el manejo de errores del chat están verificados en el link. |
| `oc_leer_excel` (P1) | No hecho | Opcional. |
| Bonus `modulo/` (9.4) | Hecho | `agent.md` y `SKILL.md` se generan desde las fuentes de la app. `tools/oc.ts` reexporta los mismos objetos. `bun run modulo:check` falla si hay divergencia. |

**Qué falta para producción:**
- Adaptador SAP real (sección 6) con sus pruebas de integración.
- Autenticación de usuarios y registro de quién confirma (hoy `confirmado_por` es "analista (sesión …)").
- Sesiones persistentes.
- Lectura de `.xlsx` y PDF reales.
- Maestros consultados en SAP en tiempo real, en vez de JSON.
- Pruebas unitarias por regla.
- Monitoreo de costo por sesión.

## 11. Uso de IA

| Asistente | Para qué lo usé | Qué descarté o corregí de lo que propuso, y por qué |
|---|---|---|
| Claude Code (modelo Claude Opus 5.5), dentro de VS Code | Construcción por fases que yo revisaba antes de aprobar la siguiente: (1) herramientas, reglas RC1–RC10, SAP simulado y `demo.ts`; (2) adaptador LLM, ciclo del agente, servidor, prompt, conocimiento y front; (3) README y SOLUCION.md; (4) deploy en Render; además, el módulo bonus. También lo usé para preparar el repositorio y resolver el error de certificado SSL al conectar Git con GitHub. | Agregaba "Co-Authored-By: Claude" en los commits; lo rechacé y se reescribió la historia para que los commits quedaran solo a mi nombre. Iba a publicar `PRD.md` en el repositorio; lo excluí porque el repo es público y es un documento del proceso de selección. Propuso cambios de diseño que revisé uno a uno antes de aceptarlos: fuentes adicionales en la trazabilidad, herramientas que releen el caso en vez de confiar en el payload del modelo, esfuerzo `medium` y reintento automático en otro modelo. |

**Cómo trabajé con la IA y cómo verifiqué lo que generó.** Leí y fui auditando fase a fase lo que hacía. Al inicio le pedí un plan de máximo 10 líneas y no le dejé escribir código hasta aprobarlo. Al final de cada fase revisé el código y la salida antes de autorizar la siguiente. Además de esa lectura, verifiqué con evidencia ejecutable:

- `bun run demo` contra el resultado esperado que definí para los 6 casos; sale con código 1 si algo difiere.
- `tsc` en modo estricto, sin `any`.
- El doble seguro de confirmación (CA3), probado con un modelo simulado que sigue un guion fijo: bloquea crear sin pregunta previa, tras un "No confirmo" y para un caso distinto del preguntado; con "Confirmo" crea la OC.
- El servidor arrancado sin API key y con una key sin créditos, para comprobar que el chat muestra un error claro y la sesión no se cae.
- `bun run modulo:check`, que comprueba que el módulo bonus no diverge de la aplicación.
- El link de Render: `/api/health`, el front, el chat y que la key no aparezca en ninguna respuesta.

**Decisiones que tomé yo, no la IA:**

- El stack: Bun + TypeScript estricto, Hono, HTML plano y el SDK de Anthropic detrás de un adaptador propio. También prohibí Vercel AI SDK, LangChain y frameworks de agentes, para que el ciclo del agente fuera propio y pudiera explicarlo.
- La estructura obligatoria del repositorio y el contrato de las herramientas.
- Los 7 supuestos de interpretación del PRD (sección 9) y el resultado esperado por caso, que usé como criterio de aceptación en `demo.ts`.
- El doble seguro de confirmación: además del prompt, un control en el backend.
- Trabajar por fases con revisión obligatoria entre cada una.
- Que la API key nunca estuviera en el repositorio y que los commits figuraran solo a mi nombre.
- Hacer el bonus del módulo reutilizable.

## 12. Riesgos de llevar esto a producción

| Riesgo | Impacto | Mitigación |
|---|---|---|
| El modelo afirma un valor que no salió de una herramienta. | OC revisada con datos falsos. | Las herramientas reconstruyen la OC por su cuenta y el modelo no puede crear con valores propios. A futuro: validar que los montos de la respuesta coincidan con los del resultado de la herramienta antes de mostrarla. |
| Confirmación ambigua ("sí, pero…"). | Crear una OC que el humano no quería. | La lista de palabras es cerrada y se rechaza cualquier "no". Con usuarios autenticados, firmar la confirmación con la identidad de la persona. |
| Prompt injection en los adjuntos (texto malicioso en una cotización). | El modelo intenta actuar fuera del flujo. | Las herramientas no ejecutan shell ni escriben fuera de `OUT_DIR`, `caso` se valida contra una lista blanca de caracteres y crear exige revalidación y doble seguro. |
| Conexión SAP no viable a corto plazo. | No se elimina la digitación. | Plan B de la sección 6 (OC lista para pegar o carga masiva). |
| Maestros desactualizados (JSON vs SAP). | Aprobar con un tope viejo o un proveedor inactivo. | Consultar SAP en línea (`consultarProveedor`) y cachear con vencimiento corto. |
| Costo descontrolado del LLM. | Gasto inesperado. | Topes por turno y por sesión ya implementados. A futuro: límite por IP o usuario, alertas de gasto y medición real del costo por caso. |
| Exposición de la API key. | Uso fraudulento de la cuenta. | La key vive solo en el entorno del backend y se tapa en mensajes. A futuro: gestor de secretos y rotación periódica. |
| Concurrencia y reinicios (sesiones en memoria, numeración del mock). | Pérdida de conversaciones; OC duplicadas en el mock. | Candado por sesión ya implementado. En producción: sesiones persistentes y la numeración e idempotencia que da SAP. |
| Datos personales en logs (correos, nombres). | Incumplimiento de protección de datos. | Política de retención de `log.jsonl` y enmascaramiento de correos en logs de producción. |
