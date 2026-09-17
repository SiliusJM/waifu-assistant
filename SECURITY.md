# Seguridad

## Alcance

La seguridad es un requisito de diseño desde la primera fase. Phase 1 no ejecuta herramientas del sistema, pero sí realiza llamadas HTTP configurables cuando se activa explícitamente el proveedor direct.

## Secretos

- Nunca guardar API keys, tokens, contraseñas, credenciales, cookies o claves privadas en Git, código, README o logs.
- Usar un archivo .env local no versionado cuando una fase necesite credenciales.
- Mantener .env.example sin valores secretos.
- No imprimir variables de entorno completas durante diagnósticos.
- Rotar una credencial si se sospecha que fue expuesta.

## Herramientas y agentes

Antes de ejecutar una herramienta futura se requerirán validación de esquema, validación de argumentos, comprobación de permisos, allowlist, ejecución acotada y validación del resultado. El modelo no será una barrera de seguridad suficiente.

No se permitirá por defecto que un LLM construya o ejecute comandos shell arbitrarios.

## Proveedores y gateway

Un proveedor de IA puede recibir prompts, contexto y credenciales. DirectAIProvider usa configuración externa, timeout, retries clasificados y logs sin contenido de prompts. OmniRoute permanece desactivado y no forma parte de Phase 1; si se evalúa después, deberá estar detrás de AIProvider y fuera de fast paths deterministas.

## Reporte

Los reportes de seguridad deben describir el impacto sin incluir secretos. Hasta disponer de un canal privado del repositorio, no publicar detalles explotables en un issue público.
