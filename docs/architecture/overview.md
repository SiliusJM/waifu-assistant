# Arquitectura propuesta

## Estado

Phase 8 queda definida solo a nivel arquitectonico en `phase/08-internet-browser`. No se ha implementado acceso a internet ni browser.

Este documento describe los límites y contratos implementados hasta Phase 7. No representa una implementación completa del asistente.

## Capas

    UI / Desktop
          |
    Interaction boundary
          |
    Assistant Core
       /       \
    Intent    AIProvider
    Router       |
       |      provider adapter
    Tool boundary
          |
    Deterministic local tools

Las capacidades futuras de voz, memoria y avatar se conectarán mediante contratos, no mediante imports directos entre proveedores y la lógica de negocio. Phase 3 añade el runtime de eventos y la frontera de interacción; el sistema de tools mantiene separada la frontera de ejecución.

## Contratos previstos

- AIProvider: generación de texto y, más adelante, tool calls estructurados.
- STTProvider: transcripción parcial o final.
- TTSProvider: síntesis y cancelación cuando el backend lo soporte.
- MemoryProvider: guardar, recuperar, editar y olvidar con políticas explícitas.
- ToolProvider: esquema, permisos, ejecución acotada y resultado validado.
- RealtimeEngine: ciclo de vida, eventos correlacionados, streaming abstracto, cancelación y concurrencia acotada.
- AvatarProvider: estados visuales derivados de eventos del core.
- VoiceService: coordinación explícita y acotada de entrada, STT, TTS y salida de audio.

Los contratos principales de Phase 1, el perímetro de tools de Phase 2 y el runtime de Phase 3 están implementados en TypeScript. Las capacidades futuras se añadirán cuando una fase las necesite; no se implementan anticipadamente.

## Streaming voice (Phase 5)

Phase 5 mantiene coexistencia entre los modos batch y streaming de VoiceService. El plano de datos usa iterables y queues acotadas para audio; el plano de control usa eventos correlacionados sin transportar bytes. VoiceConcurrencyCoordinator separa la exclusividad por sesión y por dispositivo, mientras interruption y supersede liberan y descartan la operación anterior de forma explícita.

La integración con RealtimeEngine sigue siendo responsabilidad del llamador. No hay providers reales, LLM real, pipeline autónomo, persistencia ni APIs de procesos.

## Routing

1. La entrada se clasifica.
2. Las órdenes deterministas se ejecutan localmente mediante herramientas explícitas.
3. Solo las solicitudes que requieren interpretación o generación usan AIProvider.
4. Un adaptador OmniRoute, si se aprueba posteriormente, se sitúa detrás de AIProvider.
5. La decisión de ruta, latencias, errores, coste y fallback se registra sin secretos.

OmniRoute no podrá sustituir la validación de herramientas ni ejecutar comandos deterministas. Un fallback de modelo no es un fallback de permiso.

## Personality System (Phase 6)

Phase 6 añade una capa declarativa entre la configuración de personalidad y `AssistantCore`: perfiles validados, política, compilación determinista y snapshots inmutables por interacción. `AssistantCore` traduce el snapshot a instrucciones `system` del request sin añadirlas a `Session`. El registro interno puede mantener varios perfiles y publicar eventos de ciclo de vida.

Personality System no es un agente, un motor de seguridad, una capa de permisos, una memoria, un coordinador de voz ni un sistema de tools. No usa APIs de procesos, proveedores reales, LLM real, persistencia, hot reload o UI. Los hints de voz son abstractos y no conocen TTS.

## Avatar System (Phase 7 - implementación acotada)

Phase 7 tiene una definición arquitectónica aprobada mediante PR #7 y merge commit `c30ccd3bff298c37cc1dd12a01ec775074b83b02`, materializada en la rama `phase/07-avatar-system-implementation`. La capa incluye adaptadores de entrada por señales normalizadas, `AvatarController`, `AvatarRuntime`, snapshots visuales inmutables, capabilities y un `AvatarProvider` reemplazable. Los estados visuales son `IDLE`, `LISTENING`, `SPEAKING` y `REACTION`; el lifecycle técnico se mantiene separado. No se ha elegido renderer, host de escritorio, formato de assets ni tecnología 2D/3D.

El avatar consume señales normalizadas y metadata controlada. No importa `RealtimeEngine`, `VoiceService` o `Personality System`, no interpreta instrucciones de personalidad, no ejecuta herramientas y no accede a procesos, shell, filesystem arbitrario, audio crudo o conversaciones.

## Internet & Browser (Phase 8 - definicion unicamente)

Phase 8 define tres fronteras separadas: `WebSearchProvider` para busqueda de solo lectura, `WebFetchProvider` para extraccion controlada y `BrowserProvider` para sesiones y acciones interactivas futuras. Ninguna esta implementada ni tiene un provider seleccionado.

La ruta futura pasa por una capability de internet y `ToolManager` antes de invocar un adapter. Search, fetch y browser tienen lifecycle, permisos y errores diferentes. El contenido web se representa como `WebData` no confiable y nunca puede modificar instrucciones, conceder permisos, pedir secretos o autorizar acciones.

La definicion establece validacion de URLs y redirects, `auto`/`confirm`/`block`, cancelacion mediante `AbortSignal`, timeouts, concurrencia acotada, latest-wins para lecturas sustituibles y una sola operacion activa por pagina. Login, credenciales, formularios, publicacion, compras, downloads, uploads, persistencia y acciones irreversibles permanecen bloqueados o requieren decisiones futuras.

Esta seccion no introduce browser automation, dependencias, UI, Electron/Vue, renderer, scraping, APIs de procesos, shell ni codigo de produccion.

## Transversal

Seguridad, permisos, configuración, logging, métricas, manejo de errores, pruebas y cancelación serán responsabilidades explícitas y no detalles implícitos del proveedor.

## Estado actual

La implementación contiene ciclo de vida de aplicación, AssistantCore, sesión en memoria, proveedores mock/direct, configuración, errores, logging, tools de Phase 2, Realtime Engine de Phase 3, Voice Service/streaming de Phases 4–5, Personality System de Phase 6 y el núcleo desacoplado de Avatar System de Phase 7. Voice Service usa únicamente mocks y requiere integración explícita con el llamador. Personality System usa perfiles declarativos, validación estricta, compilación determinista y snapshots por interacción. Avatar System usa controller, runtime, snapshots, capabilities, policy cerrada, provider mock y validación runtime; no hay renderer real, UI, proveedores de voz reales, memoria persistente, herramientas del sistema, routing determinista ni agente autónomo.
