# Phase 6 - Personality System

## Estado

Implementada en la rama `phase/06-personality-system` sobre `origin/main`, pendiente de revisión externa. Esta documentación no declara Phase 6 completa ni mergeada.

## Objetivo

Proporcionar una personalidad declarativa, validada, compilada de forma determinista y aplicada por interacción mediante snapshots inmutables. El sistema define configuración de comunicación; no es un agente, un sistema de memoria, un coordinador de voz ni una capa de seguridad.

## Arquitectura

```text
PersonalityProfile
        |
PersonalityValidator -> PersonalityPolicy -> PersonalityCompiler
                                      |
                            PersonalitySnapshot
                                      |
                                AssistantCore -> AIProvider
```

`PersonalityRegistry` mantiene varios perfiles en memoria, valida al registrar/cargar, permite seleccionar el perfil y publica únicamente eventos de ciclo de vida. `AssistantCore` recibe un snapshot opcional por interacción y lo traduce a mensajes `system` del request del provider; nunca lo guarda en `Session`.

## Contratos implementados

- `CharacterIdentity`: `displayName` requerido; `role`, `pronouns` y `description` opcionales.
- Traits, tono, speaking style, reglas conductuales y límites expresivos con catálogos cerrados y parámetros tipados.
- `LocalePolicy` y preferencias transitorias de interacción; las preferencias no pertenecen al perfil ni se persisten.
- `VoicePresentationHints` abstractos, sin conversión a parámetros de un proveedor TTS.
- `PersonalitySnapshot` con `personalityId`, `profileVersion`, `schemaVersion`, instrucciones ordenadas, hints opcionales y fingerprint.

El snapshot conserva `CharacterIdentity` como metadata inmutable. `displayName`, `role` y `pronouns` pueden participar en la instrucción de identidad; `description` queda fuera de `instructions` y nunca se convierte en texto normativo. Por diseño no puede actuar como `systemPrompt`, autorizar tools, modificar permisos/riesgo ni ejecutar procesos.

El perfil por defecto usa los traits catalogados `warm`, `direct` y `empathetic`. El catálogo inicial también incluye `energetic`, `formal` y `humorous`.

## Validación y compilación

La validación es estricta: rechaza schema/versiones incompatibles, IDs no controlados, duplicados, rangos inválidos, campos desconocidos, textos fuera de límites, locales inválidos y contenido que intenta introducir instrucciones de ejecución. No existe un campo `systemPrompt` libre ni evaluación dinámica.

El compilador es puro y determinista: valida y normaliza overrides transitorios, aplica la política declarada, ordena por prioridad e ID, deduplica, limita el tamaño total y calcula un fingerprint SHA-256 del resultado. Los snapshots y sus instrucciones quedan congelados para que cambiar un perfil solo afecte interacciones futuras.

`PersonalityRegistry` hace copia defensiva y deep-freeze al registrar/cargar. Sus accesores devuelven perfiles congelados y `list()` devuelve también una colección congelada; los cambios requieren volver a registrar y validar explícitamente.

## Persistencia y JSON

Los perfiles se serializan como JSON canónico con orden estable de claves y se validan al cargar. No se añade base de datos, YAML, migración compleja ni historial persistente en esta fase.

## Seguridad y límites

Personality System no importa `RealtimeEngine`, `VoiceService`, providers de voz, tools ni APIs de procesos. No ejecuta `exec`, `spawn`, PowerShell, CMD o shell; no cambia permisos, riesgo, autorización o políticas de herramientas. Los logs solo usan identificadores, versiones, fingerprint y conteos; no registran prompts completos, historial, memoria, preferencias privadas, secretos ni texto del usuario.

Los eventos permitidos son `personality_loaded`, `personality_changed` y `personality_validation_failed`. No se publican eventos por respuesta ni se implementan emoción, memoria persistente, UI selector, hot reload, LLM real, proveedores reales, voz, avatar o proactividad.

## Verificación

La suite determinista cubre validación, catálogo, parámetros tipados, compilación estable, inmutabilidad, overrides transitorios, registro multi-perfil, JSON roundtrip, integración aislada con `AssistantCore` y ausencia de APIs de procesos. La regresión completa de fases anteriores se ejecuta sin red, credenciales, hardware ni providers reales.

## Criterio de cierre

La implementación queda pendiente de revisión externa y no se debe hacer merge a `main` ni iniciar Phase 7 automáticamente.
