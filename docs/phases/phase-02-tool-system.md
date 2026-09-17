# Phase 2 — Tool System

## Objetivo

Construir la infraestructura tipada y segura que permita registrar y ejecutar herramientas explícitas mediante un perímetro de validación y autorización.

## Alcance

- Contrato genérico `Tool<Arguments, Result>` con riesgo, esquema y cancelación.
- `ToolRegistry` para registrar, consultar, listar y desregistrar herramientas.
- `ToolManager` para validación, disponibilidad, autorización, ejecución, normalización, logging y cancelación.
- Validación declarativa propia, sin dependencia externa.
- Autorización explícita mediante `ToolAuthorizer`.
- Contexto de ejecución con `AbortSignal`, metadata, sesión, correlation ID, autorización y logger.
- Resultados discriminados como `success`, `failure` e `internal_error`.
- Errores categorizados específicos del sistema de herramientas.
- Tests unitarios de contrato, validación, permisos, ejecución, cancelación y seguridad.

## Fuera de alcance

No se implementan shell, `child_process`, `exec`, `spawn`, PowerShell, CMD, scripts, código generado, herramientas del sistema, Spotify, YouTube, navegador, volumen real, apertura arbitraria de aplicaciones, Computer Use, STT, TTS, avatar, Electron/Vue, wake word, memoria persistente, RAG, MCP, automatizaciones, agente autónomo ni la cadena completa modelo-herramienta-modelo.

No se integra todavía el flujo de `tool_calls` de `AssistantCore`; el manager puede probarse de forma independiente sin convertir el core en un agente.

## Arquitectura

`ToolRegistry` administra qué herramientas existen. `ToolManager` administra cómo se valida y ejecuta una herramienta. El modelo no obtiene acceso a ninguna capacidad por texto libre: una llamada sólo puede resolver un ID registrado, superar el esquema, estar disponible y recibir autorización explícita.

El manager crea un contexto de ejecución con una señal enlazada a la señal del llamador y, opcionalmente, a un timeout. La cancelación es cooperativa: la herramienta debe observar `context.signal`. Los resultados controlados se devuelven con un discriminante estable; excepciones inesperadas no exponen sus detalles.

## Seguridad

- No hay imports de `node:child_process` ni APIs de shell.
- Los argumentos se validan antes de autorización y ejecución.
- La autorización no se infiere del nombre o riesgo de la herramienta.
- El logging registra IDs, riesgo, correlation ID, estado y códigos, nunca argumentos completos ni secretos.
- Los errores internos se normalizan a un mensaje seguro.

## Pruebas

Los tests usan herramientas deterministas definidas en memoria. Cubren registro válido, duplicados, consulta, listado, desregistro, argumentos válidos e inválidos, autorización, disponibilidad, resultado controlado, error inesperado, cancelación, timeout, propagación de contexto y rechazo de texto que intenta representar un comando del sistema. No se lanzan procesos ni se hacen llamadas externas.

## Criterios de aceptación

- Existe el contrato formal de `Tool`.
- Existe `ToolRegistry` separado de `ToolManager`.
- Existe validación estructurada de argumentos.
- Existe autorización explícita y niveles de riesgo.
- Existe contexto de ejecución y soporte de `AbortSignal`.
- Existe resultado tipado para éxito, fallo controlado y error interno.
- Existen errores específicos de tools y logging seguro.
- No existe ejecución de sistema ni shell arbitrario.
- Todos los tests de Phase 1 continúan pasando.
- Build, lint, typecheck, tests y `git diff --check` pasan.

## Definition of Done

- Documentación y ADR actualizados.
- Tests completos pasando sin credenciales, procesos ni endpoints externos.
- Git diff y status revisados.
- Commit final identificable y rama `phase/02-tools` publicada.
- Auditoría contra esta especificación completada.
- No se hace merge a `main` ni se inicia Phase 3 automáticamente.
