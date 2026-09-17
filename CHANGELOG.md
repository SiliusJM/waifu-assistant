# Changelog

Todos los cambios relevantes del proyecto se documentarán aquí.

## [Unreleased]

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
