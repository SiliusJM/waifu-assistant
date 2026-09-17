# Phase 0 — Architecture & Foundation

## Objetivo

Crear cimientos profesionales y reversibles sin implementar todavía un asistente complejo.

## Alcance

- Diagnóstico documentado del entorno y del estado inicial.
- Inicialización de Git y rama principal local.
- Reglas de colaboración, seguridad y configuración.
- Esqueleto mínimo ejecutable de Node.js ESM.
- Logging estructurado con redacción básica de campos sensibles.
- Build, verificación sintáctica y tests básicos sin dependencias externas.
- Arquitectura conceptual y ADR de proveedores/OmniRoute.

## Fuera de alcance

No se implementan Assistant Core conversacional, herramientas reales, shell controlado, voz, STT, TTS, RVC, avatar, Electron, Vue, memoria, RAG, navegador, media, tareas autónomas, Computer Use, wake word, plugins ni integración OmniRoute.

## Criterios de aceptación

- El repositorio funciona y tiene una rama main local.
- El build termina correctamente.
- Existe al menos un test básico y pasa.
- La validación de lint/sintaxis pasa.
- Git está configurado localmente y el estado queda documentado.
- AGENTS.md y la documentación inicial existen.
- La estructura base y sus límites están documentados.
- No se requiere ninguna herramienta real ni proveedor externo.
- OmniRoute está evaluado como opción, aislado conceptualmente detrás de AIProvider y excluido de fast paths.

## Definition of Done

- Se ejecutaron npm run build, npm run lint y npm test.
- Se revisaron git diff y git status.
- Se actualizó CHANGELOG.md y docs/PROJECT_STATUS.md.
- Se creó un commit reproducible.
- El remote origin está configurado y la rama main fue publicada en GitHub: https://github.com/SiliusJM/waifu-assistant.
- No se declara Phase 1 iniciada.

## Implementación

El runtime de Phase 0 es Node.js ESM sin dependencias de terceros. El build copia src a dist y valida la sintaxis con node --check. El test runner es node:test en aislamiento none porque el aislamiento por workers está bloqueado por spawn EPERM en este entorno administrado. No hay un typecheck separado porque esta fase mantiene abierta la decisión entre TypeScript y JavaScript ESM con tipado gradual; esa decisión debe tomarse antes del core.

## Riesgos y regresiones

- El check de lint es deliberadamente pequeño y no sustituye un linter de proyecto completo.
- La ausencia de dependencias reduce superficie y reproducibilidad inicial, pero Phase 1 tendrá que elegir un toolchain de calidad.
- El diagnóstico de hardware está limitado por permisos WMI.
- El checkpoint depende de conservar la rama main publicada y de no hacer force push.

## Comandos de verificación

    npm run build
    npm run lint
    npm test

## Resultado del checkpoint

Phase 0 fue implementada, aprobada conceptualmente y verificada en 2026-09-17. El checkpoint está disponible en https://github.com/SiliusJM/waifu-assistant, en la rama main, commit a6118d3.
