# Waifu Assistant

Asistente personal de escritorio desarrollado de forma incremental y segura.

## Estado

El repositorio está implementando Phase 2 — Tool System. La base incluye conversación de texto con sesión en memoria y proveedores abstraídos; Phase 2 añade sólo el perímetro seguro para herramientas explícitas. No implementa herramientas de control del equipo.

## Principios

Seguridad, integridad del proyecto, correctitud, estabilidad, baja latencia, mantenibilidad, experiencia de usuario, coste y nuevas capacidades, en ese orden.

La arquitectura mantendrá el núcleo separado de proveedores de IA, voz, memoria, avatar y herramientas. Electron, Vue, TypeScript, Python, faster-whisper, Edge-TTS, RVC, SQLite, Three.js, Live2D/VTube Studio, RAG y OmniRoute permanecen como candidatos sujetos a evaluación.

## Requisitos locales detectados

- Windows
- Node.js 22 o posterior
- npm o pnpm
- Git

Python está disponible para una futura evaluación del servicio especializado de voz. No es necesario para ejecutar esta fase.

## Verificación

Instalar las dependencias y ejecutar:

    npm install
    npm run build
    npm run lint
    npm run typecheck
    npm test

dist y dist-tests son artefactos generados y no se versionan.

## Próximo paso

Phase 2 se desarrolla en la rama `phase/02-tools` y debe ser revisada y aprobada antes de cualquier Phase 3. No se implementan shell, PowerShell, `exec`, `spawn` ni herramientas del sistema. OmniRoute permanece desactivado y su benchmark es un experimento separado.

## Documentación

- docs/PROJECT_DISCOVERY.md: diagnóstico del entorno y del repositorio.
- docs/PROJECT_STATUS.md: estado y riesgos.
- docs/architecture/overview.md: arquitectura propuesta y límites.
- docs/adr/ADR-001-provider-abstraction-and-optional-omniroute.md: evaluación inicial del gateway.
- docs/adr/ADR-002-typescript-strict-toolchain.md: decisión de toolchain.
- docs/adr/ADR-003-phase-1-core-contracts.md: contratos del core.
- docs/phases/phase-00-foundation.md: alcance y criterios de aceptación de Phase 0.
- docs/phases/phase-01-assistant-core.md: alcance y criterios de aceptación actuales.
- docs/phases/phase-02-tool-system.md: alcance y criterios de aceptación de Phase 2.
