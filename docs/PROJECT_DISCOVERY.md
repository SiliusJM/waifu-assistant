# Project Discovery

Fecha del diagnóstico: 2026-09-17.

## Resumen ejecutivo

La carpeta waifu-assistant existía como directorio vacío, sin código previo que preservar y sin repositorio Git inicializado. No se detectaron archivos de configuración del proyecto, secretos locales, tests, CI/CD ni dependencias instaladas dentro del proyecto.

Conclusión: Phase 0 comenzó desde una base limpia y pequeña. El remote origin ya está configurado y el checkpoint actual de main está publicado en https://github.com/SiliusJM/waifu-assistant.

## Entorno

- Sistema operativo: Windows, confirmado por el entorno PowerShell y las rutas del sistema.
- Node.js: v22.18.0.
- npm: 10.9.3.
- pnpm: 10.17.1.
- Python: 3.13.14.
- Git: 2.51.0.windows.1.
- VS Code: disponible en el perfil local de Microsoft VS Code.
- Codex: ejecutable disponible mediante la extensión local.
- gh, Docker, Rust, Go y yarn: no disponibles en la shell del diagnóstico.
- ESLint y Prettier: no disponibles globalmente.
- TypeScript: compilador global disponible, pero no se fija como dependencia de Phase 0.

## Repositorio y Git

- Ruta: C:\Users\SILIUS\Desktop\waifu-assistant.
- Antes de Phase 0 no existía .git.
- No existían ramas, commits ni remotes.
- La identidad Git global estaba configurada, sin que se registrara su valor en este documento.
- La configuración global indica master como rama por defecto; Phase 0 establece main para este repositorio.
- Remote origin: https://github.com/SiliusJM/waifu-assistant.git.
- La rama main y el checkpoint de Phase 0 fueron publicados correctamente en GitHub.

## Proyecto previo y archivos sensibles

No se encontraron AGENTS.md, README, package.json, lockfiles, archivos de configuración, workflows, tests, .env, .env.example, carpetas de build ni artefactos generados dentro del directorio.

El entorno del proceso expone una variable llamada OPENAI_API_KEY. Su valor no fue leído, impreso ni copiado al repositorio. El .gitignore y .env.example establecen la política para credenciales futuras.

## Hardware y limitaciones

Las consultas WMI para sistema operativo, CPU, RAM y GPU devolvieron Acceso denegado en este entorno administrado. No se inventan especificaciones de hardware. La evaluación de modelos locales, STT, TTS, RVC y avatar deberá recoger esos datos con un mecanismo autorizado cuando sea necesaria.

La conexión Git desde la shell falló al intentar contactar un host de prueba debido a la red/proxy del entorno. La investigación web de fuentes públicas sí estuvo disponible para la evaluación inicial de OmniRoute.

El runner de tests de Node con su aislamiento por workers falló con spawn EPERM en este entorno administrado. Los mismos tests pasan usando el modo explícito de aislamiento none, que quedó encapsulado en scripts/test.mjs.

## Herramientas disponibles para el proyecto

La base se mantiene deliberadamente sin dependencias externas. Node.js proporciona runtime, build de copia/validación y node:test. npm y pnpm quedan disponibles para fases posteriores. Python queda reservado para un servicio especializado de voz si la evidencia lo justifica.

## Observaciones arquitectónicas

El proyecto debe separar el núcleo de los proveedores y mantener una ruta determinista local para acciones simples. OmniRoute puede ser un adaptador opcional del proveedor de IA para llamadas complejas, con métricas y límites; no debe estar en el camino de comandos deterministas.
