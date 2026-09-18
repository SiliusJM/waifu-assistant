# Changelog

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
