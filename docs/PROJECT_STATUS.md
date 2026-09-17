# Project Status

## Current Phase

Phase 0 — Architecture & Foundation.

## Status

COMPLETE. Phase 0 cumple sus criterios documentados y queda pendiente de aprobación humana antes de iniciar Phase 1.

## Completed

- Diagnóstico inicial del entorno, repositorio, Git, herramientas y limitaciones.
- Repositorio Git local inicializado en la rama main.
- Reglas de trabajo y seguridad documentadas.
- Esqueleto mínimo Node.js ESM ejecutable.
- Logger estructurado con redacción de claves sensibles.
- Build, lint sintáctico y tests básicos reproducibles sin dependencias externas.
- Arquitectura base, riesgos y decisión provisional sobre proveedores documentados.
- Changelog actualizado.

## In Progress

Ninguno dentro de Phase 0.

## Blocked

- No existe remote de GitHub conocido; no se realizó push.
- Las métricas de hardware están pendientes por bloqueo de WMI.
- La selección final de TypeScript, UI, voz, memoria, avatar y gateway requiere prototipos y evidencia en sus fases correspondientes.

## Next

Revisión y aprobación de Phase 0. Después, iniciar Phase 1 — Assistant Core, empezando por una evaluación reproducible de TypeScript frente a JavaScript ESM con tipado gradual y por la definición de AIProvider.

## Known Risks

- Agregar un gateway puede aumentar latencia y superficie de exposición.
- La compresión de contexto puede perder información y debe tener pruebas de fidelidad.
- Fallback entre proveedores puede cambiar comportamiento, capacidades de tool calling y políticas de datos.
- No se ha validado todavía un proveedor de voz ni un hardware objetivo.
