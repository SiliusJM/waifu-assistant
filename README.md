# Waifu Assistant

Asistente personal de escritorio desarrollado de forma incremental y segura.

## Estado

Phase 8 — Internet & Browser está definida y aprobada a nivel arquitectónico y su spike de providers/sandbox y controlled tests está completado. La definición fue revisada y mergeada a `main` mediante PR #9 (`ef17ff897b2d25d1c402d271d4a3631b26b3fa5b`), el spike mediante PR #10 (`bb29fb303c83eeed2c73b7d4944479756c2362ea`) y los controlled tests mediante PR #11 (`35045dcf9bcd9ff6b31c9bb7908af7872daae5a3`). La evidencia actual incluye 29/29 comprobaciones controladas de Fetch/SSRF/DNS/policies pasando, pero Search y Browser siguen `NOT EXECUTED` por falta de credenciales/entorno. No se han añadido browser automation, providers reales, dependencias, UI, persistencia ni código de producción.

Documentacion de Phase 8:

- `docs/phases/phase-08-internet-and-browser.md`: definicion, seguridad, lifecycle y criterios; sin implementacion.
- `docs/adr/ADR-011-internet-and-browser-definition.md`: decision arquitectonica de Internet & Browser.
- `docs/phase-08-provider-and-sandbox-spike.md`: spike documental de providers, transporte, browser y sandbox.
- `docs/phase-08-controlled-test-results.md`: resultados del harness controlado y límites de la evidencia.

Phase 3 — Realtime Engine está COMPLETA y mergeada en `main`. La base incluye conversación de texto, tools seguras y un runtime interno de eventos, streaming abstracto, cancelación y concurrencia.

Phase 4 — Voice Service está COMPLETA y mergeada en `main` mediante PR #4, con merge commit `1ec4384dc529ed303e85413e7969a3896c741a69`. Incluye contratos desacoplados de audio, STT, TTS y reproducción, `VoiceService`, `VoiceSession`, `VoiceError`, lifecycle, cancelación, timeout por etapa, cleanup, logging seguro, eventos correlacionados y mocks deterministas. Los proveedores reales de voz no fueron seleccionados ni integrados.

Phase 5 — Streaming Voice & Interruptions está COMPLETA y mergeada en `main` mediante PR #5, con merge commit `1f076df8e880c273abe261142aab9757c541d73e`. Añade streaming de audio/STT/TTS, playback incremental, backpressure, interruption/supersede, coordinación por sesión/dispositivo, cancelación jerárquica, métricas y mocks deterministas. Los proveedores reales de voz y el LLM real siguen fuera de alcance.

Phase 6 — Personality System está COMPLETA y mergeada en `main` mediante PR #6, con merge commit `532c956e2a407b9e9e540584947a24739490bb03`. Añade personalidad declarativa, catálogos controlados, validación estricta, snapshots por interacción, registry multi-perfil, JSON canónico e integración opcional con `AssistantCore`. No añade memoria persistente, emoción, voz real ni UI multi-personaje.

Phase 7 — Avatar System está COMPLETA y mergeada en `main` mediante PR #8, con merge commit `417a30deca884f55057164475b08b2521d47347d`. Incluye contratos, lifecycle, máquina visual, concurrencia bounded, capabilities, eventos, policy cerrada, provider mock, validación runtime y tests; no incluye renderer ni UI.

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

La definición, el spike documental y los controlled tests de Phase 8 ya fueron revisados y mergeados. El siguiente paso es ejecutar, en un entorno aislado y con credenciales temporales cuando corresponda, las pruebas externas de Search y Browser que siguen `NOT EXECUTED`, y después usar esa evidencia para decidir providers, sandbox, egress y límites antes de introducir código de producción.

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
- `docs/phases/phase-05-streaming-voice-and-interruptions.md`: alcance, contratos, seguridad y verificación de Phase 5.
- `docs/phases/phase-06-personality-system.md`: alcance, contratos, seguridad y verificación de Phase 6.
- `docs/phases/phase-07-avatar-system.md`: definición, implementación acotada y criterios de Phase 7.
- `docs/adr/ADR-010-avatar-system-definition.md`: decisión arquitectónica de Avatar System y límites de implementación.
