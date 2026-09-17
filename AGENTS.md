# AGENTS.md — Waifu Assistant

## Propósito

Waifu Assistant es un proyecto incremental de asistente personal de escritorio. Este repositorio se desarrolla por fases y la fase activa es la única que puede implementarse.

## Reglas de trabajo

- Leer este archivo, docs/PROJECT_STATUS.md, la documentación de la fase activa y el estado de Git antes de modificar el proyecto.
- Preservar el trabajo existente. No borrar, resetear, sobrescribir ni reescribir componentes sin una razón técnica documentada.
- No inventar APIs, credenciales, endpoints, versiones, resultados de pruebas ni integraciones.
- Mantener cambios pequeños, reversibles, medibles, documentados y versionados.
- No avanzar a otra fase hasta que la fase activa cumpla todos sus criterios de aceptación.
- Las tecnologías listadas como candidatas deben evaluarse antes de convertirse en decisiones.

## Alcance actual: Phase 1

Phase 1 implementa conversación de texto, sesión en memoria, proveedor de IA abstraído, configuración, errores y logging seguro. No incluye herramientas reales, voz, memoria persistente, navegador, avatar, UI ni agente autónomo.

## Arquitectura y seguridad

- Mantener el núcleo desacoplado de proveedores externos mediante interfaces.
- Las órdenes deterministas deberán seguir una ruta local y explícita; un gateway LLM nunca es necesario para un fast path.
- Ningún modelo podrá ejecutar shell arbitrario ni controlar el equipo sin validación, allowlist, permisos, confirmación cuando corresponda y validación del resultado.
- No guardar secretos en Git, código, documentación ni logs. Usar variables de entorno locales y mantener solo ejemplos sin valores reales.
- Registrar errores técnicos en logs y reservar las respuestas naturales para capas superiores.

## Comandos de verificación

Desde la raíz del repositorio:

- npm run build
- npm run lint
- npm run typecheck
- npm test

Phase 1 usa TypeScript estricto, ESLint y los tipos de Node con versiones fijadas en package.json y package-lock.json.

## Cierre de una fase

Antes de marcar una fase como completada: ejecutar las verificaciones disponibles, revisar git diff y git status, actualizar la documentación y el changelog, crear un commit y anotar riesgos pendientes. No hacer push sin un remote conocido y autorización dentro del flujo de trabajo.
