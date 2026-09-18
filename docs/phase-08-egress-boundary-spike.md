# Phase 8 — Browser Egress Boundary Spike

## Estado y alcance

Este spike estudia una frontera de egress inferior al navegador para Phase 8. Se ejecutó en la rama `phase/08-internet-browser-egress-boundary-spike`, sobre `origin/main` en `b7b533926685b708f1e63d0388e6c74ea3f22b11`, con Windows, PowerShell y Node.js `v22.18.0`.

El spike no implementa `BrowserProvider`, `WebFetchProvider`, `WebSearchProvider`, `ToolManager` ni integración con `AssistantCore`. El único código nuevo está en `scripts/phase-08-egress-boundary-spike/` y es un fixture experimental local. No modifica `src/`, no añade APIs de procesos, no usa shell y no introduce browser automation productiva.

La evidencia se limita a fixtures locales controlados. `public.test` es una etiqueta de prueba que el proxy mapea al fixture local; no representa DNS público ni demuestra aislamiento de red del sistema operativo.

## Estados y criterio de seguridad

- `PASS`: la comprobación ejecutada cumplió la expectativa.
- `FAIL`: una comprobación ejecutada no cumplió la expectativa. Un acceso interno real es `FAIL`, no `LIMITATION`.
- `NOT EXECUTED`: la capacidad o entorno necesario no estuvo disponible.
- `LIMITATION`: la prueba tiene una frontera explícita y no demuestra una propiedad más fuerte.
- `SIMULATED`: comportamiento modelado en el fixture, no una prueba de red real.

La condición principal del experimento es que una navegación pública no autoriza solicitudes secundarias hacia redes internas. Cada solicitud observada por el proxy registra únicamente metadatos seguros: método, host, ruta, protocolo, clasificación del destino, si pasó por el boundary y si fue bloqueada. No se registran headers de autorización, cookies, cuerpos ni contenido completo.

## Mecanismos comparados

| Mecanismo | Evidencia disponible | Limitaciones | Estado de esta etapa |
|---|---|---|---|
| `browserContext.route()` / interception | La ejecución externa anterior obtuvo `17 PASS`, `1 FAIL`, `1 NOT EXECUTED`; el redirect público→interno alcanzó el fixture (`internalHits=1`). | El routing del contexto no constituye por sí solo un egress boundary completo; debe considerarse el comportamiento de redirects, Service Workers y otros caminos de red. | Evaluado como baseline; no recomendado como control único. |
| Proxy/egress gateway inferior | Fixture HTTP local ejecutado mediante `scripts/phase-08-egress-boundary-spike/run.mjs`. Bloqueó loopback, redirects internos, recursos secundarios, `fetch` y el túnel `CONNECT` del WebSocket; `internalHits=0`. | Sigue siendo un proxy de prueba. No demuestra pinning real de sockets, aislamiento del host ni control de un browser remoto. | Ejecutado experimentalmente; no es decisión productiva. |
| Aislamiento de red inferior al proceso | No se ejecutó. | Requiere entorno aislado y controles específicos de Windows/host, además de evidencia de egress efectivo. | `NOT EXECUTED`. |
| Combinación interception + proxy/aislamiento | No se ejecutó como configuración integrada. | Debe probarse si la intercepción agrega observabilidad sin convertirse en la única barrera. | `NOT EXECUTED`. |

No se elige ganador. La decisión posterior debe basarse en egress efectivo, aislamiento, cleanup, latencia, operación en Windows, browser remoto y capacidad de demostrar la IP realmente utilizada.

## Harness de proxy inferior

El fixture crea un servidor público controlado, destinos internos y un proxy local. Las solicitudes HTTP pasan por una política que clasifica el destino efectivo y bloquea por defecto:

- loopback;
- redes privadas/RFC1918;
- link-local;
- multicast;
- unspecified;
- rangos reservados o de documentación;
- el hostname controlado de DNS rebinding cuando su destino efectivo es interno.

Para un destino permitido del fixture, el proxy reenvía únicamente al servidor local controlado. Para un destino bloqueado devuelve rechazo explícito y no abre conexión al fixture interno. El handler `CONNECT` registra y rechaza el túnel interno; en esta versión el navegador expresó el WebSocket mediante `CONNECT`, no mediante un evento `UPGRADE` HTTP.

El harness conserva un registro de observaciones y un contador independiente de conexiones internas. La prueba falla si un destino interno alcanza el fixture, incluso cuando el navegador haya mostrado una navegación pública válida.

## Casos ejecutados

Resultado de `node scripts/phase-08-egress-boundary-spike/run.mjs`:

| Caso | Resultado | Evidencia |
|---|---|---|
| Navegación pública | `PASS` | `public.test/page` pasó por el proxy y llegó al fixture público. |
| Redirect público→público | `PASS` | Terminó en `/page` mediante el proxy. |
| Redirect público→interno | `PASS` | Se observó `/internal/redirect-target` bloqueado; `internalHits=0`. |
| Redirect público→loopback | `PASS` | El destino loopback fue bloqueado; no alcanzó el fixture. |
| Cadena pública de redirects | `PASS` | Cadena `n=2` terminó en `redirect-chain?n=0` sin salir del proxy. |
| Loop de redirects | `PASS` | El timeout del navegador acotó el loop. |
| Imagen interna | `PASS` | `/internal/image.png` bloqueado; `internalHits=0`. |
| Script interno | `PASS` | `/internal/script.js` bloqueado; `internalHits=0`. |
| Stylesheet interno | `PASS` | `/internal/style.css` bloqueado; `internalHits=0`. |
| Iframe interno | `PASS` | `/internal/frame.html` bloqueado; `internalHits=0`. |
| `fetch`/XHR interno | `PASS` | `/internal/fetch.json` bloqueado; `internalHits=0`. |
| WebSocket interno | `PASS` | El proxy observó y bloqueó `CONNECT` a loopback; `upgrades=0`. |
| Service Worker hacia interno | `NOT EXECUTED` | Chromium no expuso `navigator.serviceWorker` para el origen controlado. No se presenta como evidencia de bloqueo. |
| Destino DNS efectivo interno | `PASS` | `rebind.test` fue clasificado como `effective-internal` y bloqueado. |
| Conexiones internas por bypass | `PASS` | `internalHits=0` para navegación, redirects, subrecursos, `fetch` y WebSocket. |
| Bypass Service Worker | `NOT EXECUTED` | Requiere un fixture/origen que permita ejecutar Service Workers en este entorno. |

Totales del harness: **21 comprobaciones; 19 `PASS`, 0 `FAIL`, 2 `NOT EXECUTED`**. La salida tuvo `internalHits=[]`. Los `NOT EXECUTED` no se convierten en éxito y quedan visibles en el reporte.

## Redirects y destinos internos

La prueba demostró que el proxy inferior vuelve a evaluar el destino del redirect y bloquea la solicitud a loopback. Esto cubre la diferencia observada en el baseline de `browserContext.route()`: una validación de la URL inicial no basta.

No se ejecutó todavía una prueba real de HTTPS→HTTP porque el proxy de este fixture solo implementa transporte HTTP local. La política definitiva debe decidir si ese downgrade se bloquea por contrato y probarlo con TLS controlado.

## Solicitudes secundarias y bypasses

La página pública intentó crear solicitudes hacia loopback desde stylesheet, script, imagen, iframe, `fetch` y WebSocket. El proxy recibió y bloqueó esos destinos; ninguno llegó al fixture interno. El WebSocket fue observado como `CONNECT`, por lo que no se puede deducir que todos los providers expresen el tráfico de la misma manera.

La rama Service Worker quedó `NOT EXECUTED`, no `PASS`. La documentación oficial de Playwright advierte que el routing de contexto no intercepta necesariamente solicitudes atendidas por Service Workers; cualquier solución futura debe probar ese camino y otros mecanismos que puedan evitar la intercepción. Un resultado válido de navegación principal no demuestra el egress de subrecursos.

## DNS y DNS rebinding

El caso `rebind.test` es una simulación controlada: el clasificador expone una dirección validada pública y una dirección efectiva interna, y el proxy rechaza el destino interno. Está marcado como `SIMULATED`/`LIMITATION` conceptual y **no demuestra pinning real** entre resolución DNS, proxy, socket o browser.

Quedan pendientes una resolución controlada con múltiples A/AAAA, cambios temporales de respuesta, comparación entre IP validada e IP realmente usada y una prueba con socket/proxy/browser real. No se debe afirmar que el spike implementa protección completa contra DNS rebinding.

## Browser local y perfil

El experimento solicita un Chromium efímero con contexto no persistente, sandbox habilitado y un directorio temporal dedicado. No usa el perfil principal del usuario ni storage state persistente. El cleanup normal de browser, proxy, fixture y directorio temporal se ejecuta en `finally`.

Este spike no ejecutó un crash controlado ni aislamiento de filesystem/host de producción. En Windows todavía debe medirse qué aislamiento real proporciona el browser local, cómo se limpian sockets y procesos tras timeout/crash y qué controles adicionales necesita un despliegue productivo. No se desactivó el sandbox para facilitar la prueba.

## Decisiones propuestas y abiertas

### Propuestas basadas en evidencia

- `browserContext.route()` no debe ser el único control de SSRF/egress.
- Todo provider de browser debe aplicar la política al destino efectivo de navegación, redirects, subrecursos, `fetch`/XHR y WebSocket cuando exista soporte.
- El boundary debe observar conexiones internas reales y fallar si `internalHits > 0`.
- Los resultados Service Worker deben permanecer `NOT EXECUTED` hasta disponer de un fixture ejecutable; no deben presentarse como prueba de seguridad.
- La política debe revalidar cada redirect y separar la IP validada de la IP realmente utilizada.

### Decisiones todavía abiertas

- proxy/egress gateway, aislamiento de red, interception complementaria o combinación;
- browser local aislado, servicio independiente self-hosted o browser remoto/BaaS;
- implementación de resolución y pinning contra múltiples A/AAAA y DNS rebinding;
- política definitiva para HTTPS→HTTP, WebSockets y Service Workers;
- límites de redirects, timeout, respuesta, páginas, operaciones y downloads/uploads;
- estrategia de sandbox y controles adicionales específicos de Windows;
- provider de browser y operación remota.

## Dependencias y límites del cambio

Playwright ya estaba presente en `package.json` como `devDependency` experimental de Phase 8. Este spike no añade ni cambia dependencias, no importa Playwright desde `src/` y no integra browser automation al producto. No se selecciona Playwright como decisión productiva.

No se implementan providers, ToolManager, `AssistantCore`, `WebFetchProvider`, egress proxy productivo, sandbox productivo, UI, Electron/Vue, persistencia, credenciales, downloads/uploads productivos ni APIs de procesos.

## Verificaciones ejecutadas

El nuevo harness registra por observación el método, destino detectado, decisión del boundary, bloqueo y si el fixture interno recibió una conexión asociada. Su ejecución final produjo **21 comprobaciones: 19 `PASS`, 0 `FAIL`, 2 `NOT EXECUTED`**, con `internalHits=0`.

Se repitieron el harness controlado de Fetch/SSRF/DNS, el harness externo existente, la regresión del proyecto y:

- `npm run build`;
- `npm run lint`;
- `npm run typecheck`;
- `npm test`;
- `npm run check`;
- `git diff --check`.

Resultados de esta ejecución:

- `node scripts/phase-08-controlled-tests/run.mjs`: Fetch **29/29 `PASS`**; Brave, Tavily, Exa y SerpApi `NOT EXECUTED` por falta de credenciales o por no estar solicitado.
- `node scripts/phase-08-external-tests/run-browser.mjs`: **17 `PASS`, 1 `FAIL`, 1 `NOT EXECUTED`**; conserva el `FAIL` conocido del redirect público→interno que alcanzó el fixture bajo routing.
- `node scripts/phase-08-egress-boundary-spike/run.mjs`: **19 `PASS`, 0 `FAIL`, 2 `NOT EXECUTED`**; Service Worker quedó sin ejecutar porque Chromium no expuso `navigator.serviceWorker` en el origen controlado.
- `npm run build`: `PASS`.
- `npm run lint`: `PASS`.
- `npm run typecheck`: `PASS`.
- `npm test`: **98/98 `PASS`**.
- `npm run check`: `PASS`.
- `git diff --check`: `PASS`.

La dependencia de Playwright no cambió en este commit. `src/`, `package.json`, `package-lock.json` y `pnpm-lock.yaml` no fueron modificados. La búsqueda del diff no encontró `node:child_process`, `child_process`, `spawn`, `powershell`, `cmd.exe` ni configuración de shell nueva.

La prueba externa anterior mantiene `Fetch 29/29 PASS`, Search sin credenciales (`NOT EXECUTED`) y browser local `17 PASS`, `1 FAIL`, `1 NOT EXECUTED`; el `FAIL` del redirect interno es precisamente la evidencia que motivó este spike.
