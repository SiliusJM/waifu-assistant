# Arquitectura propuesta

## Estado

Este documento describe límites y contratos de Phase 0. No representa una implementación completa del asistente.

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

Las capacidades futuras de realtime, voz, memoria, avatar y eventos se conectarán mediante contratos, no mediante imports directos entre proveedores y la lógica de negocio.

## Contratos previstos

- AIProvider: generación de texto y, más adelante, tool calls estructurados.
- STTProvider: transcripción parcial o final.
- TTSProvider: síntesis y cancelación cuando el backend lo soporte.
- MemoryProvider: guardar, recuperar, editar y olvidar con políticas explícitas.
- ToolProvider: esquema, permisos, ejecución acotada y resultado validado.
- AvatarProvider: estados visuales derivados de eventos del core.

Los contratos se definirán cuando una fase los necesite. Phase 0 no crea APIs ficticias ni integra proveedores.

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

La implementación de Phase 0 contiene solo un ciclo de vida mínimo de aplicación y logging. No hay aún UI, IA, voz, memoria, herramientas ni red.
