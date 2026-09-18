# ADR-010: Definición desacoplada del Avatar System

## Estado

Propuesta para revisión humana. Phase 7 está únicamente definida en `phase/07-avatar-system`; no hay implementación ni decisión tecnológica definitiva.

## Contexto

Las fases 3-6 ya proporcionan eventos de realtime, contratos batch/streaming de voz y personalidad declarativa. El producto necesita una presentación visual futura, pero elegir ahora Electron, Vue, Three.js, Live2D, VTube Studio o un modelo concreto introduciría acoplamiento antes de conocer capacidades, assets, host y rendimiento real.

## Decisión propuesta

Separar cinco responsabilidades:

1. adaptadores que convierten eventos de Realtime/Voice/usuario en `AvatarSignal`;
2. `AvatarController` con máquina visual determinista;
3. `AvatarRuntime` con lifecycle, cancelación, orden y cleanup;
4. `AvatarProvider` como puerto de renderer;
5. UI/desktop host y resolución de assets fuera del core.

Los estados visuales iniciales son `IDLE`, `LISTENING`, `SPEAKING` y `REACTION`. `REACTION` conserva un `baseState` para que una reacción no falsifique una interrupción de voz. Los estados `loading`, `error`, `shutting_down` y `stopped` pertenecen al lifecycle técnico, no al estado visual.

La sincronización usa eventos tipados, correlación, secuencia monotónica y snapshots inmutables. El runtime mantiene como máximo una presentación activa y una pendiente; las actualizaciones visuales obsoletas pueden reemplazarse por latest-wins. No se crea una cola ilimitada.

Personality System solo aporta metadata controlada (`personalityId`, versión, `CharacterIdentity` para presentación). `PersonalitySnapshot.instructions`, `description` como texto normativo y `VoicePresentationHints` no se convierten en animaciones. Cualquier mapeo futuro debe pertenecer a una política explícita de avatar.

## Consecuencias

El core no depende de un renderer, host o formato de asset. Los fallos visuales no rompen AssistantCore, RealtimeEngine o VoiceService. La arquitectura permite un provider 2D o 3D futuro, pero todavía no determina cuál.

El coste es una capa de adaptación y una decisión posterior sobre manifests, capacidades, fallback no-op, UI host y renderer inicial. Es un coste deliberado para preservar seguridad, estabilidad y reemplazabilidad.

## Rechazado por ahora

- Integrar tecnologías de renderizado o desktop.
- Derivar animaciones de prompts, texto libre, permisos o decisiones del agente.
- Permitir acceso del renderer a tools, shell, filesystem arbitrario, audio crudo o memoria.
- Persistir estado visual, conversaciones, assets descargados o preferencias.
- Crear selector multi-personaje o cambio dinámico.

## Aprobaciones pendientes

- Máquina visual con reacción como overlay y política latest-wins.
- Contrato de fallback cuando el renderer no esté disponible.
- Primer renderer y estrategia de assets en una fase de implementación posterior.
- Owner de los adaptadores de eventos y campos de identidad expuestos a UI.
