# Índice de decisiones

Las decisiones relevantes se registran como ADRs para preservar contexto y facilitar migraciones.

- ADR-001: abstracción de proveedor de IA y OmniRoute opcional.
- ADR-002: toolchain TypeScript estricto para Phase 1.
- ADR-003: contratos del Assistant Core, streaming y cancelación.
- ADR-004: validación declarativa propia para Phase 2.
- ADR-005: Realtime Engine, eventos, estados, concurrencia y cancelación para Phase 3.
- ADR-006: contratos, lifecycle y privacidad del Voice Service para Phase 4.
- ADR-008: streaming de voz, backpressure, concurrencia e interrupciones para Phase 5.
- ADR-009: Personality System declarativo, validado y aplicado mediante snapshots por interacción.

Decisiones futuras previstas, solo cuando exista evidencia:

- lenguaje y toolchain del Assistant Core;
- transporte del servicio de voz;
- proveedor STT/TTS y necesidad de Python;
- estrategia de memoria y recuperación;
- renderer 2D o 3D del avatar;
- base de datos y políticas de caché.

ADR-007 — selección y benchmark de proveedores STT/TTS — permanece abierto y no es requisito de Phase 4.
