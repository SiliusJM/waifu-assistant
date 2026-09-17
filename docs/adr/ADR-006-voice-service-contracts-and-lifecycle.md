# ADR-006: Voice Service contracts and lifecycle

- Estado: aceptado para Phase 4.
- Fecha: 2026-09-17.

## Contexto

El repositorio ya dispone de `AssistantCore`, tools y `RealtimeEngine`, pero no de una frontera de voz. Phase 4 necesita probar captura, STT, TTS y reproducción sin hardware, red, credenciales o proveedores concretos.

## Decisión

Se introduce `VoiceService` como coordinador explícito de providers abstraídos. `VoiceSession` representa una operación de voz y sus estados por etapa; no reemplaza ni posee `Session`. `VoiceEventMap` es independiente del mapa de eventos de realtime, aunque reutiliza `EventBus`, `InteractionStream`, `AbortSignal`, IDs y el patrón de envelope.

La entrada se valida contra PCM signed 16-bit little-endian, 16 kHz, mono. Las conversiones desde otros formatos serán explícitas en una decisión posterior. La operación admite cancelación y timeout global o por etapa. La terminalización reserva el resultado antes de publicar el evento terminal y todo recurso de provider se detiene en cleanup.

La implementación inicial usa únicamente mocks. La integración con `RealtimeEngine` es controlada por el llamador mediante `correlationId`; `VoiceService` no decide tools ni crea un pipeline autónomo STT → LLM → Tool → TTS.

## Consecuencias

- La voz queda desacoplada de hardware, sistema operativo y vendors.
- La privacidad por defecto evita persistencia de audio y logging de contenido.
- Providers reales podrán añadirse detrás de los contratos sin reescribir el servicio.
- La cancelación depende de cooperación de cada provider.
- La selección y benchmark de STT/TTS quedan para ADR-007 y no bloquean Phase 4.
