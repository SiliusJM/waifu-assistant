# Phase 8 — Consolidated ADR-012 decision-gate review

## 1. Resumen ejecutivo

Esta revisión consolida la evidencia disponible de Phase 8 sobre egress, browser, DNS/socket, TLS y aislamiento host/browser. La base revisada es `origin/main` en `b44c90cb9d5e96713dc63b6d2eed44f3e72163e7`.

ADR-012 permanece provisional y en estado `decision-gate`. La evidencia respalda exigir una frontera de egress inferior al browser y demuestra resultados positivos en fixtures locales controlados, pero no permite seleccionar todavía un proxy, gateway, browser, sandbox, aislamiento de red ni provider productivo.

La evidencia negativa más importante se conserva: el baseline con `browserContext.route()` obtuvo `17 PASS`, `1 FAIL` y `1 NOT EXECUTED`; el redirect público→interno alcanzó el fixture interno (`internalHits=1`). El proxy/egress fixture bloqueó navegación, redirects, subrecursos, fetch/XHR y WebSocket con `internalHits=0`, pero esa evidencia no equivale a aislamiento de red del host.

El Service Worker tiene un `PASS` real dentro de un fixture localhost específico, con request observada, bloqueo e `internalHits=0`; la cobertura no se considera generalizada hasta confirmarla para el browser/provider elegido. La ejecución browser con NetLog observó DNS rebinding real y el segundo endpoint TCP `10.20.0.1:80`, pero queda `REAL / OBSERVED + LIMITATION`: no demuestra egress formal, `internalHits=0`, correlación cross-VM formal ni pinning productivo. Chromium está disponible y el host/browser harness demostró contexto efímero, storage limpio entre contextos y cleanup normal/timeout/shutdown; filesystem y sandbox OS-level son `LIMITATION` y crash cleanup es `NOT EXECUTED`.

## 2. Matriz de evidencia

Estados usados: `PASS`, `FAIL`, `SIMULATED`, `LIMITATION` y `NOT EXECUTED`. `PASS` siempre está acotado al entorno y fixture descritos.

| Criterio | Evidencia | Estado | Tipo de evidencia | Limitación | Impacto en la decisión |
|---|---|---|---|---|---|
| Fetch/SSRF/DNS y policies de URL | 29/29 checks del harness controlado, incluyendo destinos internos, redirects, MIME, workspace y cancelación | `PASS` | Reproducible controlada | No demuestra browser, socket productivo ni aislamiento del host | Confirma policies base; no cierra egress productivo |
| `browserContext.route()` para secundarios | Observó/bloqueó varios secundarios en el fixture | `PASS` | Parcial/controlada | No cubre todos los caminos de red | Solo observabilidad/rechazo temprano |
| `browserContext.route()` como boundary único | Redirect público→interno alcanzó el fixture; `internalHits=1` | `FAIL` | Negativa reproducible | Resultado específico del baseline | Descarta routing como defensa única |
| Proxy/egress: navegación | Proxy observó y bloqueó navegación interna; `internalHits=0` | `PASS` | Parcial/controlada | Proxy y destino son fixtures locales | Respalda una frontera inferior como requisito |
| Proxy/egress: redirects | Redirects públicos→internos fueron revalidados y bloqueados | `PASS` | Parcial/controlada | No cubre TLS ni browser remoto | Apoya validación por salto |
| Proxy/egress: image, script, stylesheet, iframe y fetch/XHR | Evidencia individual por canal, sin conexiones internas | `PASS` | Parcial/controlada | No es aislamiento OS/network | Exige cobertura inferior a todos los subrecursos |
| Proxy/egress: WebSocket | `CONNECT` observado y bloqueado; `internalHits=0` | `PASS` | Parcial/controlada | No prueba todos los transportes/providers | Requiere política para túneles |
| Service Worker en fixture localhost | Request real observada por proxy, destino interno bloqueado e `internalHits=0` | `PASS` | Parcial/controlada | Debe confirmarse para provider/browser elegido; otro fixture no pudo ejecutarlo | Evidencia favorable, no cierre general |
| DNS/socket `public.test` | DNS local → IP validada `127.0.0.2` → IP efectiva → `socket.remoteAddress=127.0.0.2` | `PASS` | Real dentro de fixture local | No es DNS público ni destino público real | Demuestra instrumentación local, no pinning productivo |
| Bloqueo previo a socket interno | `internal.test` → `127.0.0.3`, sin socket ni `internalHits` | `PASS` | Real dentro de fixture local | No demuestra host firewall ni red productiva | Confirma fail-closed local |
| DNS rebinding | Cambio controlado `127.0.0.2` → `127.0.0.3`, bloqueado tras revalidación | `SIMULATED` | Simulada/controlada | No es resolver público, múltiples A/AAAA ni pinning real | No permite cerrar anti-rebinding |
| Browser DNS rebinding con NetLog (2026-09-22) | Primer endpoint `1.1.1.1:80`; segundo endpoint `10.20.0.1:80` observado por NetLog y timeout real | `REAL / OBSERVED + LIMITATION` | Observación real, no consolidación formal | Faltan fresh clock reference, DNS JSON formal, egress JSON formal e `internalHits=0`; no demuestra pinning productivo ni seguridad de todos los canales | Documenta el comportamiento observado sin cerrar el gate |
| HTTPS→HTTPS, HTTPS→HTTP, HTTPS→interno | No existe certificado X.509 efímero confiable y reproducible bajo las restricciones | `NOT EXECUTED` | Limitada por entorno | No hubo handshake ni egress TLS observado | Gate TLS permanece abierto; no es fallo del boundary |
| CONNECT/WebSocket sobre TLS | Sin fixture TLS confiable | `NOT EXECUTED` | Limitada por entorno | No se observó handshake TLS | Pendiente junto con fixture TLS |
| Playwright/Chromium disponible | Playwright `1.63.0`; Chromium `153.0.8010.12` inició fuera del repositorio | `PASS` | Runtime experimental | Disponibilidad no selecciona dependencia productiva | Permite nuevos experimentos |
| Perfil/contexto efímero y storage | Contextos nuevos no heredaron cookies ni `localStorage`; sin perfil principal ni storage state | `PASS` | Reproducible controlada | No cubre perfiles cargados explícitamente por un provider | Define una condición mínima de ejecución local |
| Acceso `file://` desde página HTTP | El browser rechazó `fetch(file://...)` al marcador temporal fuera de `workspace` | `PASS` | Browser-level controlada | No prueba permisos OS-level del proceso | Evidencia acotada, no aislamiento del host |
| Filesystem OS-level | No se realizó prueba de escape/aislamiento del sistema operativo | `LIMITATION` | Limitada por frontera del harness | La configuración browser-only no basta | Requiere entorno de aislamiento del host |
| Sandbox OS-level | `chromiumSandbox=true` sin `--no-sandbox` | `LIMITATION` | Configuración observable | No demuestra efectividad OS-level en Windows | No puede usarse como prueba de sandbox efectivo |
| Cleanup normal, timeout y shutdown | Context/browser/fixture/directorios temporales cerrados y eliminados | `PASS` | Reproducible controlada | No equivale a crash cleanup | Confirma cleanup cooperativo |
| Crash cleanup | No se ejecutó por prohibición de terminación arbitraria de procesos | `NOT EXECUTED` | Deliberadamente no ejecutada | Falta método seguro en este entorno | Permanece criterio abierto |
| Browser remoto | No hay endpoint ni credenciales temporales | `NOT EXECUTED` | Requiere otro entorno | No se solicitaron secretos | No respalda opción local ni remota |
| Search Brave/Tavily/Exa | Sin credenciales temporales; cero llamadas reales | `NOT EXECUTED` | Requiere credenciales | No hay métricas de calidad, coste o rate limit | Provider Search permanece abierto |
| Aislamiento de red/host | Solo proxy fixture; no aislamiento inferior del SO ejecutado | `NOT EXECUTED` | Requiere otro entorno | `internalHits=0` del proxy no prueba red del host | No se puede seleccionar arquitectura definitiva |

## 3. Controles ya demostrados

- Las policies controladas de Fetch/SSRF/DNS rechazan destinos internos, esquemas no permitidos, redirects inseguros, MIME no permitido y targets de workspace fuera de allowlist.
- `browserContext.route()` no es suficiente como boundary único; el redirect público→interno observado se mantiene como `FAIL` deliberado.
- Un proxy/egress fixture inferior al browser revalida navegación y redirects, observa solicitudes secundarias y bloquea image, script, stylesheet, iframe, fetch/XHR y WebSocket con `internalHits=0`.
- El fixture localhost del gate produjo una request real de Service Worker, fue observado por el proxy y bloqueado con `internalHits=0`. Esta evidencia es específica de ese fixture y no sustituye confirmación para un provider futuro.
- El fixture DNS/socket observó la cadena hostname controlado → resolución → IP validada → IP efectiva → socket y bloqueó el destino interno antes de abrir socket.
- La ejecución browser con NetLog observó el primer endpoint `1.1.1.1:80`, el segundo endpoint `10.20.0.1:80` y un timeout real. Es evidencia `REAL / OBSERVED + LIMITATION`; no aporta por sí sola egress artifact, `internalHits=0`, correlación temporal cross-VM formal, pinning productivo ni seguridad de todos los canales.
- Playwright/Chromium puede iniciar en contexto efímero. El harness de host/browser comprobó storage no heredado, ausencia de perfil principal, `file://` inaccesible desde una página HTTP, timeout, shutdown y cleanup normal.
- No se han introducido providers productivos, browser automation integrada al producto, credenciales, shell ni APIs de procesos.

## 4. Controles todavía no demostrados

### Requieren otro entorno

- Aislamiento OS-level de filesystem, red y host en Windows.
- Browser remoto o servicio independiente con egress y cleanup observables.
- Crash cleanup reproducible sin APIs de terminación arbitraria.
- Consolidación formal del DNS rebinding browser con resolver/egress reales, múltiples A/AAAA, fresh clock reference, `internalHits=0` y cambios de respuesta controlados.

### Requieren credenciales temporales

- Ejecución real de Brave, Tavily y Exa sobre el corpus de 20 consultas, con calidad, p50/p95, errores, coste y rate limits.

### Requieren fixture TLS

- HTTPS→HTTPS, HTTPS→HTTP, HTTPS→interno y CONNECT/WebSocket sobre TLS.
- No se trata de un fallo del boundary: el fixture no puede ejecutarse sin certificado confiable y reproducible bajo las restricciones actuales.

### Requieren aislamiento OS/network

- Diferenciar bloqueo del proxy fixture de la política efectiva del host.
- Demostrar que ningún canal browser puede alcanzar red interna si evita interception.
- Medir cleanup de sockets/procesos ante fallos reales y operación Windows.

### Deliberadamente no ejecutados por seguridad

- Crash simulado mediante `child_process`, `spawn`, `exec`, shell, PowerShell o terminación arbitraria.
- Uso de perfil principal, credenciales reales, trust store modificado, `ignoreHTTPSErrors` o certificados estáticos.

### Limitaciones que requieren otro entorno y no deben reinterpretarse como fallos del boundary

La ausencia de un fixture TLS confiable, de un entorno OS/network aislado, de un browser remoto o de un método seguro de crash cleanup es una limitación de capacidad experimental. No constituye por sí sola un `FAIL` del boundary. Estos casos siguen siendo bloqueantes para cerrar el gate de producción, pero no se convierten en evidencia negativa de una arquitectura que todavía no fue ejecutada.

## 5. Opciones arquitectónicas

No se asigna puntuación, ranking ni ganador.

| Opción | Evidencia actual | Falta por demostrar | Riesgos, coste y operación |
|---|---|---|---|
| Proxy/egress boundary | Mejor evidencia experimental: redirects, secundarios y WebSocket bloqueados con observabilidad e `internalHits=0` | TLS, DNS/socket real completo, Service Worker general, host isolation, remoto | Añade componente operativo y latencia; requiere lifecycle, cancelación y observabilidad robustos en Windows |
| Aislamiento de red/host | Ninguna ejecución directa | Egress real, filesystem, sandbox, cleanup y compatibilidad Windows | Mayor complejidad de despliegue y diagnóstico; puede reducir bypasses si se demuestra |
| Route + proxy | Route aporta observabilidad; proxy aporta frontera inferior en fixtures separados | Configuración integrada, bypasses, coherencia de políticas y coste de doble control | Complejidad adicional; route no debe asumir autoridad de seguridad |
| Browser local | Runtime disponible, contexto efímero, storage limpio y cleanup normal | OS sandbox efectivo, filesystem/red host, crash cleanup, TLS | Menor latencia potencial, pero mayor superficie local y responsabilidad del host |
| Browser remoto | No ejecutado | Egress remoto, credenciales, aislamiento, coste, latencia y cleanup | Reduce superficie local potencial, pero añade servicio, red, autenticación y dependencia operacional |
| Combinación de controles | Es compatible conceptualmente con la evidencia actual | Prueba integrada y límites de interacción | Puede mejorar defensa en profundidad, pero aumenta complejidad, latencia y superficies de fallo |

La evidencia actual respalda mantener una frontera inferior obligatoria como gate, no escoger todavía qué implementación concreta la materializará.

## 6. Criterios de cierre del gate

| Condición | Evidencia requerida | Disponible actualmente | Condición de cierre |
|---|---|---|---|
| Service Worker interno bloqueado | Request generada, observada, destino efectivo bloqueado e `internalHits=0` en el browser/provider elegido | `PASS` en fixture localhost; cobertura general aún parcial | Repetir en el runtime/provider candidato y conservar evidencia por canal |
| HTTPS y downgrade | Handshake HTTPS→HTTPS, política explícita HTTPS→HTTP y bloqueo HTTPS→interno | `NOT EXECUTED`/`LIMITATION` | Fixture TLS confiable, sin bypass, con observación de IP/socket y resultados individuales |
| DNS y pinning | Múltiples A/AAAA, cambio de resolución, IP validada, IP efectiva y socket realmente usado | Fixture local `PASS`; browser NetLog `REAL / OBSERVED + LIMITATION` | Evidencia formal de resolver/egress real, clock cross-VM suficiente y mismatch bloqueado antes de conexión |
| Egress completo | `internalHits=0` individual para navegación, redirects, subrecursos, fetch/XHR, WebSocket y Service Worker | PASS controlado para canales ejecutados; route baseline `FAIL` | Repetir en el mecanismo elegido y resolver los canales no ejecutados |
| Aislamiento local/remoto | Filesystem, credenciales, sandbox y red del modo elegido | Storage y browser-level `PASS`; OS/network `LIMITATION`/`NOT EXECUTED` | Entorno de aislamiento demostrable, con límites y controles Windows documentados |
| Cleanup | Normal, timeout, shutdown y crash seguro | Normal/timeout/shutdown `PASS`; crash `NOT EXECUTED` | Evidencia reproducible de crash cleanup sin mecanismos inseguros |
| Operación | Cancelación, latencia, coste, observabilidad y comportamiento Windows | Parcial en fixtures; sin benchmark productivo | Medición comparable en la arquitectura candidata, sin secretos persistidos |
| Separación de autoridad | WebData no autoritativo, permisos, ausencia de shell/proceso y logs seguros | Policies controladas y regresión del repositorio `PASS` | Mantener los invariantes en cualquier prototipo posterior |

El gate no se cierra mientras permanezca pendiente cualquiera de las condiciones que afectan egress efectivo, TLS, pinning, aislamiento o cleanup inesperado.

## 7. Conclusión

ADR-012 sigue provisional. La observación browser NetLog cierra esta subetapa experimental como `REAL / OBSERVED + LIMITATION`, pero no satisface el contrato formal de egress/pinning. Queda bloqueada la implementación productiva de `WebSearchProvider`, `WebFetchProvider` y `BrowserProvider`, así como la selección definitiva de proxy, gateway, browser local/remoto, Playwright productivo, sandbox o aislamiento de red.

Puede continuarse sin producción con experimentos documentales y fixtures aislados: obtener un mecanismo seguro de certificado efímero, preparar un entorno OS/network aislado, repetir DNS/socket y Service Worker para el runtime candidato, ejecutar Search solo con credenciales temporales y definir mediciones comparables. Ningún resultado pendiente debe convertirse en `PASS` por ausencia de fallo observado.
