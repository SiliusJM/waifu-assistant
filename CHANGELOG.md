## Phase 8 — Internet & Browser TLS fixture limitation

### Status / limitations

- PR #18 revisado y mergeado a `main`; merge commit `25985396222c8dc51db9f71b55606cf85aab2254`.
- No se creó fixture TLS inseguro.
- HTTPS público→HTTPS, HTTPS→HTTP, HTTPS→interno y WebSocket/CONNECT sobre TLS permanecen `NOT EXECUTED`.
- La viabilidad del fixture TLS queda documentada como `NOT EXECUTED`/`LIMITATION` debido a la ausencia de un mecanismo seguro y reproducible de emisión X.509 dentro del entorno actual.
- DNS/socket pinning continúa `SIMULATED`/`NOT EXECUTED`.
- No se añadieron dependencias, scripts, cambios en `src/`, manifests ni lockfiles.

## Phase 8 — Internet & Browser HTTPS + DNS/socket evidence

### Added

- Consolidación de la evidencia HTTPS/DNS pendiente sobre los harnesses existentes.
- Registro explícito de HTTPS como `NOT EXECUTED` y DNS/socket pinning como `SIMULATED`/`NOT EXECUTED` cuando no pudo demostrarse resolución y socket reales.

### Status / limitations

- PR #17 revisado y mergeado a `main`; merge commit `0183ab6c76379ccda90e9602df3ce13aab0c0225`.
- Service Worker permanece `PASS` en el fixture localhost.
- HTTPS público→HTTPS, HTTPS→HTTP y HTTPS→interno: `NOT EXECUTED`.
- DNS/socket pinning: `SIMULATED`/`NOT EXECUTED`; no se demuestra socket real.
- Browser remoto, crash cleanup, aislamiento OS-level/host y Search real continúan pendientes.
- ADR-012 permanece provisional; no se selecciona arquitectura productiva definitiva.
- No se implementaron providers productivos ni cambios en `src/`.

## Phase 8 — Internet & Browser architecture gate evidence

### Added

- Fixture ejecutable de Service Worker real en localhost atravesando el boundary de egress.
- Evidencia individual de request generada, observación por proxy, destino, bloqueo e `internalHits=0`.

### Status / limitations

- PR #16 revisado y mergeado a `main`; merge commit `068bef145b2a0092f806c98e0dfd623b54bb33c9`.
- Service Worker gate: PASS en el fixture localhost.
- HTTPS, DNS rebinding real/socket pinning, aislamiento OS-level/host, browser remoto, crash cleanup y Search real continúan pendientes.
- ADR-012 permanece provisional; todavía no se selecciona proxy, browser, sandbox ni aislamiento definitivo.
- No se implementaron providers productivos ni cambios en `src/`.

## Phase 8 — Internet & Browser architecture decision gate

### Added

- Matriz consolidada de evidencia restante y límites explícitos de Phase 8.
- Borrador de arquitectura con gate previo a producción.
- ADR-012 que establece una frontera de egress inferior como requisito obligatorio para cualquier BrowserProvider futuro.

### Status / limitations

- PR #15 revisado y mergeado a `main`; merge commit `8709da3cf3957f1f16163a9baecdff7ecb1c7cbd`.
- `browserContext.route()` queda descartado como boundary SSRF/egress único por el redirect público→interno observado.
- El proxy/egress boundary queda como candidato provisional respaldado por la evidencia, no como selección productiva.
- Service Worker real, HTTPS controlado, DNS rebinding real, browser remoto, aislamiento de red/host, crash cleanup seguro y Search con credenciales continúan pendientes.
- No se implementaron providers productivos ni cambios en `src/`.

## Phase 8 — Internet & Browser egress hardening

### Added

- Harness de hardening con evidencia independiente por canal para navegación, redirects, image, script, stylesheet, iframe, `fetch`/XHR y WebSocket.
- Resultados explícitos `PASS`/`FAIL`/`NOT EXECUTED`/`SIMULATED`, sin convertir ausencia de Service Worker, HTTPS, browser remoto o crash cleanup en éxito.
- Cleanup normal de BrowserContext, browser, proxy, fixture y directorio temporal verificado.

### Security / limitations

- Hardening: 14 PASS, 0 FAIL, 6 NOT EXECUTED y 1 SIMULATED; `internalHits=[]`.
- Service Worker: NOT EXECUTED porque Chromium no expuso `navigator.serviceWorker` para el origen controlado.
- HTTPS público→HTTPS, HTTPS→HTTP y HTTPS→interno: NOT EXECUTED por ausencia de fixture TLS reproducible.
- DNS rebinding: SIMULATED; no se afirma resolución real, pinning de socket ni protección completa.
- Browser remoto: NOT EXECUTED por falta de entorno/credenciales configurados.
- Crash cleanup: NOT EXECUTED; no se usaron APIs de terminación de procesos, shell ni `child_process`.
- El baseline con `browserContext.route()` conserva el FAIL conocido del redirect público → interno.

### Status

- PR #14 revisado y mergeado a `main`; merge commit `9dab02d72e710e691121da27489474d1ed4ccf3b`.
- No se añadieron cambios en `src/`, manifests, lockfiles, APIs de procesos ni código productivo.

# Changelog

## Phase 8 — Internet & Browser egress boundary spike

### Added

- Fixture de proxy/egress inferior al browser para probar navegación, redirects, subrecursos, `fetch`/XHR, WebSocket y clasificación de destinos.
- Evidencia de bloqueo de redirect público → interno con `internalHits=0`.
- Evidencia de bloqueo de WebSocket interno mediante `CONNECT`.

### Security / limitations

- Service Worker: NOT EXECUTED porque Chromium no expuso `navigator.serviceWorker` para el origen controlado.
- DNS rebinding: simulación controlada, no pinning real.
- El hostname `public.test` es una etiqueta controlada mapeada al fixture local; no demuestra aislamiento OS-level ni DNS público real.
- HTTPS→HTTP no fue ejecutado en el fixture HTTP-only.
- Aislamiento de red y combinación interception + proxy quedan abiertos.

### Status

- PR #13 revisado y mergeado a `main`; merge commit `cd22a2fd8f8b979c5ef32ecdb63f66ff50a94079`.
- Proxy/egress fixture: 19 PASS, 0 FAIL, 2 NOT EXECUTED; `internalHits=0`.
- No se integró egress proxy productivo ni BrowserProvider.

## Phase 8 — Internet & Browser external tests

### Added

- Harness externo de browser con Chromium/Playwright para navegación local efímera, solicitudes secundarias, WebSocket, Service Worker, downloads, uploads, timeout y cleanup.
- Uso experimental de `playwright@1.63.0` exclusivamente como `devDependency`.
- Evidencia de egress controlado con 17 PASS, 1 FAIL y 1 NOT EXECUTED.

### Security / limitations

- El redirect público → interno alcanzó el fixture interno a pesar de `browserContext.route()`; esto se conserva como evidencia de que routing no constituye por sí solo una frontera completa de egress/SSRF.
- Service Worker se mantiene como limitación de routing y no como aislamiento completo.
- `chromiumSandbox=true` se verificó como configuración de lanzamiento sin `--no-sandbox`; no se afirma efectividad OS-level del sandbox.
- Browser remoto, crash cleanup seguro y DNS rebinding real: NOT EXECUTED.
- Search Brave/Tavily/Exa: NOT EXECUTED por falta de credenciales.

### Status

- PR #12 revisado y mergeado a `main`; merge commit `4be0966603feeb97ad04cb86ea1f1c95f08d1d82`.
- Fetch/SSRF/DNS/policies: 29/29 PASS.
- No se integraron BrowserProvider, providers Search, egress proxy ni código de producción.

## Phase 8 — Internet & Browser controlled tests

### Added

- Harness reproducible para el corpus de 20 consultas Search y futuras ejecuciones con credenciales opt-in.
- Fixtures controlados para Fetch, redirects, timeout, cancelación, límites de respuesta y clasificación de destinos.
- Policies explícitas para tipos de contenido, workspace, downloads/uploads y path traversal.
- Validación controlada de SSRF, múltiples A/AAAA, IPv4-mapped IPv6, redirects a destinos internos y simulación de DNS rebinding.
- Reporte de resultados y límites de la evidencia sin afirmar browser pinning ni egress real.

### Status

- PR #11 revisado y mergeado a `main`; merge commit `35045dcf9bcd9ff6b31c9bb7908af7872daae5a3`.
- Fetch/SSRF/DNS/policies: 29/29 PASS.
- Brave/Tavily/Exa: NOT EXECUTED por falta de credenciales.
- Browser local/remoto: NOT EXECUTED por falta de entorno/dependencias.
- No se integraron providers, browser automation, dependencias ni código de producción.
