# ADR-005: Realtime Engine de Phase 3

- Estado: aceptado para Phase 3.
- Fecha: 2026-09-17.

## Contexto

Phase 1 ya define `AIProvider.stream()` y cancelación. Phase 2 define ejecución cooperativa de herramientas. Todavía no existe un coordinador de interacciones, un bus de eventos, una política de concurrencia ni una cola de streaming con cleanup verificable.

## Decisión

Phase 3 introduce un runtime en memoria compuesto por `EventBus`, `RealtimeEngine`, `InteractionScheduler`, `InteractionStream`, una máquina de estados explícita y adaptadores para `AssistantCore` y `ToolManager`.

Cada interacción recibe un `interactionId`, un `correlationId`, un `AbortController` y una secuencia monotónica. El estado `admitted` no existe como estado persistente; la admisión se representa con `interaction_admitted`.

El scheduler permite por defecto una interacción por sesión y cuatro globales. Los límites son configurables y el exceso se rechaza inmediatamente; no existe cola en esta fase.

Cada interacción tiene un stream acotado de 64 eventos. Cuando se llena, el productor espera al consumidor. Una cancelación desbloquea productores pendientes de forma explícita; no se descartan eventos silenciosamente.

El runtime no implementa streaming real de proveedores externos ni un ciclo autónomo modelo-herramienta-modelo. Los mocks y adaptadores validan la infraestructura; los eventos de herramientas son observabilidad de ejecuciones explícitas.

## Consecuencias

- La infraestructura de tiempo real queda desacoplada de voz, UI y proveedores concretos.
- La concurrencia y el orden son deterministas por interacción.
- La cancelación es cooperativa y depende de que adapters, providers y tools respeten `AbortSignal`.
- Un streaming real de proveedor requerirá una fase o decisión posterior.
- No se añaden dependencias externas ni APIs de procesos.
