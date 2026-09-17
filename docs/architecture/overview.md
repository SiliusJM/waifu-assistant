# Arquitectura propuesta

## Estado

Este documento describe límites y contratos de Phase 3. No representa una implementación completa del asistente.

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

Los contratos principales de Phase 1, el perímetro de tools de Phase 2 y el runtime de Phase 3 están implementados en TypeScript. Las capacidades futuras se añadirán cuando una fase las necesite; no se implementan anticipadamente.

## Routing

1. La entrada se clasifica.
2. Las órdenes deterministas se ejecutan localmente mediante herramientas explícitas.
3. Solo las solicitudes que requieren interpretación o generación usan AIProvider.
4. Un adaptador OmniRoute, si se aprueba posteriormente, se sitúa detrás de AIProvider.
5. La decisión de ruta, latencias, errores, coste y fallback se registra sin secretos.

OmniRoute no podrá sustituir la validación de herramientas ni ejecutar comandos deterministas. Un fallback de modelo no es un fallback de permiso.

## Transversal

Seguridad, permisos, configuración, logging, métricas, manejo de errores, pruebas y cancelación serán responsabilidades explícitas y no detalles implícitos del proveedor.

## Estado actual

La implementación contiene ciclo de vida de aplicación, AssistantCore, sesión en memoria, proveedores mock/direct, configuración, errores, logging, tools de Phase 2 y Realtime Engine de Phase 3. No hay aún UI, voz, memoria persistente, herramientas del sistema, routing determinista ni streaming real de proveedores externos.
