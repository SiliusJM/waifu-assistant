# AGENTS.md — Waifu Assistant

## Propósito

Waifu Assistant es un proyecto incremental y seguro de asistente personal de escritorio. El repositorio se desarrolla por fases y la fase activa es la única que puede implementarse.

## Reglas de trabajo

- Leer este archivo, `docs/PROJECT_STATUS.md`, la documentación de la fase activa y el estado de Git antes de modificar el proyecto.
- Preservar el trabajo existente. No borrar, resetear, sobrescribir ni reescribir componentes sin una razón técnica documentada.
- No inventar APIs, credenciales, endpoints, versiones, resultados de pruebas ni integraciones.
- Mantener cambios pequeños, reversibles, medibles, documentados y versionados.
- No avanzar a otra fase hasta que la fase activa cumpla todos sus criterios de aceptación.
- Las tecnologías listadas como candidatas deben evaluarse antes de convertirse en decisiones.

## Alcance actual: Phase 5 — Streaming Voice & Interruptions

Phase 5 está autorizada para implementación únicamente en `phase/05-streaming-voice`. La rama `main` permanece en el cierre de Phase 4; no hacer merge ni iniciar Phase 6.

La fase activa agrega streaming de captura/STT/TTS, playback incremental, backpressure, interrupciones, supersede, coordinación específica de voz, cancelación jerárquica, métricas y mocks deterministas. Mantener fuera los providers reales, el LLM real y cualquier API de procesos o shell.

Phase 3 — Realtime Engine está cerrada y mergeada en `main`.

Phase 4 — Voice Service está cerrada y mergeada en `main` mediante PR #4. La fase implementa infraestructura de voz desacoplada: contratos de entrada/salida de audio, `STTProvider`, `TTSProvider`, `VoiceService`, `VoiceSession`, `VoiceError`, providers mock, cancelación, timeout, cleanup, logging seguro y tests deterministas sin hardware ni red.

Los proveedores reales de STT/TTS no fueron seleccionados ni integrados. ADR-007 queda abierto para el spike comparativo posterior.

La definición, alcance, contratos, criterios de aceptación y riesgos de Phase 5 ya fueron revisados y aprobados para esta implementación.

## Arquitectura y seguridad

- Mantener el núcleo desacoplado de proveedores externos mediante interfaces.
- Las órdenes deterministas deberán seguir una ruta local y explícita; un gateway LLM nunca es necesario para un fast path.
- Ningún modelo podrá ejecutar shell arbitrario ni controlar el equipo sin validación, allowlist, permisos, confirmación cuando corresponda y validación del resultado.
- No guardar secretos en Git, código, documentación ni logs. Usar variables de entorno locales y mantener solo ejemplos sin valores reales.
- No registrar audio ni transcripciones completas por defecto.
- Los errores técnicos deben registrarse con información segura y reservar las respuestas naturales para capas superiores.
- La cancelación debe propagarse cooperativamente mediante `AbortSignal` y todos los recursos temporales deben limpiarse en `finally`.
- Ningún provider de voz puede acceder por sí mismo a `Session`, `RealtimeEngine` ni herramientas.

## Comandos de verificación

Desde la raíz del repositorio:

- `npm run build`
- `npm run lint`
- `npm run typecheck`
- `npm test`
- `npm run check`

Las fases de voz mantienen TypeScript estricto y no deben introducir ejecución de procesos ni shell. Ningún código de voz puede importar `node:child_process` ni ejecutar comandos, scripts o código generado.

## Cierre de una fase

Antes de marcar una fase como completada: ejecutar las verificaciones disponibles, revisar `git diff` y `git status`, actualizar la documentación y el changelog, crear un commit reproducible y anotar riesgos pendientes. Publicar la rama de la fase y completar la revisión antes del merge. No iniciar la fase siguiente automáticamente.
