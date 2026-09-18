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

## Alcance actual: implementación de Phase 7 - Avatar System

Phase 6 — Personality System está cerrada y mergeada en `main` mediante PR #6, con merge commit `532c956e2a407b9e9e540584947a24739490bb03`. La definición de Phase 7 fue revisada, corregida y mergeada mediante PR #7, con merge commit `c30ccd3bff298c37cc1dd12a01ec775074b83b02`.

La rama `phase/07-avatar-system` contiene la definición histórica de la fase y ya fue mergeada. La implementación de Phase 7 debe comenzar en una rama de implementación separada y seguir exactamente la definición aprobada. No elegir ni añadir renderer concreto, UI, assets, persistencia o capacidades fuera de alcance sin una decisión de fase correspondiente.

La implementación activa se desarrolla únicamente en `phase/07-avatar-system-implementation`. Esta rama contiene el núcleo desacoplado y determinista de Avatar System; todavía no está mergeada a `main`.

Phase 6 implementó únicamente personalidad declarativa: perfiles, validación estricta, política, compilación determinista, snapshots por interacción, registro multi-perfil en memoria, JSON canónico, hints de voz abstractos, logging seguro y tests. No implementó agente, tools nuevas, permisos, seguridad, memoria persistente, emoción, voz real, LLM real, UI, hot reload ni APIs de procesos.

Phase 5 — Streaming Voice & Interruptions está cerrada y mergeada en `main` mediante PR #5, con merge commit `1f076df8e880c273abe261142aab9757c541d73e`. La rama de fase queda como histórico de implementación.

Phase 5 agregó streaming de captura/STT/TTS, playback incremental, backpressure, interrupciones, supersede, coordinación específica de voz, cancelación jerárquica, métricas y mocks deterministas. Los providers reales, el LLM real y cualquier API de procesos o shell permanecen fuera de alcance.

Phase 3 — Realtime Engine está cerrada y mergeada en `main`.

Phase 4 — Voice Service está cerrada y mergeada en `main` mediante PR #4. La fase implementa infraestructura de voz desacoplada: contratos de entrada/salida de audio, `STTProvider`, `TTSProvider`, `VoiceService`, `VoiceSession`, `VoiceError`, providers mock, cancelación, timeout, cleanup, logging seguro y tests deterministas sin hardware ni red.

Los proveedores reales de STT/TTS no fueron seleccionados ni integrados. ADR-007 queda abierto para el spike comparativo posterior.

La definición, alcance, contratos, criterios de aceptación y riesgos de Phase 5 ya fueron revisados y aprobados para esta implementación.

La definición, alcance, contratos, criterios de aceptación y riesgos de Phase 6 fueron revisados y aprobados antes de su implementación.

La definición, alcance, contratos, criterios de aceptación y riesgos de Phase 7 fueron revisados, corregidos y aprobados mediante PR #7 antes de iniciar su implementación.

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
