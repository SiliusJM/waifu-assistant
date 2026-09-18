# Phase 8 — Network/Host Isolation Evidence

## Estado

`NOT EXECUTED` / `LIMITATION`. Esta rama define el experimento OS/network real y registra por qué no se ejecutó en el entorno actual. No convierte señales de capacidad, el proxy fixture ni la simulación DNS en evidencia de aislamiento.

Base de la rama: `origin/main` en `32bd0e1919b2650f9b19f438788c781ce08e2cf4`.

## 1. Objetivo

Obtener evidencia reproducible de un browser ejecutándose dentro de un límite OS/network real, con egress controlado por debajo del browser, relación entre hostname, resolución DNS, IP validada, IP efectiva y socket, filesystem limitado, ausencia de credenciales del host y cleanup verificable.

El experimento futuro debe separar explícitamente la evidencia real de las comprobaciones browser-only y de las simulaciones ya documentadas.

## 2. Entorno inspeccionado

Las comprobaciones realizadas en esta etapa fueron de solo lectura:

- `origin/main` se encuentra en `32bd0e1919b2650f9b19f438788c781ce08e2cf4`.
- La sesión actual no pertenece al grupo de administradores y las consultas administrativas de Hyper-V fueron rechazadas por permisos.
- Se observaron señales de Hyper-V: cmdlets disponibles, servicios relacionados en ejecución y un adaptador `vEthernet (Default Switch)`. Esto no demuestra que exista una VM o una red aislada utilizable.
- `WindowsSandbox.exe` no está presente en la ruta consultada y el estado de la feature no pudo verificarse sin elevación.
- `wsl.exe` reporta versión predeterminada 2, pero no hay una distribución instalada.
- Playwright `1.63.0` y Chromium `153.0.8010.12` pueden iniciar en el host con `chromiumSandbox=true`, sin perfil principal ni `ignoreHTTPSErrors`. Esto solo demuestra disponibilidad del runtime local.

No se habilitaron features, no se crearon VMs o switches, no se modificó Firewall, no se cambiaron rutas/DNS/NAT, no se instalaron certificados y no se alteró ninguna configuración persistente del host.

## 3. Decisión de ejecución

El experimento real queda `NOT EXECUTED` porque faltan simultáneamente:

1. una sesión administrativa o un entorno dedicado con permisos para administrar el aislamiento;
2. una VM temporal o Windows Sandbox confirmado y reproducible;
3. una red/egress inferior al browser que permita observar conexiones efectivas;
4. un procedimiento seguro de creación, timeout, shutdown y cleanup;
5. una forma de ejecutar Chromium y el fixture dentro de ese límite sin usar el host principal como falsa frontera.

Forzar cualquiera de esos puntos en el equipo de trabajo podría modificar el host, afectar su conectividad o producir una afirmación de seguridad no demostrada. Por ello no se ejecutó ninguna prueba de navegación, redirect, subrecurso, fetch/XHR, WebSocket o Service Worker como evidencia OS-level.

## 4. Resultado por capacidad y caso

| Capacidad/caso | Estado | Evidencia obtenida |
|---|---|---|
| Browser dentro de VM/Sandbox | `NOT EXECUTED` | No se inició Chromium dentro de un entorno aislado. |
| Egress inferior al browser | `NOT EXECUTED` | El proxy fixture existente no es aislamiento OS/network. |
| Hostname, DNS, IP validada, IP efectiva y socket | `NOT EXECUTED` | La relación anterior solo existe en el fixture local controlado; no desde un entorno aislado. |
| Navegación y redirects | `NOT EXECUTED` | No se generó evidencia OS-level nueva. |
| Imágenes, scripts, stylesheets e iframes | `NOT EXECUTED` | No se generó evidencia OS-level nueva. |
| Fetch/XHR y WebSocket | `NOT EXECUTED` | No se generó evidencia OS-level nueva. |
| Service Worker | `NOT EXECUTED` | El `PASS` localhost previo no equivale a aislamiento OS/network. |
| Filesystem limitado | `LIMITATION` | El contexto efímero y el rechazo browser-level de `file://` no prueban una frontera del SO. |
| Ausencia de perfil/credenciales del host | `LIMITATION` | El contexto efímero no prueba aislamiento del host ni ausencia de secretos fuera del browser. |
| Cleanup normal, timeout y shutdown | `LIMITATION` | Existe evidencia browser local previa, pero no de una VM/Sandbox ni de sus recursos. |
| Crash cleanup | `NOT EXECUTED` | No se usaron terminaciones arbitrarias ni mecanismos inseguros para fabricar un crash. |

No se produjeron nuevos `PASS` ni `FAIL`. La simulación DNS/socket previa conserva su estado `SIMULATED`; no se presenta como pinning ni como evidencia de este experimento.

## 5. Protocolo para un entorno habilitado

La siguiente ejecución debe realizarse en una máquina o sesión experimental dedicada, con rollback y permisos explícitos:

1. Crear un entorno efímero —VM Hyper-V temporal o Windows Sandbox confirmado— sin usar el perfil principal del navegador.
2. Preparar Chromium/Playwright y el fixture dentro del entorno, conservando el sandbox y sin `ignoreHTTPSErrors`.
3. Definir una frontera de egress inferior al browser que registre hostname solicitado, resolución, IP validada, IP efectiva, socket y `internalHits`.
4. Probar navegación, redirects, imágenes, scripts, stylesheets, iframes, fetch/XHR, WebSocket y Service Worker contra destinos públicos e internos controlados.
5. Probar filesystem únicamente dentro de un directorio temporal dedicado y verificar que el workspace/host no sea accesible arbitrariamente.
6. Crear únicamente credenciales ficticias dentro del fixture y comprobar que no se hereda storage del host.
7. Ejecutar cleanup normal, timeout y shutdown; registrar directorios, sockets, procesos y artefactos restantes. El crash cleanup debe tener un método seguro y reproducible antes de marcarlo.
8. Repetir el protocolo con DNS controlado, múltiples A/AAAA y cambio de resolución, sin llamar `PASS` a una simulación.

Un resultado `PASS` solo será válido si el browser corre dentro del límite aislado y la evidencia se observa en el boundary inferior. La ausencia de una fuga observada no será suficiente por sí sola para demostrar aislamiento.

## 6. Candidato de entorno futuro

Una VM Hyper-V temporal en una máquina administrativa dedicada es el candidato operativo más concreto, pero no una decisión arquitectónica. Windows Sandbox queda como alternativa si se confirma su feature, red, filesystem y cleanup de forma reproducible. Windows Firewall temporal no debe ser el único mecanismo ni modificarse en el host de trabajo.

La selección del mecanismo, la topología de red, el método de captura y la estrategia de cleanup permanecen abiertas hasta ejecutar el protocolo con permisos y rollback verificables.

## 7. Impacto en ADR-012

ADR-012 continúa provisional en estado `decision-gate`. Esta etapa no añade evidencia OS-level, no cierra ningún criterio del gate y no selecciona Hyper-V, Windows Sandbox, WSL2, Firewall, browser local/remoto, proxy productivo ni provider.

Se mantienen sin conversión de categoría:

- Service Worker localhost: `PASS` acotado al fixture previo;
- DNS/socket pinning: `SIMULATED` / `NOT EXECUTED`;
- HTTPS: `NOT EXECUTED`;
- aislamiento OS/network y crash cleanup: `LIMITATION` / `NOT EXECUTED`.

No se implementaron `WebSearchProvider`, `WebFetchProvider` ni `BrowserProvider`, y no se modificó producción.
