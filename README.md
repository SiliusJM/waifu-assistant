# Waifu Assistant

Asistente personal de escritorio desarrollado de forma incremental y segura.

## Estado

La base del repositorio corresponde a Phase 0 — Architecture & Foundation. El proyecto todavía no implementa conversación con modelos ni herramientas de control del equipo.

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

Instalar no requiere dependencias de terceros en Phase 0. Ejecutar:

    npm run build
    npm run lint
    npm test

El build copia el esqueleto ESM a dist y valida su sintaxis. dist es un artefacto generado y no se versiona.

## Próximo paso

La siguiente fase será Phase 1 — Assistant Core, únicamente después de revisar y aprobar los criterios de Phase 0. Su primera decisión técnica pendiente es seleccionar TypeScript o JavaScript ESM con tipado gradual para el core, respaldada por una evaluación reproducible.

## Documentación

- docs/PROJECT_DISCOVERY.md: diagnóstico del entorno y del repositorio.
- docs/PROJECT_STATUS.md: estado y riesgos.
- docs/architecture/overview.md: arquitectura propuesta y límites.
- docs/adr/ADR-001-provider-abstraction-and-optional-omniroute.md: evaluación inicial del gateway.
- docs/phases/phase-00-foundation.md: alcance y criterios de aceptación.
