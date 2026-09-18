# ADR-010: Definición desacoplada del Avatar System

## Estado

Aceptada como definición arquitectónica. La definición de Phase 7 fue revisada, corregida y mergeada mediante PR #7 con merge commit `c30ccd3bff298c37cc1dd12a01ec775074b83b02`. No hay implementación de producción ni decisión tecnológica definitiva sobre renderer.

## Contexto

Las fases 3-6 ya proporcionan eventos de realtime, contratos batch/streaming de voz y personalidad declarativa. El producto necesita una presentación visual futura, pero elegir ahora Electron, Vue, Three.js, Live2D, VTube Studio o un modelo concreto introduciría acoplamiento antes de conocer capacidades, assets, host y rendimiento real.

## Decisión propuesta

Separar cinco responsabilidades:

1. adaptadores que convierten eventos de Realtime/Voice/usuario en `AvatarSignal`;
2. `AvatarController` con máquina visual determinista;
3. `AvatarRuntime` con lifecycle, cancelación, orden y cleanup;
4. `AvatarProvider` como puerto de renderer;
5. UI/desktop host y resolución de assets fuera del core.

Los estados visuales iniciales son `IDLE`, `LISTENING`, `SPEAKING` y `REACTION`. `REACTION` conserva un `baseState` para que una reacción no falsifique una interrupción de voz. Es una presentación compuesta dentro de la única operación lógica vigente del runtime; no abre una segunda operación concurrente del provider. Al finalizar, `state` vuelve al único valor de verdad `baseState`; no existe `resumeAfterReaction`. Los estados `loading`, `error`, `shutting_down` y `stopped` pertenecen al lifecycle técnico, no al estado visual.

La sincronización usa eventos tipados, correlación, snapshots inmutables y una secuencia global asignada por el boundary de normalización. Cada `AvatarSignal` conserva `sourceId` y `sourceSequence` local; el controller usa exclusivamente la secuencia global para ordenar y aplicar latest-wins. El runtime mantiene como máximo una presentación activa y una pendiente; las actualizaciones visuales obsoletas pueden reemplazarse por latest-wins. No se crea una cola ilimitada.

`AvatarProvider.initialize()` expone una instantánea de `AvatarProviderCapabilities`: IDs de `expressions`, IDs de `animations`, `interruptiblePresentation` y `assetKinds` soportados. `AvatarRuntime` valida el snapshot contra esa declaración antes de llamar a `present()`; la capacidad no concede autoridad ni acceso a recursos.

Cualquier estado de lifecycle distinto de `stopped`, incluido `error`, puede iniciar `shutting_down`. Shutdown solicita cancelación mediante `AbortSignal`, descarta lo pendiente, impide nuevas presentaciones y libera recursos dentro de un límite acotado. En un provider no interrumpible, el abort no garantiza cancelación física: la operación queda fuera de servicio y no puede recibir otro `present()`. Shutdown sigue siendo idempotente; repetirlo durante o después de cleanup no ejecuta una segunda liberación.

La capability `interruptiblePresentation` define la coordinación, no la cantidad de operaciones: siempre existe como máximo una operación `AvatarProvider.present()` activa por runtime. Si es `true`, el runtime envía `AbortSignal`, descarta la presentación activa y presenta el snapshot más reciente. Si es `false`, conserva la operación actual, no inicia un segundo `present()` concurrente y mantiene como máximo un snapshot pendiente; cada nuevo snapshot reemplaza ese pendiente mediante latest-wins y solo se presenta al finalizar la operación actual. `AbortSignal` sigue siendo obligatorio para shutdown y cancelación cooperativa de providers interrumpibles, pero no garantiza cancelación física en un provider no interrumpible. Esta coordinación es asíncrona y no bloquea AssistantCore, RealtimeEngine ni VoiceService.

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

- Snapshot compuesto único con `state = reaction`, `baseState` como única fuente de restauración y política latest-wins con secuencia global.
- Contrato de `AvatarProviderCapabilities` expuesto por `initialize()` y validado por el runtime.
- Política explícita para providers interrumpibles y no interrumpibles: una operación activa, un pendiente máximo, latest-wins y degradación no bloqueante.
- Contrato de fallback cuando el renderer no esté disponible.
- Primer renderer y estrategia de assets en una fase de implementación posterior.
- Owner de los adaptadores de eventos y campos de identidad expuestos a UI.
