# Phase 1 — Assistant Core

## Objetivo

Implementar conversación de texto con sesión en memoria y un proveedor de IA abstraído, manteniendo preparada la arquitectura para streaming, cancelación y futuras herramientas.

## Alcance

- TypeScript estricto y toolchain reproducible.
- Message, Session, Context y Response con responsabilidades separadas.
- AIProvider con complete y stream.
- MockAIProvider para pruebas.
- DirectAIProvider HTTP configurable por baseURL, apiKey, model, timeout y retry.
- AssistantCore para texto de entrada y respuesta de texto.
- Errores categorizados y logging sin secretos.
- Configuración externa mediante variables de entorno.
- Tests unitarios y servidor HTTP controlado para el proveedor directo.

## Fuera de alcance

No se implementan tools reales, shell, permisos completos, voz, STT, TTS, RVC, memoria persistente, RAG, avatar, Electron, Vue, browser automation, media, agent engine, Computer Use, wake word, plugins, proactividad ni benchmark real de OmniRoute.

## Configuración

AI_PROVIDER puede ser mock o direct. El modo mock no necesita credenciales. El modo direct exige AI_BASE_URL, AI_API_KEY y AI_MODEL. AI_TIMEOUT_MS y AI_MAX_ATTEMPTS controlan timeout y retry. OmniRoute permanece desactivado por defecto y no se instala.

## Errores y retries

Se distinguen configuración, autenticación, red, timeout, rate limit, respuesta inválida, proveedor, cancelación y validación. Solo red, timeout, rate limit y errores 5xx elegibles se reintentan, con máximo de intentos y backoff configurables. 400, 401/403, JSON inválido y cancelación no se reintentan.

## Pruebas

El servidor HTTP controlado cubre éxito, 400, 401, 429, 500, retry recuperable, JSON inválido, forma inválida, timeout y cancelación. No se usan credenciales ni endpoints reales.

## Criterios de aceptación

- Conversación de texto funcional con MockAIProvider.
- DirectAIProvider configurable sin SDK específico.
- Session, Message, Context y Response no se solapan.
- complete y stream están disponibles detrás de AIProvider.
- AbortSignal cancela llamadas y backoff.
- Errores y retries respetan la clasificación documentada.
- Logs no incluyen prompts completos, API keys ni tokens.
- OmniRoute no es dependencia y permanece desactivado.
- Build, lint, typecheck y tests pasan.

## Definition of Done

- Ejecutar npm run build, npm run lint, npm run typecheck y npm test.
- Revisar git diff y git status.
- Actualizar documentación y CHANGELOG.md.
- Crear commit y registrar hash.
- No iniciar Phase 2 automáticamente.

## Resultado

Phase 1 fue implementada y verificada localmente el 2026-09-17. El checkpoint queda en la rama main y requiere aprobación humana antes de iniciar Phase 2.
