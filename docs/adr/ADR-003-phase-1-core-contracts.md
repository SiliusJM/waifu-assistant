# ADR-003: Contratos del Assistant Core

- Estado: aceptado para Phase 1.
- Fecha: 2026-09-17.

## Decisión

Phase 1 separa explícitamente:

- Message: dato inmutable de una entrada conversacional.
- Session: historial ordenado en memoria.
- Context: snapshot de mensajes para una petición; no persiste ni posee la sesión.
- Response: resultado público de AssistantCore; no es el payload crudo del proveedor.
- AIProvider: frontera con el modelo externo.
- AssistantCore: orquestador de entrada, contexto, provider, respuesta, errores y logs.

AIProvider expone complete y stream. Ambos aceptan ProviderCallOptions con AbortSignal y timeout. Los adapters de Phase 1 pueden implementar stream como un evento completed sobre una respuesta completa; el contrato no deberá cambiar para añadir deltas reales después.

## Límites

AssistantCore no ejecuta tools, shell, permisos, memoria persistente, voz ni navegación. Las tool calls son datos conceptuales en la respuesta y se reservan para Tool System.

## Consecuencias

El core puede cambiar de proveedor sin reescritura. La sesión sigue siendo efímera. La cancelación y los errores categorizados ya forman parte del contrato, aunque el flujo realtime se implemente después.
