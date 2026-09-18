# Phase 4 — Voice Service

## Objetivo

Implementar una infraestructura de voz desacoplada y testeable para captura, transcripción, síntesis y reproducción, sin seleccionar todavía proveedores reales.

## Alcance implementado

- Contratos tipados `AudioFormat`, `AudioChunk`, `AudioArtifact`, `AudioInputProvider`, `AudioOutputProvider`, `STTProvider` y `TTSProvider`.
- Representación canónica de entrada: PCM signed 16-bit little-endian, 16 kHz, mono. Las conversiones futuras deberán ser explícitas y configurables.
- `VoiceSession` separado de `Session`, con estados independientes para captura, STT, TTS y playback.
- `VoiceService` con lifecycle explícito, `AbortSignal`, timeout por etapa, cleanup y resultados terminales idempotentes. `timeoutMs` actúa como fallback de timeout para cada etapa cuando no existe un timeout específico.
- `VoiceEventMap` independiente, con envelopes correlacionados, secuencia monotónica e IDs de sesión de voz.
- `VoiceError` categorizado y mensajes seguros, sin causas internas, audio ni transcripciones completas.
- Mocks deterministas para entrada, salida, STT y TTS.
- Integración contractual explícita con `RealtimeEngine` mediante el `correlationId` proporcionado por el llamador. `VoiceService` no posee `Session`, no ejecuta tools y no inicia flujos autónomos.

## Privacidad y seguridad

El audio se mantiene en memoria y no se persiste. Los logs contienen únicamente IDs, proveedores, estados, tamaños, duraciones y códigos. No se registran audio ni transcripciones completas. No se instalaron ni integraron faster-whisper, Whisper, whisper.cpp, Vosk, Edge-TTS, Piper, Kokoro ni otros proveedores reales.

La fase no importa `node:child_process` y no implementa `exec`, `spawn`, PowerShell, CMD, shell arbitrario, wake word, barge-in avanzado, RVC, avatar, Electron/Vue, memoria/RAG, MCP, plugins ni agente autónomo.

## Eventos y lifecycle

Una operación de transcripción recorre `created → capturing → transcribing → completed|cancelled|failed`. Una síntesis recorre `created → synthesizing → playing → completed|cancelled|failed`. La cancelación se propaga al provider activo y el cleanup llama siempre a `stop()` de entrada o salida. Los timeouts se clasifican como `VOICE_TIMEOUT_ERROR`; la cancelación del llamador como `VOICE_CANCELLATION_ERROR`.

## Pruebas

Los tests usan únicamente mocks en memoria y cubren formatos, captura, partial/final STT, síntesis, reproducción, correlación, cancelación durante captura/STT/TTS/playback, timeout por etapa, cleanup, errores tipados, privacidad del logging, integración explícita con RealtimeEngine y regresión de las fases anteriores.

Verificación reportada para la rama de Phase 4:

- Build: OK
- Lint: OK
- Typecheck: OK
- Tests: 57/57
- `npm run check`: OK
- `git diff --check`: OK
- Git status: limpio

## Criterios de aceptación

- Contratos y lifecycle implementados sin proveedores reales.
- Cancelación, timeout, cleanup, backpressure de eventos y terminalización idempotente verificables.
- Logging sin audio ni transcripciones completas.
- Sin shell, procesos ni flujo autónomo STT → LLM → Tool → TTS.
- Build, lint, typecheck, tests, `npm run check` y `git diff --check` pasando.
- ADR-007 de selección de proveedores permanece abierto.

## Resultado

El diseño de Phase 5 fue revisado y aprobado posteriormente; su implementación se realiza únicamente en la rama `phase/05-streaming-voice` y no altera el cierre de Phase 4 en `main`.

Phase 4 está COMPLETA y mergeada en `main` mediante PR #4, con merge commit `1ec4384dc529ed303e85413e7969a3896c741a69`.

Los proveedores reales de STT/TTS siguen fuera del alcance de esta implementación y serán evaluados mediante un spike comparativo posterior. Phase 5 se implementa en su propia rama y no altera este cierre.
