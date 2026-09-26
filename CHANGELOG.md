## Crash Recovery / Pending Action Journal V1

### Added

- Journal local, versionado y acotado para propuestas de acciones allowlisted, con transiciones explícitas, confirmación no ejecutable y comandos CLI de revisión, posposición y descarte.
- Recuperación segura al inicio: registros que quedaron `executing` pasan a `reconciliation_required`; no se reintentan automáticamente.
- Escritura atómica con archivo temporal exclusivo, sincronización y rename; manejo no fatal de journal ausente, corrupto o con versión no soportada.

### Security / limitations

- El journal queda fuera del repositorio, limita tipo/payload, no almacena credenciales y no integra Calendar/Tasks ni ningún ejecutor externo.
- La confirmación solo cambia estado; nunca ejecuta una acción.
- V1 no agrega un flujo de usuario para crear acciones propuestas; se deja la API lista para productores locales futuros.

## Phase 8 — Browser DNS Rebinding Evidence Harness

### Added

- Harness experimental de Chromium para ejecutar dos lanzamientos separados contra `rebind.test`.
- Correlación de DNS sequence 1/2 con ventanas `request.timing()`, orden request 1 → DNS2 → request 2 y observación posterior del egress.
- Artefacto obligatorio de referencia de reloj cross-VM con `maxOffsetMs` aportado por el operador.
- Evidencia diferencial de `nftables` mediante `packetsBefore/After/Delta` y `bytesBefore/After/Delta`, con `internalHits=0`.

### Security / limitations

- `PASS` consolidado requiere evidencia DNS válida, dos requests target, timing browser utilizable, referencia de reloj, delta de egress positivo y correlación temporal estricta.
- El harness no implementa `BrowserProvider`, no usa routing Playwright como boundary y no modifica `src/`, dependencias ni políticas del host.
- 27/27 pruebas deterministas del clasificador pasan; las verificaciones generales del repositorio también pasan.
- La ejecución real en VirtualBox todavía no se ha realizado.
- ADR-012 permanece provisional en `decision-gate`.

### Status

- PR #29 revisado y mergeado a `main`; merge commit `30646455dd2b5ab2285cb931a9fa3e32dd88c323`.

## Phase 8 — DNS Rebinding Real Evidence

### Added

- Evidencia real y reproducible de DNS rebinding controlado dentro del laboratorio VirtualBox.
- Registro del cambio de `rebind.test` entre `1.1.1.1` y `10.20.0.1` y del bloqueo del intento a `10.20.0.1:22` en el boundary inferior.

### Status / limitations

- PR #28 revisado y mergeado a `main`; merge commit `e0dfefe36844f9c212828a4aeb78751cb42098a0`.
- `rebind.test` alternó realmente entre una IP pública y la IP privada de la Gateway; la resolución controlada es `PASS`.
- El intento de socket a `10.20.0.1:22` fue bloqueado y `nftables` registró 12 paquetes / 788 bytes `DROP` en la cadena `input`.
- La conectividad pública a través de la Gateway permanece `PASS`.
- Esto no demuestra DNS pinning del BrowserProvider, rebinding público ni validación de IP efectiva justo antes del socket.
- ADR-012 permanece provisional en `decision-gate`; no se implementan providers productivos.

## Phase 8 — Network/Host Isolation Capability Spike

### Added

- Spike documental para caracterizar capacidades observadas de Hyper-V, Windows Sandbox, Firewall, interfaces virtuales y WSL2.
- Registro explícito de límites de permisos y de la diferencia entre capacidad observada y evidencia real de aislamiento OS-level.

### Status / limitations

- PR #24 revisado y mergeado a `main`; merge commit `4ab2bf774fd2d276a824415117a8303eadbab8f8`.
- Las señales del sistema (`2009`, build `26200`, arquitectura de 64 bits y etiqueta `Pro`) se conservaron como inconsistentes; la identificación exacta del producto/versión queda `LIMITATION`.
- Se observaron señales de Hyper-V, Firewall, `vEthernet (Default Switch)` y WSL2, pero no se administraron VMs/switches, no se modificaron reglas ni se habilitaron features.
- Windows Sandbox no quedó confirmado, WSL2 no tiene distribución y no se obtuvo evidencia OS-level de aislamiento de red/filesystem/DNS/socket ni crash cleanup.
- ADR-012 permanece provisional en `decision-gate`; no se selecciona un mecanismo de aislamiento ni se inicia implementación productiva.

## Phase 8 — Internet & Browser consolidated ADR-012 decision-gate review

### Added

- Matriz consolidada de evidencia demostrada, parcial, simulada, limitada y pendiente en `docs/phase-08-decision-gate-review.md`.
- Revisión de las opciones proxy/egress, aislamiento de red/host, route + proxy, browser local y browser remoto sin puntuación ni selección definitiva.

### Status / limitations

- ADR-012 permanece provisional y en estado `decision-gate`.
- PR #23 revisado y mergeado a `main`; merge commit `c0ecf47a342f21cddddfb7a2c75905ae9b144698`.
- Se conserva el `FAIL` del redirect público → interno bajo `browserContext.route()`.
- HTTPS/TLS, DNS rebinding/pinning productivo, aislamiento OS/network, browser remoto, Search real y crash cleanup siguen pendientes o limitados por el entorno.
- No se implementaron providers productivos ni se añadieron dependencias.

## Phase 8 — Internet & Browser host isolation evidence

### Added

- Harness experimental para caracterizar contextos efímeros, storage, acceso `file://`, timeout, shutdown y cleanup temporal.
- Evidencia de ausencia de storage heredado entre contextos y eliminación verificada del árbol temporal.
- Registro separado de las limitaciones de filesystem/sandbox OS-level y crash cleanup.

### Status / limitations

- PR #22 revisado y mergeado a `main`; merge commit `3f736d864a94c3139eff70acdc9a5e18417623ae`.
- Resultado: `7 PASS`, `0 FAIL`, `2 LIMITATION`, `1 NOT EXECUTED`.
- El rechazo de `file://` es evidencia browser-level, no aislamiento OS-level.
- `chromiumSandbox=true` es una condición de lanzamiento; su efectividad OS-level permanece sin demostrar.
- Crash cleanup permanece `NOT EXECUTED / LIMITATION`.
- ADR-012 permanece provisional.

## Phase 8 — Internet & Browser HTTPS/TLS evidence

### Added

- Evaluación de la viabilidad de un fixture HTTPS/TLS reproducible con Playwright/Chromium ya provisionado.
- Registro explícito de la limitación del entorno para emitir y confiar un certificado X.509 efímero sin `ignoreHTTPSErrors`, cambios en trust store, shell/OpenSSL, APIs de proceso o dependencias adicionales.

### Status / limitations

- PR #21 revisado y mergeado a `main`; merge commit `0288137f8b0eb5601d4a84060cd1091ad9aaef18`.
- HTTPS público→HTTPS, HTTPS→HTTP, HTTPS→interno y CONNECT/WebSocket sobre TLS permanecen `NOT EXECUTED / LIMITATION`.
- Chromium inicia y cleanup normal pasa, pero esto no constituye evidencia de handshake TLS ni de egress HTTPS.
- ADR-012 permanece provisional y el decision-gate no se cierra.

## Phase 8 — Internet & Browser DNS/socket evidence

### Added

- Fixture DNS UDP local para observar resolución A controlada.
- Instrumentación de IP validada, IP efectiva y `socket.remoteAddress`.
- Verificación de bloqueo antes de abrir socket para el destino interno.
- Caso controlado `127.0.0.2 → 127.0.0.3` conservado como `SIMULATED`, sin presentarlo como DNS rebinding real.

### Status / limitations

- PR #20 revisado y mergeado a `main`; merge commit `88c49433ccf4922612c9eeafd7df32d947f35c18`.
- Resultado: `2 PASS`, `0 FAIL`, `0 NOT EXECUTED`, `1 SIMULATED`; `internalHits=[]`.
- La evidencia real está limitada al fixture local controlado; no demuestra DNS público cambiante, múltiples A/AAAA, pinning productivo ni aislamiento OS-level.
- HTTPS, browser remoto y crash cleanup seguro continúan pendientes.
- ADR-012 permanece provisional.

## Phase 8 — Internet & Browser experimental browser runtime provisioning

### Added

- Provisioning experimental del Chrome Headless Shell requerido por Playwright fuera del repositorio mediante `npx playwright install chromium-headless-shell`.
- Registro de disponibilidad local de Playwright `1.63.0` y Chrome Headless Shell `153.0.8010.12` con sandbox solicitado.

### Status / limitations

- PR #19 revisado y mergeado a `main`; merge commit `4e442e1669f2d199228e0ad7829f585f67b18c58`.
- Los harnesses browser disponibles fueron repetidos sin cambios en `src/`, manifests ni lockfiles.
- Se conserva el FAIL conocido del redirect público → interno bajo `browserContext.route()`.
- HTTPS, DNS/socket pinning real, browser remoto y crash cleanup seguro continúan sin evidencia suficiente; ADR-012 permanece provisional.
- El provisioning no constituye una dependencia productiva ni selecciona browser, proxy, sandbox o aislamiento definitivo.

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

## Phase 8 — Experimental Environment Readiness

### Added

- Checklist operativo para preparar una máquina o sesión dedicada antes de ejecutar la evidencia pendiente de Phase 8.
- Requisitos de entrada, separación host/entorno aislado, rollback, credenciales temporales y criterios de evidencia por prueba.

### Status / limitations

- PR #27 revisado y mergeado a `main`; merge commit `cdb70f5b6b61464e70492131e63818eacf827328`.
- No se habilitaron features, no se modificó Firewall, no se crearon VMs ni se instaló software.
- HTTPS/TLS, DNS rebinding/pinning real, aislamiento OS/network/filesystem, browser remoto, crash cleanup y Search real permanecen pendientes y requieren cumplir el gate de preparación correspondiente.
- ADR-012 permanece provisional en `decision-gate`.
- No se implementaron providers productivos ni cambios en `src/`.

## Phase 8 — Remaining Evidence Assessment

### Added

- Auditoría documental consolidada de los criterios restantes de ADR-012.
- Clasificación explícita de `PASS`, `FAIL`, `LIMITATION`, `NOT EXECUTED` y `SIMULATED` sin reclasificación.
- Identificación de requisitos para un entorno externo/dedicado capaz de ejecutar HTTPS/TLS, DNS rebinding/pinning real, aislamiento OS/network, browser remoto y crash cleanup.

### Status / limitations

- PR #26 revisado y mergeado a `main`; merge commit `197cd1c24b6b9499f9a96861c7b5902b2d0d8104`.
- No existe una prueba nueva segura y útil ejecutable en el entorno actual.
- HTTPS/TLS y Search permanecen bloqueados; DNS rebinding/pinning real, aislamiento OS/network y browser remoto requieren entorno externo/dedicado; crash cleanup no es ejecutable de forma segura en el entorno actual.
- Cleanup normal/timeout/shutdown permanece `PASS` controlado y no requiere repetición.
- ADR-012 permanece provisional en `decision-gate`.
- No se implementaron providers productivos ni cambios en `src/`.

## Phase 8 — Network/Host Isolation Evidence

### Added

- Registro documental de la ejecución de la etapa OS/network y del protocolo para un entorno aislado futuro.

### Status / limitations

- PR #25 revisado y mergeado a `main`; merge commit `d8d07c2a0eac845d593302e5ed19d19c71a12b3a`.
- Aislamiento OS/network real: `NOT EXECUTED`.
- Capacidades/permisos actuales: `LIMITATION`.
- No se produjeron nuevos `PASS` ni `FAIL`.
- DNS/socket conserva `SIMULATED`/`NOT EXECUTED`; no se presenta como pinning real.
- ADR-012 continúa provisional en `decision-gate`.
- No se implementaron providers productivos ni se modificó código de producción.

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
