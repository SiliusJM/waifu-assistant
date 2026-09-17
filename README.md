# Waifu Assistant

Asistente personal de escritorio desarrollado de forma incremental y segura.

## Estado

Phase 3 — Realtime Engine está COMPLETA y mergeada en `main`. La base incluye conversación de texto, tools seguras y un runtime interno de eventos, streaming abstracto, cancelación y concurrencia.

Phase 4 — Voice Service está COMPLETA y mergeada en `main` mediante PR #4, con merge commit `1ec4384dc529ed303e85413e7969a3896c741a69`. Incluye contratos desacoplados de audio, STT, TTS y reproducción, `VoiceService`, `VoiceSession`, `VoiceError`, lifecycle, cancelación, timeout por etapa, cleanup, logging seguro, eventos correlacionados y mocks deterministas. Los proveedores reales de voz no fueron seleccionados ni integrados.

## Principios

Seguridad, integridad del proyecto, correctitud, estabilidad, baja latencia, mantenibilidad, experiencia de usuario, coste y nuevas capacidades, en ese orden.

La arquitectura mantendrá el núcleo separado de proveedores de IA, voz, memoria, avatar y herramientas. Electron, Vue, TypeScript, Python, faster-whisper, Edge-TTS, RVC, SQLite, Three.js, Live2D/VTube Studio, RAG y OmniRoute permanecen como candidatos sujetos a evaluación por fase.

## Requisitos locales detectados

- Windows
- Node.js 22 o posterior
- npm o pnpm
- Git

Python está disponible para la evaluación posterior de proveedores especializados de voz.

## Verificación

Instalar las dependencias y ejecutar:

    npm install
    npm run build
    npm run lint
    npm run typecheck
    npm test

`dist` y `dist-tests` son artefactos generados y no se versionan.

## Próximo paso

Realizar el checkpoint post-merge de Phase 4 y preparar la definición de Phase 5 — Streaming Voice & Interruptions. No implementar Phase 5 hasta que su alcance, contratos, criterios de aceptación y riesgos hayan sido revisados y aprobados.

Los proveedores reales de STT/TTS se evaluarán mediante un spike comparativo independiente y ADR-007; no forman parte del cierre de Phase 4.

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
