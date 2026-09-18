# Phase 5 — Streaming Voice & Interruptions

## Estado

Implementada en `phase/05-streaming-voice` y pendiente de revisión externa. No está mergeada en `main`.

## Alcance implementado

- Modo `streaming` coexistente con los contratos batch de Phase 4.
- Captura incremental mediante `AudioInputStream`, STT parcial/final y TTS por texto completo o fragmentos.
- Reproducción incremental mediante `AudioPlaybackHandle`, con `stop('immediate' | 'drain')`.
- `BoundedAsyncQueue` con capacidad limitada, backpressure, cierre destructivo para cancelación y finalización ordenada para `endInput`.
- `VoiceConcurrencyCoordinator`: una operación por sesión y un playback por dispositivo, sin cola implícita.
- `interrupt`, `supersede`, shutdown, cancelación jerárquica, timeouts y cleanup determinista.
- Eventos de control correlacionados con secuencia y reloj monotónico; los bytes de audio no circulan por `EventBus`.
- `VoiceLatencyTracker` con marcas de captura, STT, TTS, playback, interrupción, cancelación y liberación de recursos.
- Providers mock deterministas y pruebas sin red, credenciales ni hardware.

Los parámetros de capacidad y buffering son configurables. Los valores iniciales no constituyen objetivos de rendimiento ni decisiones irreversibles.

`captureChunkDurationMs`, `playbackBufferMs` y `maxPendingMs` son políticas de buffering expresadas en milisegundos, no timeouts operativos. Se validan como duraciones positivas y no se convierten a bytes sin información específica del provider. La métrica `interruption_latency` usa únicamente la marca de detención efectiva del playback; la captura mantiene una marca separada.

## Contratos principales

`AudioInputStream`, `AudioStreamChunk`, `StreamingAudioInputProvider`, `StreamingSTTProvider`, `StreamingSTTSession`, `StreamingTTSProvider`, `StreamingTTSOperation`, `StreamingAudioOutputProvider`, `AudioPlaybackHandle`, `AudioStreamResult`, `STTStartRequest`, `VoiceTerminationReason` y `StreamingVoiceOperationHandle`.

`VoiceService` mantiene el adaptador público y expone `startStreamingTranscription`, `startStreamingSynthesis` y `shutdownStreaming`, manteniendo los métodos batch existentes. `StreamingVoiceService` implementa la operación streaming y `shutdownStreaming` delega en ella. El llamador conserva la decisión de cuándo conectar una transcripción con `RealtimeEngine` y cuándo iniciar TTS.

## Seguridad y límites

No se persiste audio ni transcripciones completas. Los logs no contienen contenido de audio o texto completo. Phase 5 no importa APIs de procesos, no ejecuta shell, no integra proveedores reales, no usa un LLM real y no crea un pipeline autónomo STT → LLM → Tool → TTS.

Quedan fuera: wake word, barge-in avanzado, RVC, avatar, Electron/Vue, persistencia, RAG, MCP, plugins, browser automation, media, Computer Use, agent loop y proactividad.

## Verificación

La verificación de cierre se ejecuta desde la rama de la fase y debe incluir `build`, `lint`, `typecheck`, `test`, `npm run check`, `git diff --check` y revisión de estado/diff. Phase 5 no se declara completa hasta la revisión externa.
