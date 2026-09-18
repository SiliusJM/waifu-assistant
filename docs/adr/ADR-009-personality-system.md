# ADR-009: Personality System declarativo y por snapshot

## Estado

Aceptada para implementación en Phase 6; implementación en revisión externa en `phase/06-personality-system`. No mergeada.

## Contexto

El asistente necesita una identidad y un estilo consistentes sin mezclar personalidad con autorización, tools, memoria, voz, emoción, routing ni control del sistema. El historial de fases exige contratos desacoplados, TypeScript estricto, cancelación cooperativa y límites de seguridad explícitos.

## Decisión

Se adopta un modelo declarativo compuesto por `PersonalityProfile`, catálogos controlados, `PersonalityValidator`, `PersonalityPolicy`, `PersonalityCompiler`, `PersonalitySnapshot` y `PersonalityRegistry`.

El compilador produce instrucciones deterministas, limitadas y ordenadas. `AssistantCore` acepta un snapshot opcional en `RespondOptions`; las instrucciones se envían al provider como mensajes `system` de esa interacción, sin convertirse en mensajes de `Session`. Un cambio de perfil solo afecta snapshots nuevos.

Los perfiles usan JSON canónico validado al cargar y pueden coexistir varios perfiles en un registro interno. La selección no introduce UI, persistencia ni hot reload. Las preferencias de usuario son una capa externa y solo se aceptan como overrides transitorios explícitos.

La personalidad puede exponer hints abstractos de voz, pero no conoce TTS/STT ni providers concretos. Los límites de seguridad, permisos y tool calling siguen fuera del sistema. No se permite `systemPrompt` libre, evaluación dinámica ni contenido que intente introducir ejecución.

`CharacterIdentity.description` se conserva como metadata inmutable del `PersonalitySnapshot`, pero no se compila a `instructions`. Así el campo descriptivo no puede comportarse como política normativa ni como `systemPrompt`; tampoco tiene autoridad sobre tools, permisos, riesgo o procesos. Los overrides de interacción se normalizan en runtime: valores inválidos vuelven a los valores del perfil y locales no permitidos vuelven al locale por defecto/fallback.

`PersonalityRegistry` realiza copia defensiva y deep-freeze al registrar y cargar perfiles. `get`, `select`, `defaultProfile` y `list` solo exponen datos congelados; cualquier cambio debe pasar por `register` y validación otra vez.

## Consecuencias

Se obtiene reproducibilidad mediante versiones y fingerprint, snapshots seguros por interacción y una integración pequeña con el core. La política de conflicto es explícita y limitada a personalidad; no crea autoridad sobre seguridad o tools. La evolución futura hacia streaming, realtime, memoria y voz conserva el mismo boundary.

El modelo no incluye migraciones complejas, historial, persistencia, UI, emoción ni selección de providers. Esas decisiones requieren fases y evidencia separadas.

## Rechazado

- `systemPrompt` arbitrario definido por usuario o perfil.
- Personality System como agente, policy engine de seguridad o coordinador de herramientas.
- Guardar personalidad, preferencias, prompts o historial en memoria persistente.
- Acoplar el perfil a un proveedor LLM/TTS, OmniRoute, Electron, Vue o hardware.
