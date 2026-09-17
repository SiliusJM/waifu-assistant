# Phase 4 — Voice Service

## Objetivo

Implementar una infraestructura de voz desacoplada y testeable para captura, transcripción, síntesis y reproducción, sin seleccionar todavía proveedores reales.

## Alcance implementado

- Contratos tipados `AudioFormat`, `AudioChunk`, `AudioArtifact`, `AudioInputProvider`, `AudioOutputProvider`, `STTProvider` y `TTSProvider`.
- Representación canónica de entrada: PCM signed 16-bit little-endian, 16 kHz, mono. Las conversiones futuras deberán ser explícitas y configurables.
- `VoiceSession` separado de `Session`, con estados independientes para captura, STT, TTS y playback.
- `VoiceService` con lifecycle explícito, `AbortSignal`, timeout global o por etapa, cleanup y resultados terminales idempotentes.
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

## Criterios de aceptación

- Contratos y lifecycle implementados sin proveedores reales.
- Cancelación, timeout, cleanup, backpressure de eventos y terminalización idempotente verificables.
- Logging sin audio ni transcripciones completas.
- Sin shell, procesos ni flujo autónomo STT → LLM → Tool → TTS.
- Build, lint, typecheck, tests, `npm run check` y `git diff --check` pasando.
- ADR-007 de selección de proveedores permanece abierto.

## Resultado

Phase 4 queda implementada en `phase/04-voice-service`, pendiente únicamente de revisión del commit y del Pull Request. No se inicia Phase 5.
