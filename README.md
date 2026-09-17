# Waifu Assistant

Asistente personal de escritorio desarrollado de forma incremental y segura.

## Estado

Phase 3 — Realtime Engine está COMPLETA y mergeada en `main`. La base incluye conversación de texto, tools seguras y un runtime interno de eventos, streaming abstracto, cancelación y concurrencia. No implementa voz, UI, shell ni herramientas de control del equipo.

Phase 4 — Voice Service está implementada en la rama `phase/04-voice-service`. Incluye contratos desacoplados de audio, STT, TTS y reproducción, lifecycle, cancelación, timeout, cleanup, logging seguro y mocks deterministas. Los proveedores reales quedan fuera hasta realizar un spike comparativo.

## Principios

Seguridad, integridad del proyecto, correctitud, estabilidad, baja latencia, mantenibilidad, experiencia de usuario, coste y nuevas capacidades, en ese orden.

La arquitectura mantendrá el núcleo separado de proveedores de IA, voz, memoria, avatar y herramientas. Electron, Vue, TypeScript, Python, faster-whisper, Edge-TTS, RVC, SQLite, Three.js, Live2D/VTube Studio, RAG y OmniRoute permanecen como candidatos sujetos a evaluación por fase.

## Requisitos locales detectados

- Windows
- Node.js 22 o posterior
- npm o pnpm
- Git

Python está disponible para la futura evaluación del servicio especializado de voz.

## Verificación

Instalar las dependencias y ejecutar:

    npm install
    npm run build
    npm run lint
    npm run typecheck
    npm test

`dist` y `dist-tests` son artefactos generados y no se versionan.

## Próximo paso

Implementar únicamente Phase 4 — Voice Service en su rama correspondiente. No integrar todavía proveedores de voz obligatorios, wake word, RVC, avatar, Electron/Vue, Spotify, YouTube, navegador, Computer Use, MCP, plugins, memoria/RAG, automatizaciones ni agente autónomo.

## Documentación

- `docs/PROJECT_DISCOVERY.md`: diagnóstico del entorno y del repositorio.
- `docs/PROJECT_STATUS.md`: estado y riesgos.
- `docs/architecture/overview.md`: arquitectura y límites.
- `docs/adr/ADR-001-provider-abstraction-and-optional-omniroute.md`: evaluación inicial del gateway.
- `docs/adr/ADR-002-typescript-strict-toolchain.md`: decisión de toolchain.
- `docs/adr/ADR-003-phase-1-core-contracts.md`: contratos del core.
- `docs/phases/phase-00-foundation.md`: alcance y criterios de aceptación de Phase 0.
- `docs/phases/phase-01-assistant-core.md`: alcance y criterios de aceptación de Phase 1.
- `docs/phases/phase-02-tool-system.md`: alcance y criterios de aceptación de Phase 2.
- `docs/phases/phase-03-realtime-engine.md`: alcance, criterios y cierre de Phase 3.
- `docs/phases/phase-04-voice-service.md`: alcance, contratos, seguridad y criterios de Phase 4.
