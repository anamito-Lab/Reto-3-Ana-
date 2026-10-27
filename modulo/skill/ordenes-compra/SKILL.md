---
name: ordenes-compra
description: Conocimiento del proceso de órdenes de compra de Periferia (cómo llega una compra, maestros, reglas RC1–RC10, convenciones SAP y qué pedir al solicitante). Úsala al procesar o explicar una solicitud de OC.
---

# Proceso de órdenes de compra en Periferia

## Cómo llega una compra

Cada compra llega a administración por correo con tres piezas:

- **Solicitud** (Excel `solicitud.xlsx`, normalizado como `solicitud.json`): proveedor, NIT, descripción, centro de costo, subárea, cantidad, valor unitario, valor total, moneda, indicador de IVA, condiciones de pago y fecha.
- **Cotización** del proveedor (`cotizacion.pdf`, normalizada como `cotizacion.txt`): proveedor, NIT, ítems, base gravable, IVA, total (IVA incluido) y validez de la oferta.
- **Aprobación** del líder (`aprobacion.eml`, normalizado como `aprobacion.json`): el líder responde "Aprobado".
- A veces llega también una **factura** (`factura.txt`). Si su fecha es anterior a la solicitud, la compra ya ocurrió: la OC es **retroactiva**.

Los casos están en `fixtures/reto-03/solicitudes/<caso>/` (por ejemplo `sol-001` a `sol-006`).

## Maestros

| Maestro | Para qué sirve |
|---|---|
| Proveedores | Código SAP, NIT, condiciones de pago e indicador de IVA por defecto, si está activo. |
| Centros de costo | Subáreas válidas y aprobadores con su tope de aprobación. |
| Indicadores de IVA | C0 excluido, C1 IVA 19 %, C2 IVA 5 %. |
| Condiciones de pago | Z000 inmediato, Z015, Z030, Z060 días fecha factura. |

## Reglas de control

| Regla | Qué verifica | Efecto |
|---|---|---|
| RC1 | El proveedor existe (por NIT; sin NIT, por nombre normalizado) y está activo. | Bloqueo |
| RC2 | Hay aprobación, dice "Aprobado" y la envió un aprobador del centro de costo. | Bloqueo |
| RC3 | El valor total no supera el tope del aprobador en ese centro. | Bloqueo |
| RC4 | La subárea pertenece al centro de costo. | Bloqueo |
| RC5 | Cotización y solicitud no difieren más de 2 %; sin cotización también se confirma. | Confirmación |
| RC6 | Sin indicador de IVA se toma el del proveedor. | Confirmación + derivado |
| RC7 | Sin condiciones de pago se toman las del proveedor. | Derivado (solo se informa) |
| RC8 | Factura con fecha anterior a la solicitud: OC retroactiva. | Confirmación |
| RC9 | La aprobación no es anterior a la solicitud (se compara el día). | Confirmación |
| RC10 | Cantidad × valor unitario = valor total (± 1). | Bloqueo |

- **Bloqueo**: la OC no se crea. Se devuelve al humano con la acción sugerida.
- **Confirmación**: la OC solo se crea si la analista confirma explícitamente.
- **Derivado**: valor completado desde un maestro; siempre se informa su fuente.

## Convenciones de la OC en SAP

- Sociedad y organización de compras: `1000`.
- Posiciones numeradas 10, 20, 30…
- La descripción de la posición (texto breve) tiene máximo 40 caracteres: si la solicitud trae más, se trunca y se registra en la trazabilidad.
- Unidad: `H` si la descripción habla de horas; `UN` en los demás casos.
- Precios y totales con IVA incluido, igual que la cotización.
- Si se confirma una diferencia de cotización (RC5), la OC sale con los valores de la **solicitud** y la diferencia queda en `excepciones`.
- La evidencia de aprobación (`aprobacion.txt` con su sha256 y `aprobacion.pdf`) se adjunta a la OC; el sha256 queda en `aprobador.evidencia_sha256`.
- Crear dos veces la misma solicitud devuelve el número existente (idempotencia).

## Qué pedir al solicitante según el problema

| Problema | Qué pedir |
|---|---|
| Proveedor inexistente (RC1) | NIT correcto o creación del proveedor en SAP (RUT y certificación bancaria). |
| Proveedor inactivo (RC1) | Reactivación en datos maestros o cambio de proveedor. |
| Aprobador no autorizado o sin tope (RC2/RC3) | Aprobación de un aprobador del centro con tope suficiente; si ninguno alcanza, escalar. |
| Subárea inválida (RC4) | Corregir la subárea según las válidas del centro. |
| Cotización distinta (RC5) | Confirmar el valor de la solicitud o una solicitud y aprobación ajustadas. |
| Cálculo inconsistente (RC10) | Corregir cantidad, valor unitario o total. |
| Adjunto faltante o ilegible | Reenviar el archivo faltante. |

## Por qué importan las OC retroactivas

La dirección quiere medir cuántas OC se crean después de recibir la factura (saltándose la cotización). Toda OC retroactiva queda con `retroactiva=true` en `out/control.csv`, que consume Contabilidad / Auditoría.
