# Phase 3 — Realtime Engine

## Objetivo

Preparar la infraestructura interna para interacciones asíncronas, eventos correlacionados, streaming, cancelación, cleanup y concurrencia controlada, sin implementar voz, UI ni un agente autónomo.

## Alcance

- `EventBus` tipado en memoria.
- `RealtimeEngine` y `InteractionHandle`.
- Máquina de estados explícita: `created`, `running`, `streaming`, `cancelling`, `completed`, `cancelled`, `failed`.
- `InteractionScheduler` con máximo configurable de una interacción por sesión y cuatro globales por defecto.
- Rechazo inmediato al superar límites; no hay cola.
- `InteractionStream` acotado a 64 eventos por defecto y backpressure explícito.
- Envelopes con `eventId`, `interactionId`, `correlationId`, `sequence`, `occurredAt`, `type` y `payload`.
- Cancelación con `AbortSignal`, timeout y cleanup de timers, listeners, subscriptions y streams.
- `AssistantCoreAdapter`, `ToolManagerAdapter` y `MockInteractionSource`.
- Errores tipados y logging seguro.
- Tests deterministas sin APIs externas ni procesos del sistema.

## Fuera de alcance

No se implementan STT, faster-whisper, TTS, Edge-TTS, RVC, wake word, avatar, Electron, Vue, Live2D, VTube Studio, Spotify, YouTube, navegador, Computer Use, memoria persistente, RAG, MCP, plugins, automatizaciones, agente autónomo, herramientas reales del sistema, shell, PowerShell, CMD, `child_process`, `exec`, `spawn` ni streaming real de proveedores externos.

Tampoco se modifica `DirectAIProvider`, se rehace `AssistantCore` o se convierte el runtime en un ciclo modelo → herramienta → modelo.

## Arquitectura

`RealtimeEngine` es dueño del ciclo de vida de una interacción. `AssistantCoreAdapter` conserva la responsabilidad conversacional del core. `ToolManagerAdapter` conserva la autorización y ejecución de Phase 2; sus eventos son observabilidad y no activan ciclos autónomos.

El engine publica envelopes al `EventBus` y al stream individual. La secuencia es estrictamente monotónica por interacción. Las interacciones concurrentes pueden intercalarse globalmente, pero cada interacción conserva su orden.

La cancelación es idempotente y cooperativa. Cada interacción tiene su propio controller; el signal se propaga a los adapters. El timeout se distingue de la cancelación del llamador. Todo recurso temporal se limpia en `finally`.

## Eventos

Se emiten `interaction_admitted`, `interaction_started`, `state_changed`, `text_delta`, `tool_started`, `tool_completed`, `interaction_completed`, `interaction_cancelled` e `interaction_failed`.

`admitted` es únicamente un evento. Los únicos estados terminales son `completed`, `cancelled` y `failed`, y cada interacción llega como máximo una vez a uno de ellos.

## Seguridad

- No hay APIs de ejecución de procesos ni shell en el runtime.
- El texto de una fuente nunca se interpreta como comando.
- Los errores internos se normalizan y no exponen causas.
- El logging usa IDs, estado y códigos; no registra prompts, argumentos ni secretos.
- Los eventos de tools no otorgan permisos ni bypasses de autorización.

## Pruebas

La suite cubre publicación, suscripción, desuscripción, cleanup, IDs, secuencia, estados, admisión, finalización, cancelación previa y durante streaming, timeout, errores de source, errores de tools, concurrencia global y por sesión, múltiples deltas, cierre único, backpressure y rechazo de texto arbitrario como operación del sistema. También ejecuta la regresión completa de Phase 1 y Phase 2.

## Criterios de aceptación

- EventBus, runtime, handle, scheduler, stream y máquina de estados implementados.
- Correlación, IDs y secuencia monotónica verificables.
- Cancelación, timeout y cleanup cubiertos por tests.
- Concurrencia limitada y rechazo determinista.
- Adapters y mock source implementados.
- Errores tipados y logging seguro.
- Sin shell, procesos, herramientas reales ni agente autónomo.
- Sin streaming real de proveedores externos.
- Regresiones de Phase 1 y Phase 2 pasando.
- Build, lint, typecheck, test, `npm run check` y `git diff --check` pasando.

## Definition of Done

- Documentación y ADR actualizados.
- Auditoría de seguridad y alcance realizada.
- Rama limpia y publicada.
- Commit final identificable.
- No se crea PR automáticamente, no se hace merge a `main` y no se inicia Phase 4.
