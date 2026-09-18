# Phase 7 - Avatar System

## Estado

DEFINICIÓN APROBADA E IMPLEMENTACIÓN EN REVISIÓN. La definición fue revisada, corregida y mergeada mediante PR #7, con merge commit `c30ccd3bff298c37cc1dd12a01ec775074b83b02`. La implementación está en `phase/07-avatar-system-implementation`; añade únicamente el núcleo desacoplado, tests y documentación de cierre. No añade renderer, UI, assets reales ni APIs de procesos.

## 1. Objetivo

Definir una capa de presentación visual desacoplada que represente estados controlados del asistente y reacciones de interacción. La capa debe poder conectarse después a un renderer 2D, 3D, Live2D, Three.js, VTube Studio u otra tecnología sin que `AssistantCore`, `RealtimeEngine`, `VoiceService` o `Personality System` dependan de ella.

El avatar no razona, no ejecuta acciones, no autoriza tools y no es una fuente de verdad del estado lógico del asistente.

## 2. Alcance propuesto

- Contratos conceptuales para runtime, controller, provider, eventos, snapshots, expresiones, animaciones y lifecycle.
- Máquina determinista para los estados visuales `IDLE`, `LISTENING`, `SPEAKING` y `REACTION`.
- Estado técnico de lifecycle separado del estado visual.
- Adaptadores explícitos desde eventos normalizados de Realtime/Voice/usuario.
- Presentación inmutable y acotada, cancelación cooperativa y manejo de errores aislado.
- Manifest conceptual de assets y perfil de personaje, sin archivos reales.
- Preparación para múltiples personajes sin selector ni cambio dinámico.

## 3. Fuera de alcance

- Electron, Vue, Three.js, Live2D, VTube Studio o cualquier renderer concreto.
- Ventanas, UI, menús, interacción visual de escritorio y selección de personaje.
- Lip-sync, análisis de audio, captura de cámara, tracking facial o mocap.
- Providers reales, carga de modelos reales, descarga de assets o filesystem arbitrario.
- Cambios en permisos, tools, seguridad, routing, memoria, emoción, agente o razonamiento.
- Persistencia, conversaciones, base de datos, RAG, plugins, MCP, browser automation, shell y procesos.
- Animaciones generadas por texto, prompts libres o instrucciones arbitrarias para el renderer.

## 4. Problemas que resuelve

- Evita que la UI futura conozca el estado interno de voz o realtime.
- Evita que un renderer concreto se convierta en dependencia del core.
- Define cómo representar interrupciones sin dejar animaciones o estados imposibles activos.
- Permite observar estado visual sin transportar audio, transcripciones completas o prompts.
- Deja un boundary estable para reemplazar renderer, assets y host de ventana.

## 5. Arquitectura propuesta

```text
Realtime/Voice/User adapters
             |
      AvatarSignal (normalizado)
             |
     AvatarController / state machine
             |
 AvatarPresentationSnapshot (inmutable)
             |
        AvatarRuntime
          /       \
 AvatarProvider  AvatarEventBus
      (renderer)   (metadata)
             |
       UI / desktop host
```

`AvatarController` convierte señales validadas y tipadas en un estado visual. `AvatarRuntime` administra lifecycle, cancelación, orden y conexión opcional con el provider. `AvatarProvider` solo presenta snapshots compuestos y reporta capacidades/errores. `REACTION` no inicia una segunda operación concurrente: el controller produce un único snapshot cuya `state` es `REACTION` y cuyo `baseState` conserva `SPEAKING`, `LISTENING` o `IDLE`. El host de UI contiene ventana, canvas, transporte y permisos de acceso a assets.

El avatar debe ser opcional: el fallo del renderer no bloquea ni cambia el resultado de `AssistantCore`, `RealtimeEngine` o `VoiceService`.

## 6. Componentes y responsabilidades

### AvatarController

Mantiene la máquina de estados visual, acepta `AvatarSignal`, aplica la política de precedencia, evita duplicados y produce snapshots. No conoce Electron, audio, tools ni filesystem.

### AvatarRuntime

Coordina lifecycle, provider, cancelación de presentaciones y cleanup. Mantiene a lo sumo la presentación activa y una actualización visual pendiente; los cambios visuales repetidos pueden aplicar política latest-wins sin crear una cola ilimitada.

### AvatarProvider

Adaptador del renderer. Presenta un snapshot compuesto validado mediante una única operación lógica por runtime, expone capacidades declaradas y cancela o finaliza la presentación vigente. No decide estado lógico, permisos ni selección de herramientas.

La política depende de `AvatarProviderCapabilities.interruptiblePresentation`:

- Si es `true`, `AvatarRuntime` envía `AbortSignal` a la presentación activa, descarta el snapshot anterior y presenta el snapshot más reciente.
- Si es `false`, `AvatarRuntime` no inicia un segundo `present()` concurrente. Mantiene la operación actual y como máximo un snapshot pendiente; cada snapshot nuevo reemplaza el pendiente anterior mediante latest-wins. Cuando termina la operación actual, presenta únicamente el último snapshot pendiente.

En ambos casos existe una sola operación `AvatarProvider.present()` activa por runtime. `AbortSignal` se utiliza para shutdown y para providers interrumpibles; enviarlo a un provider no interrumpible no garantiza cancelación física. El runtime no espera indefinidamente al provider ni bloquea `AssistantCore`, `RealtimeEngine` o `VoiceService`: la presentación es opcional, asíncrona y desacoplada.

### AvatarPresentationPolicy

Tabla controlada que mapea estado, reacción y perfil de personaje a IDs de expresión/animación. No acepta prompts ni código generado. Una animación desconocida se rechaza o se sustituye por un fallback declarado.

### AvatarCharacterProfile

Describe un `characterId` estable, metadata de presentación y el manifest de assets/capacidades asociado. No representa una `PersonalityProfile` completa y no permite cambiar de personaje dinámicamente en esta fase.

### AvatarEventBus

Reutiliza el patrón `EventBus` para eventos tipados de lifecycle, estado y renderer. Solo transporta metadata acotada; nunca audio crudo, imágenes, prompts o transcripciones completas.

## 7. Contratos implementados

Los siguientes nombres y formas son los contratos TypeScript implementados por el núcleo de esta fase; no implican un renderer concreto.

```ts
type AvatarVisualState = 'IDLE' | 'LISTENING' | 'SPEAKING' | 'REACTION';

type AvatarLifecycleState =
  | 'CREATED' | 'INITIALIZING' | 'LOADING' | 'READY'
  | 'ERROR' | 'SHUTTING_DOWN' | 'STOPPED';

type AvatarSignal =
  | {
      readonly type: 'listen_started' | 'listen_stopped' | 'speech_started' | 'speech_stopped' | 'reaction_finished' | 'visual_reset';
      readonly correlationId: string;
      readonly sourceId: string;
      readonly sourceSequence: number;
      /** Assigned by the normalization boundary; the controller orders by this value. */
      readonly sequence: number;
      readonly reason?: 'completed' | 'cancelled' | 'interrupted' | 'superseded' | 'failed';
    }
  | {
      readonly type: 'reaction_requested';
      readonly correlationId: string;
      readonly sourceId: string;
      readonly sourceSequence: number;
      /** Assigned by the normalization boundary; the controller orders by this value. */
      readonly sequence: number;
      readonly reactionId: string;
      readonly durationMs?: number;
    };

interface AvatarPresentationSnapshot {
  readonly runtimeId: string;
  readonly characterId: string;
  readonly state: AvatarVisualState;
  readonly baseState: 'IDLE' | 'LISTENING' | 'SPEAKING';
  readonly expressionId?: string;
  readonly animationId?: string;
  readonly intensity?: number;
  readonly sequence: number;
  readonly correlationId?: string;
}

type AvatarAssetKind = 'model' | 'texture' | 'animation' | 'expression' | 'metadata';

interface AvatarProviderCapabilities {
  readonly expressions: readonly string[];
  readonly animations: readonly string[];
  readonly interruptiblePresentation: boolean;
  readonly assetKinds: readonly AvatarAssetKind[];
}

interface AvatarProvider {
  readonly name: string;
  initialize(signal?: AbortSignal): Promise<AvatarProviderCapabilities>;
  present(snapshot: AvatarPresentationSnapshot, signal: AbortSignal): Promise<void>;
  shutdown(signal?: AbortSignal): Promise<void>;
}
```

La frontera de normalización asigna `sequence` global monotónica a cada señal después de validar `sourceId` y `sourceSequence`. Cada fuente conserva su contador local para detectar duplicados o saltos, pero el controller nunca compara `sourceSequence` entre fuentes distintas. `AvatarController` usa exclusivamente la `sequence` global para ordenar, descartar señales antiguas y aplicar latest-wins.

`AvatarProvider.initialize()` devuelve una instantánea inmutable de `AvatarProviderCapabilities`. `expressions` y `animations` son IDs que el provider puede presentar; `interruptiblePresentation` indica si puede cancelar la presentación vigente; `assetKinds` enumera las clases de manifest que entiende. `AvatarRuntime` conserva esa instantánea, valida la política contra ella y rechaza o aplica fallback cuando una capacidad no existe. Las capacidades no ejecutan instrucciones ni habilitan permisos.

En una implementación real, todos los valores externos se validarían antes de construir el snapshot. `expressionId` y `animationId` serían IDs del manifest o de una política cerrada, no texto ejecutable ni instrucciones del modelo.

## 8. Estados visuales y máquina de estados

Los cuatro estados de producto son suficientes para el primer boundary. No se añade `ERROR`, `LOADING`, `BUSY` ni `UNAVAILABLE` como estado visual: esos conceptos pertenecen al lifecycle técnico y a observabilidad.

Transiciones válidas del estado visual:

```text
IDLE      -> LISTENING | SPEAKING | REACTION
LISTENING -> IDLE | SPEAKING | REACTION
SPEAKING  -> IDLE | LISTENING | REACTION
REACTION  -> IDLE | LISTENING | SPEAKING
```

`REACTION` es una presentación transitoria compuesta que conserva `baseState`. Si ocurre durante `SPEAKING`, el controller reemplaza el snapshot vigente por un único snapshot con `state = REACTION` y `baseState = SPEAKING`; no crea una segunda llamada concurrente ni una segunda operación del provider. Al finalizar o cancelarse la reacción, el controller produce el siguiente snapshot con `state = baseState`. `baseState` es la única fuente de verdad para la restauración. La reacción no cambia el estado lógico de voz.

Una transición repetida con el mismo estado y correlación es idempotente y no publica un cambio duplicado. Una solicitud inválida produce un error tipado o se descarta de forma observable, sin mutar parcialmente el estado.

Lifecycle independiente:

```text
CREATED -> INITIALIZING -> LOADING -> READY
   |          |             |          |
   +----------+-------------+----------+--> ERROR
   |          |             |          |
   +----------+-------------+----------+--> SHUTTING_DOWN -> STOPPED
```

Todo estado de lifecycle distinto de `STOPPED`, incluido `ERROR`, puede iniciar `SHUTTING_DOWN`. Desde `ERROR`, shutdown debe liberar listeners, timers, provider y presentaciones parciales aunque la inicialización haya fallado. El shutdown es idempotente: una segunda solicitud durante `SHUTTING_DOWN` comparte o espera el mismo cleanup, y una solicitud en `STOPPED` no vuelve a ejecutar recursos. No se reinicia automáticamente desde `ERROR`; el host debe crear una operación explícita o un runtime nuevo.

## 9. Eventos

Eventos internos mínimos propuestos:

| Evento | Responsabilidad |
|---|---|
| `avatar_initialized` | Registrar que el runtime aceptó configuración validada. |
| `avatar_ready` | Indicar que provider y estado inicial están disponibles. |
| `avatar_state_changed` | Publicar transición efectiva, origen, secuencia y correlación. |
| `avatar_reaction_requested` | Registrar una reacción aceptada por la política; no implica que ya se renderizó. |
| `avatar_animation_started` | Confirmar que el provider inició la presentación seleccionada. |
| `avatar_animation_finished` | Permitir cerrar una reacción o medir finalización sin inferirla desde un timeout. |
| `avatar_error` | Publicar error categorizado y estado degradado sin detalles sensibles. |
| `avatar_shutdown` | Indicar que el runtime terminó cleanup y no aceptará más señales. |

No se añade un evento por cada frame ni se transportan bytes de audio, imágenes, prompts o transcripciones completas. Los eventos incluyen `eventId`, `runtimeId`, `correlationId` opcional, secuencia monotónica, timestamp, estado y códigos seguros.

## 10. Lifecycle y cleanup

1. `create`: se valida configuración y se asigna `runtimeId`.
2. `initialize`: se crea el vínculo con el provider sin bloquear el core.
3. `loading`: el provider resuelve capacidades y manifest permitido.
4. `ready`: se publica estado inicial `IDLE`.
5. `present`: se aplican snapshots con `AbortSignal` y secuencia.
6. `shutdown`: se solicita cancelación mediante `AbortSignal`, se descarta la pendiente, se impide iniciar nuevos `present()` y se libera el provider dentro de un límite acotado antes de publicar `avatar_shutdown`. En un provider no interrumpible, el abort no garantiza detener físicamente la operación; el runtime la deja fuera de servicio y aplica la degradación definida sin bloquear al core.
7. `error`: se conserva el diagnóstico categorizado; no se propaga una excepción visual al core.

Todo recurso temporal se limpia en `finally`. El shutdown debe ser idempotente y no aceptar nuevas señales después de `STOPPED`.

## 11. Integración con Realtime Engine

El Avatar System no importa ni controla `RealtimeEngine`. Un adaptador externo puede traducir eventos de interacción a `AvatarSignal` cuando exista una semántica visual clara. `interaction_started` no debe interpretarse automáticamente como `LISTENING`: escuchar es una decisión del flujo de entrada de voz o del host.

Los estados de interacción `created`, `running`, `streaming`, `cancelling`, `completed`, `cancelled` y `failed` no se copian como estados visuales. Solo se usan señales explícitas y correlacionadas, por ejemplo para reset o reacción de error. El avatar nunca ejecuta `ToolResult` ni recibe autoridad por observar eventos de tools.

## 12. Integración con Voice Service y Phase 5

La integración recomendada es un adaptador de eventos, no una dependencia directa del renderer:

- `audio_input_started` -> `LISTENING`.
- fin/cancelación de captura -> `IDLE`, salvo que otra señal válida mantenga `LISTENING`.
- `playback_started` -> `SPEAKING`.
- `audio_output_stopped`, `voice_completed`, `voice_cancelled`, `interruption_completed` -> estado base siguiente, normalmente `IDLE`.
- si una interrupción detiene playback y comienza captura, la secuencia/correlación decide `SPEAKING -> LISTENING` sin mostrar un estado intermedio contradictorio.

La métrica de voz sigue siendo responsabilidad de Phase 5. Avatar solo observa metadata de control. No hace lip-sync, análisis de audio ni conversión de `VoicePresentationHints` a parámetros visuales.

## 13. Integración con Personality System

El avatar puede consumir un contrato controlado derivado del snapshot:

- `personalityId` y `profileVersion` para correlación/observabilidad;
- `CharacterIdentity.displayName` para label o accesibilidad;
- `role` y `pronouns` solo si una futura UI los necesita como metadata de presentación;
- `characterId` resuelto por la aplicación, no inferido libremente por el renderer.

No debe consumir `PersonalitySnapshot.instructions`, ni interpretar `description` como instrucción, ni usar `VoicePresentationHints` para decidir animaciones. Traits, tono, límites, permisos, tool calling y jerarquías de seguridad no se convierten automáticamente en animaciones. Cualquier relación futura debe ser una tabla explícita y validada de `AvatarPresentationPolicy`.

## 14. Concurrencia e interrupciones

- Solo una presentación lógica y una operación `AvatarProvider.present()` efectiva por runtime; un snapshot pendiente puede ser reemplazado por el más reciente.
- Una nueva señal de estado cancela o reemplaza la presentación anterior mediante `AbortSignal` y conserva la última secuencia global válida.
- Si `interruptiblePresentation = true`, el abort cooperativo cancela la operación activa, se descarta su snapshot y se presenta el snapshot más reciente.
- Si `interruptiblePresentation = false`, el abort no se usa para fingir una cancelación física: la operación actual continúa, no se ejecuta un segundo `present()` y se conserva como máximo un snapshot pendiente latest-wins. Al terminar la operación actual se presenta solo ese snapshot.
- Una reacción durante `SPEAKING` se representa dentro del snapshot compuesto (`state = reaction`, `baseState = speaking`); no inicia un segundo `present()` concurrente ni cancela audio.
- Al finalizar la reacción, el controller restaura `baseState`; no existe un campo paralelo `resumeAfterReaction`.
- Una reacción nueva reemplaza la anterior únicamente mediante política latest-wins; no se crea una cola de reacciones en Phase 7.
- Señales antiguas se descartan comparando exclusivamente su `sequence` global, asignada en el boundary de normalización; `sourceSequence` solo sirve para diagnóstico y deduplicación local.
- Shutdown solicita cancelación de todo mediante `AbortSignal`, descarta lo pendiente y deja el runtime en `STOPPED` después del cleanup lógico; un provider no interrumpible puede no detener físicamente su operación, que queda fuera de servicio y no puede recibir otro `present()`.
- Los eventos duplicados no producen transiciones ni callbacks duplicados.

La ordenación requiere un boundary único de normalización que reciba `sourceId` y `sourceSequence` de cada adaptador, valide la señal y asigne la secuencia global. El avatar no intenta comparar contadores locales de fuentes distintas, reconstruir una historia completa ni reparar eventos faltantes.

## 15. Synchronization futura

Se define el boundary `AvatarSignal` para que futuras fases puedan añadir marcas de `speech_started`, `speech_progress`, `speech_stopped`, `interruption_requested` y `interruption_effective` sin transportar audio. Lip-sync, phonemes y análisis de energía quedan fuera; una futura integración recibirá datos derivados y validados, no acceso directo a buffers del provider.

## 16. Rendering independence y UI host

El core propone snapshots y lifecycle; el provider decide cómo dibujar. Una futura UI host será responsable de ventana, canvas, ciclo de render, DPI, foco, visibilidad, accesibilidad y transporte. El Avatar System no asume Electron, Vue, DOM, WebGL o una ventana.

El provider puede declarar capacidades como `expressions`, `animations`, `interruptiblePresentation` y `assetKinds`. La ausencia de una capacidad produce fallback controlado, no una dependencia nueva.

## 17. Assets y manifests

El manifest conceptual contiene `manifestId`, `manifestVersion`, `characterId`, lista de assets, IDs de expresión/animación, capacidades y referencias de integridad. Los assets pueden incluir modelo, textura, animación, expresión, audio visual o metadata, pero no se fija un formato en esta fase.

El core solo recibe un manifest ya validado. La resolución de referencias pertenece al host/provider y deberá usar allowlists, límites de tamaño, integridad y cleanup. No se permite que una cadena recibida del modelo se convierta en ruta de filesystem o URL arbitraria.

## 18. Multi-avatar / Character support

El contrato usa `characterId` estable y separa `AvatarCharacterProfile` de `PersonalityProfile`. Un runtime tiene un personaje activo por vez. Phase 7 no implementa selector, UI, cambio dinámico ni sincronización de varios avatars.

Esta separación permite que una futura aplicación seleccione un par personality/avatar de forma explícita, valide compatibilidad y cree un runtime nuevo sin convertir el renderer en dueño de la personalidad.

## 19. Persistencia

Phase 7 no necesita persistencia. El runtime, estado visual, eventos y snapshots son efímeros. No se guarda conversación, memoria semántica, historial de animaciones, preferencias ni telemetría local. La configuración estática de un futuro host podrá venir de un manifest validado, pero esa decisión no se implementa ahora.

## 20. Performance

No se inventan benchmarks. Se proponen métricas medibles por provider:

- tiempo `initialize -> ready`;
- tiempo señal -> `avatar_state_changed`;
- tiempo snapshot -> `avatar_animation_started`;
- duración y tasa de fallos de carga de assets;
- presentaciones canceladas/coalescidas;
- CPU, GPU y memoria del renderer, medidos fuera del core;
- cantidad de eventos descartados por secuencia o lifecycle.

El controller no renderiza frames ni impone FPS. El provider debe poder limitar su frecuencia, memoria y carga de assets. El runtime mantiene estructuras acotadas y degrada a no-op/error controlado si no hay renderer disponible.

## 21. Manejo de errores

Categorías propuestas: configuración, lifecycle, estado inválido, provider no disponible, asset no encontrado, capability no soportada, cancelación, timeout de shutdown y error interno. Los mensajes públicos no contienen rutas privadas, URLs completas, prompts, audio, texto de usuario ni detalles del provider.

- Modelo/asset no carga: `avatar_error`, se cancela la presentación afectada y el core continúa.
- Animación inexistente: fallback declarado o error de capability; nunca se ejecuta texto arbitrario.
- Evento inválido/antiguo: se rechaza sin mutar estado.
- Avatar no ready: se rechaza o coalesce según operación; no se simula `READY`.
- Provider no interrumpible: la presentación actual continúa sin iniciar otra en paralelo; el runtime conserva solo el último snapshot pendiente y degrada/observa la latencia sin bloquear al core.
- Shutdown durante animación: cancelación cooperativa, cleanup y `avatar_shutdown`.
- Si el provider no responde o no puede finalizar, se aplica timeout/degradación controlada según el lifecycle; `AbortSignal` no se presenta como cancelación física cuando `interruptiblePresentation` es `false`.
- Renderer caído: estado técnico `ERROR` y degradación a no-op opcional; no cambia el resultado lógico de la interacción.

## 22. Límites de seguridad

Avatar System no ejecuta comandos, no importa APIs de procesos, no controla el sistema operativo, no modifica permisos, no accede arbitrariamente al filesystem, no controla tools y no toma decisiones del agente. No recibe secretos ni credenciales del core.

Los manifest/assets deberán validarse en un boundary posterior. El renderer no es un sandbox de seguridad y una animación visual nunca debe interpretarse como autorización o confirmación de una acción.

## 23. Observabilidad

Los logs pueden incluir `runtimeId`, `characterId`, provider, lifecycle state, visual state, animation/expression IDs controlados, correlationId, sequence, duración, código de error y contadores. No se registran frames, audio, imagen, texto completo, prompts, memoria o credenciales.

La observabilidad debe distinguir estado solicitado, estado aceptado y presentación iniciada/finalizada para no confundir una intención visual con un render efectivo.

## 24. Riesgos

- Diferencias de capacidades entre renderers 2D/3D.
- Assets grandes, cold start, consumo de GPU y presión de memoria.
- Desorden o duplicación entre eventos de voz/realtime.
- Animaciones que no son interrumpibles en un provider concreto.
- Fugas de privacidad mediante telemetría, capturas o logs.
- Acoplamiento accidental entre identidad, personalidad y assets.
- Ambigüedad entre reacción visual y confirmación de una acción.
- Diferencias de lifecycle entre host desktop y renderer.

## 25. Alternativas consideradas

- **Integrar Electron/Vue ahora:** rechazado; fijaría el host antes de conocer el contrato y mezclaría UI con el core.
- **Usar un único modelo Live2D/3D:** rechazado; impediría reemplazar renderer y medir capacidades reales.
- **Derivar animaciones directamente del texto o prompt del LLM:** rechazado; rompe seguridad, determinismo y separación de responsabilidades.
- **Copiar todos los eventos de Realtime/Voice al avatar:** rechazado; aumenta acoplamiento y expone datos innecesarios.
- **Cola ilimitada de reacciones:** rechazada; puede producir latencia y estados visuales obsoletos. Se propone latest-wins acotado.

## 26. Decisiones que requieren aprobación humana

1. Confirmar la separación `AvatarVisualState` de `AvatarLifecycleState` y el uso de `REACTION` como overlay con `baseState`.
2. Confirmar política latest-wins para estado/reacciones y ausencia de cola implícita.
3. Elegir, en una fase futura, el primer renderer/provider y su estrategia de assets.
4. Definir si `role` y `pronouns` se exponen a una futura UI o quedan solo en metadata.
5. Aprobar el fallback no-op/degraded cuando no exista renderer.
6. Definir el owner de los adaptadores que traducen Voice/Realtime events a `AvatarSignal`.
7. Definir formato de manifest, integridad y almacenamiento cuando exista un spike de assets.

## 27. Criterios de aceptación de la implementación

- TypeScript estricto y contratos sin dependencias de Electron/Vue/Three.js/Live2D/VTube Studio.
- Máquina de estados determinista, transiciones inválidas rechazadas, duplicados idempotentes y secuencias antiguas descartadas.
- Lifecycle completo con initialize/load/ready/error/shutdown/cleanup y shutdown idempotente.
- `MockAvatarProvider` y tests sin renderer, hardware, red, assets reales o filesystem arbitrario.
- Snapshots y eventos inmutables; límites de tamaño y estructuras pendientes acotadas.
- Con `interruptiblePresentation = true`, una nueva señal aborta cooperativamente la presentación activa y solo se presenta el snapshot más reciente.
- Con `interruptiblePresentation = false`, nunca hay dos `present()` concurrentes, existe como máximo un snapshot pendiente y latest-wins reemplaza el pendiente hasta que termina la operación actual.
- `AbortSignal` se usa para shutdown y cancelación cooperativa, pero los tests no asumen cancelación física cuando la capability es `false`.
- Reacciones durante `SPEAKING` preservan playback lógico y vuelven al estado base.
- Interrupción `SPEAKING -> LISTENING` no produce estados contradictorios y respeta correlación/secuencia.
- Fallos visuales aislados de AssistantCore, RealtimeEngine y VoiceService.
- Integración de Personality System limitada a metadata/control explícito; nunca instrucciones, permisos o prompts.
- Logs seguros y pruebas que demuestren ausencia de shell/process APIs.
- Regresión completa de Phase 1-6 pasando.

## 28. Lista explícita de no implementación

En la futura implementación inicial todavía no deben incluirse renderer real, Electron, Vue, Three.js, Live2D, VTube Studio, modelos, texturas, lip-sync, audio analysis, UI, selector de personajes, persistencia, avatar autónomo, herramientas, permisos, filesystem arbitrario, shell, proveedores cloud, LLM real o decisiones de agente.

## Conclusión

La definición aprobada deja un boundary pequeño: eventos normalizados entran, una máquina determinista produce snapshots visuales y un provider opcional los presenta. La implementación de esta rama materializa ese boundary sin elegir renderer, assets, UI ni host de escritorio. La revisión y el merge quedan pendientes; no se inicia Phase 8.
