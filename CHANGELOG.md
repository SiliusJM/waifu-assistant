# Changelog

## [Unreleased] — Phase 8 definition

### Added

- Definicion arquitectonica de `WebSearchProvider`, `WebFetchProvider` y `BrowserProvider` con responsabilidades separadas.
- Contratos conceptuales para lifecycle de sesion/pagina, navegacion, permisos, contenido web no confiable, prompt injection, cancelacion y concurrencia acotada.
- ADR-011 y documentacion de seguridad para URLs, redirects, cookies, credenciales, downloads, uploads y acciones irreversibles.

### Security

- Phase 8 permanece sin providers reales, browser automation, dependencias, UI, persistencia, credenciales, shell, APIs de procesos o codigo de produccion.
- La aprobacion de una accion futura debera pasar por `ToolManager`; una pagina web nunca concede autoridad ni puede convertir sus instrucciones en permisos.

### Status

- Definicion documental en `phase/08-internet-browser`; no implementada, no mergeada a `main` y sin PR abierto.

## Phase 6 - Personality System

### Added

- Perfiles declarativos con identidad, traits, tono, speaking style, reglas tipadas, límites expresivos y política de locale.
- `PersonalityValidator`, catálogo controlado, `PersonalityPolicy`, compilador determinista, snapshots inmutables y fingerprint.
- Registro multi-perfil en memoria, JSON canónico validado y eventos de lifecycle limitados.
- Integración opcional de snapshots por interacción en `AssistantCore`, sin contaminar `Session`.
- Tests deterministas y regresión completa sin red, credenciales, hardware ni providers reales.

### Security

- Sin `systemPrompt` libre, ejecución dinámica, APIs de procesos, shell, permisos, tools, memoria persistente, voz real o LLM real.
- Logs limitados a identificadores, versiones, fingerprint y conteos; no incluyen prompts completos, historial, preferencias privadas ni secretos.

### Status

- Phase 6 revisada, corregida y mergeada a `main` mediante PR #6.

### Fixed

- Registro de personalidad protegido con copia defensiva y deep-freeze en todos sus accesores.
- Preference overrides normalizados y validados en runtime con fallback seguro.
- `identity.description` conservado como metadata del snapshot, sin compilarse como instrucción normativa.

### Status

- Phase 7 definida, implementada, revisada y mergeada mediante PR #8; merge commit `417a30deca884f55057164475b08b2521d47347d`. Suite final: 98/98 tests.

Todos los cambios relevantes del proyecto se documentarán aquí.

## Phase 7 — Avatar System implementation

### Status

- PR #8 revisado y mergeado a `main`; Phase 7 cerrada.

### Added

- `AvatarController` y `AvatarSignalNormalizer` con estados visuales controlados, snapshots inmutables, `baseState`, correlación y secuencia global.
- `AvatarRuntime`, lifecycle técnico, eventos acotados, capabilities, policy cerrada, `AvatarProvider` abstracto y `MockAvatarProvider`.
- Coordinación latest-wins con una sola presentación activa y como máximo un snapshot pendiente, incluyendo providers interrumpibles y no interrumpibles.
- Suite determinista de Phase 7; verificación final: 98/98 tests, incluyendo hardening de validación runtime de señales y capabilities.

### Security

- Sin renderer, UI, assets reales, persistencia, URLs arbitrarias, filesystem de producción, shell, PowerShell, CMD, `child_process`, `exec` o `spawn`.

## [Unreleased]

### Phase 7 - Avatar System definition

- Añadida definición arquitectónica documental para una capa de presentación desacoplada.
- Definición revisada, corregida y aprobada mediante PR #7; merge commit `c30ccd3bff298c37cc1dd12a01ec775074b83b02`.
- No se añadieron código de producción, dependencias de renderizado, providers, assets, UI ni cambios funcionales.

### Added

- Fundamentos de repositorio y gobierno del proyecto.
- Esqueleto mínimo Node.js ESM con ciclo de vida de aplicación.
- Logger estructurado con redacción de claves sensibles.
- Build, validación de sintaxis y pruebas usando únicamente capacidades de Node.js.
- Documentación de descubrimiento, arquitectura, seguridad, contribución y Phase 0.

### Decisions

- Los proveedores de IA y OmniRoute no se integran en Phase 0.
- OmniRoute queda como adaptador opcional detrás de una abstracción AIProvider y fuera de las rutas deterministas.

## Phase 1 — Assistant Core

### Added

- Toolchain TypeScript estricto con build, lint, typecheck y lockfile reproducible.
- Session, Message, Context, Response y AssistantCore con responsabilidades separadas.
- AIProvider preparado para complete, stream y AbortSignal.
- MockAIProvider y DirectAIProvider HTTP configurable.
- Errores categorizados, timeout y retry explícito.
- Tests unitarios y de integración HTTP sin credenciales ni proveedores externos.

### Security

- Logging sin prompts completos ni credenciales.
- OmniRoute no instalado, no obligatorio y desactivado por defecto.

## Phase 2 — Tool System

### Added

- Contrato tipado de herramientas, registro, manager, validación declarativa y autorización explícita.
- Contexto de ejecución, resultados discriminados, errores específicos y cancelación cooperativa.
- Tests de seguridad que rechazan texto no validado como herramienta o comando del sistema.

### Security

- Phase 2 no importa `child_process` ni implementa `exec`, `spawn`, PowerShell, CMD o shell arbitrario.

### Status

- PR #2 revisado y mergeado a `main`; Phase 2 cerrada.

## Phase 3 — Realtime Engine

### Added

- EventBus, RealtimeEngine, InteractionHandle, scheduler, stream acotado y máquina de estados.
- Correlación, secuencia monotónica, cancelación, timeout, cleanup y adapters para el core y tools.
- MockInteractionSource y tests deterministas de streaming y concurrencia.

### Security

- Phase 3 no implementa procesos, shell, herramientas reales del sistema, streaming externo ni agente autónomo.

### Fixed

- DirectAIProvider acepta respuestas de tool calling sin contenido textual.
- Añadidas pruebas de streaming, cancelación durante backoff y clasificación de retries HTTP.
- Documentado y probado el límite de `Retry-After` mediante `maxDelayMs`.
- Corregida la carrera de terminalización del `RealtimeEngine`, garantizando que el resultado terminal se reserve antes de publicar el evento terminal y evitando finales contradictorios.

### Status

- PR #3 revisado, corregido y mergeado a `main` en `7cfe8144536ca1d95c462c3f803d35f5950c0f73`.
- Phase 3 cerrada después de regresión completa y verificación local.

## Phase 4 — Voice Service

### Added

- Contratos desacoplados de audio, captura, salida, STT y TTS.
- `VoiceSession`, `VoiceService`, `VoiceEventMap`, errores tipados y mocks deterministas.
- Cancelación cooperativa, timeout por etapa, cleanup explícito y correlación con `RealtimeEngine`.

### Security

- Audio en memoria por defecto y sin logging de audio o transcripciones completas.
- Sin proveedores reales, procesos, shell ni flujo autónomo STT → LLM → Tool → TTS.

### Status

- Implementación en `phase/04-voice-service`; ADR-007 de selección de proveedores permanece abierto.

## Phase 5 — Streaming Voice & Interruptions

### Added

- Streaming coexistente con el modo batch de Phase 4 para captura, STT, TTS y playback.
- Queues acotadas, backpressure, coordinación por sesión/dispositivo, interruption, supersede y cancelación jerárquica.
- Eventos de control correlacionados, métricas monotónicas, mocks deterministas y cleanup de recursos.

### Security

- Sin audio persistente, logs de contenido completo, providers reales, LLM real, procesos o shell.

### Status

- Implementación revisada y corregida en `phase/05-streaming-voice`; PR #5 mergeado a `main` en `1f076df8e880c273abe261142aab9757c541d73e`. Verificación de cierre: 72/72 tests, build/lint/typecheck/check/diff-check OK.


## Phase 6 — Personality System

### Added

- Personalidad declarativa con identidad, traits catalogados, tono, estilo, reglas, límites y locale.
- Validator estricto, policy/compiler determinista, snapshots inmutables y fingerprint.
- Registry multi-perfil en memoria, JSON canónico e integración opcional con `AssistantCore`.

### Security

- Sin `systemPrompt` libre, APIs de procesos/shell, autoridad sobre tools/permisos, memoria persistente, providers de voz o LLM real.

### Status

- Implementación revisada y corregida en `phase/06-personality-system`; PR #6 mergeado a `main` en `532c956e2a407b9e9e540584947a24739490bb03`. Verificación de cierre: 83/83 tests, build/lint/typecheck/check/diff-check OK.
