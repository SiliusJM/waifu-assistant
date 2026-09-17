# ADR-001: AIProvider y OmniRoute opcional

- Estado: aceptado como límite arquitectónico de Phase 0; selección de proveedor pendiente.
- Fecha: 2026-09-17.

## Contexto

El asistente necesitará conversación y, más adelante, selección de modelos y fallback. La especificación exige evaluar OmniRoute, pero también exige mantener las tecnologías candidatas reversibles y excluir los fast paths deterministas de un gateway LLM.

La documentación oficial consultada de OmniRoute describe un gateway autoalojable y compatible con la API de OpenAI, con modelos auto, estrategias de routing, fallback, circuit breakers, afinidad de sesión/caché, compresión y señales de decisión de ruta:

- https://github.com/diegosouzapw/OmniRoute
- https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.51/docs/routing/AUTO-COMBO.md
- https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.51/docs/architecture/RESILIENCE_GUIDE.md
- https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.51/docs/comparison/OMNIROUTE_VS_ALTERNATIVES.md

Estas capacidades son afirmaciones del proyecto y deberán verificarse con un prototipo controlado antes de adoptar una versión.

## Decisión

El core dependerá conceptualmente de un contrato AIProvider, nunca de un SDK o gateway concreto.

OmniRoute queda como adaptador opcional y desactivado por defecto. Si se evalúa con éxito, solo podrá intervenir en solicitudes que ya hayan sido clasificadas como dependientes de AI. Los comandos deterministas se ejecutarán mediante herramientas locales explícitas, sin pasar por OmniRoute.

El adaptador deberá poder registrar:

- proveedor y modelo efectivo;
- latencia hasta primer token;
- latencia total;
- errores, timeout y fallback;
- uso de tokens y coste cuando el proveedor lo exponga;
- hit/miss de caché cuando sea verificable;
- versión y configuración del gateway.

No se delegarán al gateway los permisos, la allowlist, la validación de argumentos, la política de datos ni la verificación de resultados.

## Alternativas comparadas

### Proveedor directo a un modelo

Ventajas: menor complejidad y posible menor latencia. Desventajas: fallback, cambio de proveedor, observabilidad y políticas de selección deben implementarse en el proyecto.

### OmniRoute hacia un único modelo

Ventajas: endpoint estable, normalización y posible observabilidad. Desventajas: añade un proceso y un salto de red local; no aporta el beneficio completo del routing.

### OmniRoute con routing rápido o automático

Ventajas: selección basada en latencia, capacidad, salud, coste u otros factores; puede reducir coste o mejorar disponibilidad. Desventajas: comportamiento menos determinista, posibles incompatibilidades de capacidades y necesidad de inspeccionar qué contexto sale hacia cada proveedor.

### OmniRoute con fallback multi-modelo

Ventajas: tolerancia a rate limits y errores, circuit breaker y continuidad operativa. Desventajas: un modelo alternativo puede tener distinta calidad, contexto, tool calling, política de datos o precio; repetir una solicitud puede tener efectos en coste y latencia.

### Gateway alternativo o implementación propia

Una capa propia ofrece control fino pero aumenta el coste de mantenimiento. LiteLLM y servicios gestionados siguen siendo candidatos para comparar cuando Phase 1 tenga un caso de uso real.

## Evaluación propuesta

No se instala en Phase 0. En Phase 1 se preparará una prueba con solicitudes sintéticas y proveedores autorizados, sin secretos en fixtures:

1. Direct provider → model.
2. OmniRoute → single model.
3. OmniRoute → auto/fast o equivalente.
4. OmniRoute → multi-model fallback.

Se compararán p50, p95, primer token, inicio de tool call, latencia total, errores, consistencia de tool calls, tokens, coste, cache behavior y complejidad operativa. La compresión se probará separadamente con un conjunto de casos donde pueda medirse fidelidad, no se habilitará por defecto por la sola promesa de ahorro.

## Consecuencias

La arquitectura queda preparada para adoptar o retirar OmniRoute sin reescribir Assistant Core. Phase 0 no obtiene resiliencia real de proveedores todavía. Habrá que mantener una matriz de capacidades y políticas por proveedor antes de permitir fallback automático.
