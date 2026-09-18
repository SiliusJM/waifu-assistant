# ADR-008: Streaming Voice & Interruptions

- Estado: aceptado e implementado; Phase 5 fue revisada y mergeada en `main` mediante PR #5.
- Fecha: 2026-09-18.

## Contexto

Phase 4 estableció contratos batch de voz. Phase 5 necesita capturar y procesar audio de forma incremental, producir parciales STT, sintetizar por fragmentos, reproducir sin transportar bytes mediante eventos y detener una respuesta de forma inmediata cuando el llamador lo solicite.

## Decisión

Se mantiene la coexistencia explícita de los modos `batch` y `streaming`. El plano de datos usa `AsyncIterable` y `BoundedAsyncQueue`; el plano de control reutiliza `EventBus`, `VoiceEventMap`, correlación, secuencia y `AbortSignal`. Los eventos solo contienen metadata y resultados de control, nunca audio crudo.

`VoiceConcurrencyCoordinator` mantiene como máximo una operación por sesión y un playback por dispositivo. No existe cola de respuestas. `supersede` e `interrupt` requieren una llamada explícita, descartan los buffers de la operación anterior y usan `stop('immediate')`; el modo `drain` queda disponible en el contrato de playback para cierres ordenados.

La cancelación se propaga desde shutdown/caller hacia operación y provider. Los timeouts globales y por etapa son configurables. La terminalización conserva la reserva de resultado antes del evento terminal. Los providers permanecen agnósticos de `Session`, `RealtimeEngine`, tools y LLM.

## Consecuencias

- STT y TTS pueden entregar datos parciales sin imponer un proveedor concreto.
- El backpressure acota memoria y la cancelación desbloquea productores y consumidores.
- La captura puede coexistir con playback porque usan leases y providers separados.
- La latencia se observa con marcas monotónicas internas, sin fijar objetivos de rendimiento.
- Los proveedores reales, el flujo STT → LLM → Tool → TTS y el hardware permanecen fuera de la fase.
- `ADR-007` sigue abierto para la selección y benchmark de proveedores reales.

