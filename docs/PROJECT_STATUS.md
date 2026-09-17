# Project Status

## Current Phase

Phase 2 — Tool System.

## Status

IN PROGRESS. Phase 0 y Phase 1 están completadas y Phase 1 fue mergeada en `main`. Phase 2 está en la rama `phase/02-tools` y no está aprobada ni mergeada.

## Completed

- Diagnóstico inicial del entorno, repositorio, Git, herramientas y limitaciones.
- Repositorio Git local inicializado en la rama main.
- Reglas de trabajo y seguridad documentadas.
- Esqueleto mínimo Node.js ESM ejecutable.
- Logger estructurado con redacción de claves sensibles.
- Build, lint sintáctico y tests básicos reproducibles sin dependencias externas.
- Arquitectura base, riesgos y decisión provisional sobre proveedores documentados.
- Changelog actualizado.
- Remote origin configurado y rama main publicada en GitHub: https://github.com/SiliusJM/waifu-assistant.
- TypeScript estricto, ESLint y configuración de compilación reproducible implementados para Phase 1.
- AssistantCore, Session, Message, Context, Response y providers implementados.
- Errores categorizados, cancelación, timeout y retry explícito implementados.
- Tests unitarios y de integración HTTP controlados pasando sin credenciales externas.
- Rama `phase/02-tools` creada y publicada desde el merge de Phase 1.
- Contrato, registry, manager, validación, autorización, contexto, resultados y errores de tools implementados en la rama de Phase 2.

## In Progress

Contratos iniciales de tools, registry, manager, validación y autorización en implementación.

## Blocked

- Las métricas de hardware están pendientes por bloqueo de WMI.
- La selección final de TypeScript, UI, voz, memoria, avatar y gateway requiere prototipos y evidencia en sus fases correspondientes.

## Next

Completar y auditar Phase 2. Después de su aprobación manual, decidir el trabajo posterior.

## Known Risks

- Agregar un gateway puede aumentar latencia y superficie de exposición.
- La compresión de contexto puede perder información y debe tener pruebas de fidelidad.
- Fallback entre proveedores puede cambiar comportamiento, capacidades de tool calling y políticas de datos.
- No se ha validado todavía un proveedor de voz ni un hardware objetivo.
- El benchmark empírico de OmniRoute permanece separado y no bloquea Phase 1.
