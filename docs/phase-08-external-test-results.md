# Phase 8 — External Search and Browser Test Results

## Estado inicial y alcance

Esta rama ejecuta la batería externa controlada de Phase 8 desde `main`. No implementa `WebSearchProvider`, `WebFetchProvider` ni `BrowserProvider`, y no modifica `src/`.

Base: `main` actual en `3600e53240827cd1f475aa959889bc524105f246`
Rama: `phase/08-internet-browser-external-tests`
Fecha: 2026-09-18
Entorno: Windows, PowerShell, Node.js `v22.18.0`

La investigación oficial revisada antes de la ejecución cubre [Brave Search authentication](https://api-dashboard.search.brave.com/documentation/guides/authentication), [Tavily Search](https://docs.tavily.com/documentation/api-reference/endpoint/search), [Exa Search](https://exa.ai/docs/reference/search), [Playwright BrowserContext](https://playwright.dev/docs/api/class-browsercontext), [Playwright Service Workers](https://playwright.dev/docs/service-workers), [Playwright browsers](https://playwright.dev/docs/browsers) y [Playwright downloads](https://playwright.dev/docs/api/class-download).

## Dependencia experimental

Playwright `1.63.0` se utiliza únicamente dentro de `scripts/phase-08-external-tests/` porque es necesario para ejecutar un Chromium local y observar navegación, requests secundarios, WebSocket, Service Worker, downloads, uploads, timeout y cleanup. Se añadió exclusivamente como `devDependency` experimental; no se importa desde `src/` ni modifica contratos productivos.

La documentación oficial indica que los `BrowserContext` no persistentes no escriben datos de navegación persistentes, que `context.close()` debe ejecutarse explícitamente y que `browserContext.route()` no intercepta todas las solicitudes atendidas por Service Workers. La prueba conserva el sandbox habilitado y no añade flags para desactivarlo. El binario se instala en el caché externo de Playwright, no en el repositorio.

## Estados usados

- `EXECUTED`: la suite se ejecutó realmente.
- `PASS`: la comprobación ejecutada cumplió la expectativa.
- `FAIL`: la comprobación ejecutada no cumplió la expectativa.
- `NOT EXECUTED`: faltó credencial, entorno o dependencia/fixture necesaria.
- `LIMITATION`: la prueba tiene una frontera explícita y no demuestra una propiedad más fuerte.

## Search

Se reutiliza `scripts/phase-08-controlled-tests/search-corpus.json` con 20 consultas idénticas por provider.

| Provider | Estado | Motivo |
|---|---|---|
| Brave | `NOT EXECUTED` | `BRAVE_API_KEY` no estaba disponible localmente. |
| Tavily | `NOT EXECUTED` | `TAVILY_API_KEY` no estaba disponible localmente. |
| Exa | `NOT EXECUTED` | `EXA_API_KEY` no estaba disponible localmente. |
| SerpApi | `NOT EXECUTED` | Provider opcional y sin credencial. |

No se ejecutaron llamadas externas, por lo que no se inventan métricas, coste, 429, `Retry-After`, utilidad ni ranking. La métrica `relevant` del harness sigue siendo solo una heurística por dominio esperado o término textual; no es accuracy ni un score semántico definitivo.

## Browser local

Resultado de la ejecución: **19 comprobaciones; 17 `PASS`, 1 `FAIL`, 1 `NOT EXECUTED`**.

El harness debe usar:

- Chromium local efímero;
- contexto no persistente;
- directorio temporal dedicado para downloads y upload fixture;
- ningún perfil principal ni storage state persistente;
- cookies creadas solo dentro del contexto y verificadas antes del cierre;
- cierre explícito de context y browser en `finally`;
- sandbox habilitado, sin flags de desactivación.

Comprobaciones `PASS`:

- navegación local y contexto no persistente;
- bloqueo de imagen, script, stylesheet e iframe internos;
- bloqueo de `fetch`/XHR;
- observación y cierre de WebSocket;
- ausencia de accesos internos secundarios alcanzando el fixture (`internalHits=0` en esa suite);
- observación de comportamiento de Service Worker;
- download al directorio temporal allowlisted;
- upload del fixture temporal;
- timeout de navegación;
- cierre explícito de context/browser y desconexión observada;
- lanzamiento solicitado con `chromiumSandbox=true`, sin `--no-sandbox`;
- ausencia de perfil principal y de storage state.

Comprobación `FAIL` observada:

- `public redirect to internal is blocked`: el redirect alcanzó el fixture interno (`internalHits=1`) pese al routing configurado. El resultado es evidencia de que `browserContext.route()` no constituye por sí solo una política completa de egress/SSRF para redirects en este harness.

Comprobación `NOT EXECUTED`:

- crash cleanup: no se terminó ningún proceso arbitrariamente para simular un crash; solo se verificó cleanup normal y posterior a timeout.

## Egress y solicitudes secundarias

La prueba usa fixtures locales controlados. La navegación inicial al fixture local es una excepción explícita del harness; las solicitudes generadas por la página se evalúan mediante routing y se bloquean cuando su destino es loopback/interno. Esto permitió bloquear recursos secundarios, pero el redirect interno observado demuestra una limitación real del mecanismo. La evidencia no equivale a un proxy ni a aislamiento de red de producción.

Se deben registrar por separado navegación, redirects, imágenes, scripts, stylesheet, iframe, XHR/fetch, WebSocket y Service Worker. `browserContext.route()` no se considera una solución completa: la limitación de Service Worker se reporta como `LIMITATION` si el fixture demuestra que una solicitud no queda interceptada o si el comportamiento requiere un mecanismo de red inferior.

## DNS rebinding

La simulación controlada de DNS rebinding del harness anterior permanece válida, pero no es pinning real. Una prueba dinámica mediante socket, proxy o browser solo se marcará `EXECUTED` si existe un entorno aislado que permita demostrar la IP validada frente a la IP utilizada. De lo contrario se marcará `NOT EXECUTED` y se conservará la limitación explícita.

## Seguridad de datos y host

No se deben persistir API keys, Authorization headers, cookies, HTML completo, respuestas completas de Search ni prompts completos. El harness no debe usar shell ni APIs de procesos. No se debe abrir el perfil principal del usuario ni escribir fuera de directorios temporales allowlisted.

## Fetch, regresión y resultados finales

El harness existente de Fetch/SSRF/DNS se ejecutó con `PHASE_08_RUN_EXTERNAL=1` y reportó **29/29 `PASS`**. Brave, Tavily y Exa permanecieron `NOT EXECUTED` por ausencia de credenciales; SerpApi también quedó `NOT EXECUTED`.

La regresión del proyecto debe continuar reportando `98/98` tests. El resultado browser anterior no selecciona Playwright como decisión productiva: solo demuestra que el entorno pudo ejecutar un experimento local y que routing tiene una limitación observable frente a redirects. La estrategia definitiva debe permanecer abierta entre interception, proxy/egress gateway, aislamiento de red o combinación de mecanismos.

No se seleccionará provider, browser, sandbox ni estrategia de egress a partir de esta muestra pequeña. Search real, browser remoto, crash controlado seguro y DNS rebinding real siguen pendientes o `NOT EXECUTED`.

## Verificación técnica

- Harness existente (`PHASE_08_RUN_EXTERNAL=1`): Fetch `29/29 PASS`; Search Brave/Tavily/Exa `NOT EXECUTED` por falta de credenciales.
- Harness Browser local: `17 PASS`, `1 FAIL`, `1 NOT EXECUTED`; el `FAIL` es el redirect público → interno que alcanzó el fixture interno.
- `npm run build`: `PASS`.
- `npm run lint`: `PASS`.
- `npm run typecheck`: `PASS`.
- `npm test`: `98/98 PASS`.
- `npm run check`: `PASS`.
- `git diff --check`: `PASS`.

La dependencia añadida es `playwright@1.63.0` como `devDependency` experimental. No hay cambios en `src/`, no hay providers productivos, no hay BrowserProvider, no hay egress proxy y no hay integración con el asistente.

No se ejecutó browser remoto porque `BROWSER_REMOTE_ENDPOINT` y `BROWSER_REMOTE_TOKEN` no estaban disponibles. La prueba de crash cleanup quedó `NOT EXECUTED` para evitar terminación arbitraria de procesos. La prueba de DNS rebinding real quedó `NOT EXECUTED`; solo permanece la simulación controlada del harness anterior, que no demuestra pinning de socket/proxy/browser.
