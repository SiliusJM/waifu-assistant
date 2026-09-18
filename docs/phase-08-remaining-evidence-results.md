# Phase 8 — Remaining Evidence Results

## Alcance

Esta matriz consolida la evidencia disponible después del merge de PR #14 y la ejecución repetida sobre `origin/main` `1ed24fa1c91817d2abe49c0bb5ffcda001aec3d3`. No representa una nueva implementación de producción. No se modificó `src/`, no se añadieron providers ni se solicitaron credenciales.

Los estados se mantienen estrictos:

- `PASS`: la propiedad probada se observó y cumplió.
- `FAIL`: la propiedad probada no cumplió.
- `NOT EXECUTED`: el entorno o la capacidad no estaban disponibles.
- `LIMITATION`: la evidencia no demuestra una propiedad más fuerte.
- `SIMULATED`: el caso fue modelado, no ejecutado en una red/socket real.

## Matriz principal

| Prueba | Entorno | Ejecutada | Observada | Bloqueada | `internalHits` | Resultado | Limitaciones |
|---|---|---:|---:|---:|---:|---|---|
| Fetch/SSRF/DNS controlado | Fixtures Node locales | Sí | Sí | Sí | 0 | `PASS` | Política y DNS son controlados; no pinning productivo. |
| Browser route baseline: navegación/subrecursos | Chromium local + `browserContext.route()` | Sí | Sí | Sí para secundarios | 0 en secundarios | `PASS` | No cubre todos los caminos de red. |
| Browser route baseline: redirect público→interno | Chromium local + routing | Sí | Sí | No | 1 | `FAIL` | El redirect alcanzó el fixture interno. |
| Egress boundary: navegación | Chromium local + proxy fixture | Sí | Sí | Sí | 0 | `PASS` | Fixture local; no aislamiento del host. |
| Egress boundary: redirect interno | Chromium local + proxy fixture | Sí | Sí | Sí | 0 | `PASS` | No demuestra socket pinning real. |
| Egress boundary: image/script/style/iframe/fetch/WebSocket | Chromium local + proxy fixture | Sí | Sí | Sí | 0 por canal | `PASS` | Service Worker quedó separado. |
| Egress hardening por canal | Chromium local + proxy fixture | Sí | Sí por ocho canales | Sí por canal | 0 por canal | `PASS` | Evidencia local; no OS-level network isolation. |
| Service Worker en egress fixture | Chromium local efímero | No | No | — | 0 no concluyente | `NOT EXECUTED` | Chromium no expuso `navigator.serviceWorker` para el origen controlado. |
| HTTPS público→HTTPS público | Fixture HTTP-only | No | No | — | — | `NOT EXECUTED` | No había certificado TLS reproducible in-process sin mecanismos inseguros. |
| HTTPS→HTTP | Fixture HTTP-only | No | No | — | — | `NOT EXECUTED` | Política de downgrade permanece abierta. |
| HTTPS→destino interno | Fixture HTTP-only | No | No | — | — | `NOT EXECUTED` | Falta fixture TLS controlado. |
| DNS rebinding | Clasificador/fixture controlado | Sí, simulado | Sí, simulado | Sí, simulado | 0 simulado | `SIMULATED` | No demuestra resolución real ni pinning de socket. |
| Browser remoto | Entorno local | No | No | — | — | `NOT EXECUTED` | `BROWSER_REMOTE_ENDPOINT` y `BROWSER_REMOTE_TOKEN` ausentes. |
| Crash cleanup | Entorno local | No | No | — | — | `NOT EXECUTED` | No existe simulación segura sin terminación de procesos. |
| Cleanup normal/timeout/shutdown | Chromium local + fixtures | Sí | Sí | N/A | 0 | `PASS` | No equivale a crash cleanup. |
| Search Brave/Tavily/Exa | Entorno local | No | No | — | — | `NOT EXECUTED` | Credenciales no presentes; no se imprimieron ni solicitaron. |

La ejecución repetida del hardening produjo **14 `PASS`, 0 `FAIL`, 6 `NOT EXECUTED` y 1 `SIMULATED`**, con `internalHits=[]`. El egress boundary spike produjo **19 `PASS`, 0 `FAIL` y 2 `NOT EXECUTED`**. La suite browser baseline conserva **17 `PASS`, 1 `FAIL` y 1 `NOT EXECUTED`**.

## Evidencia por canal del hardening

| Canal | Request intentada | Proxy observado | Destino | Bloqueada | Internal hit | Resultado |
|---|---:|---:|---|---:|---:|---|
| navigation | Sí | Sí | `127.0.0.1` loopback | Sí | 0 | `PASS` |
| redirect | Sí | Sí | `127.0.0.1` loopback | Sí | 0 | `PASS` |
| image | Sí | Sí | `127.0.0.1` loopback | Sí | 0 | `PASS` |
| script | Sí | Sí | `127.0.0.1` loopback | Sí | 0 | `PASS` |
| stylesheet | Sí | Sí | `127.0.0.1` loopback | Sí | 0 | `PASS` |
| iframe | Sí | Sí | `127.0.0.1` loopback | Sí | 0 | `PASS` |
| fetch/XHR | Sí | Sí | `127.0.0.1` loopback | Sí | 0 | `PASS` |
| WebSocket | Sí | Sí (`CONNECT`) | `127.0.0.1` loopback | Sí | 0 | `PASS` |
| Service Worker | No | No | — | — | 0 no concluyente | `NOT EXECUTED` |

La tabla es evidencia por canal; el contador global `internalHits` no se usa como única afirmación de bloqueo.

## Comparación de mecanismos

| Mecanismo | Propiedades demostradas | Propiedades no demostradas | Resultado |
|---|---|---|---|
| `browserContext.route()` | Interceptó varios secundarios en el fixture y permitió observabilidad. | Redirect público→interno; Service Worker completo; socket pinning; egress del host. | `FAIL` para uso como boundary único. |
| Proxy/egress boundary | Bloqueo por destino efectivo del fixture, redirects internos, secundarios y WebSocket `CONNECT`; `internalHits=0`. | Service Worker ejecutable, TLS, DNS/socket pinning real, aislamiento del host, browser remoto. | Evidencia positiva experimental; no decisión final. |
| Aislamiento de red | Ninguna ejecución en esta etapa. | Todas las propiedades de aislamiento real y operación Windows. | `NOT EXECUTED`. |
| Route + proxy | No se ejecutó como combinación integrada. | Beneficio adicional, bypasses y complejidad operacional. | `NOT EXECUTED`. |
| Browser local | Contexto efímero, sandbox solicitado, cleanup normal y ausencia de perfil principal en harnesses. | Efectividad OS-level del sandbox, crash cleanup, filesystem y red del host. | Evidencia parcial. |
| Browser remoto | Ninguna ejecución. | Egress del servicio remoto, credenciales, aislamiento y coste operativo. | `NOT EXECUTED`. |

No se asigna ganador, ranking ni score.

## Evidencia faltante antes de producción

1. Service Worker real con request interna observada por el proxy y resultado individual.
2. TLS reproducible para HTTPS→HTTPS, HTTPS→HTTP y HTTPS→interno.
3. DNS controlado con resolución, destino efectivo y socket realmente utilizado; la simulación no basta.
4. Browser remoto solo cuando el entorno y credenciales ya existan, sin registrar secretos.
5. Crash cleanup seguro sin APIs de procesos arbitrarias.
6. Benchmark real de Search con credenciales temporales y el corpus de 20 consultas.
7. Aislamiento de red/host y límites operativos en Windows.

Hasta cerrar estas pruebas, cualquier decisión sobre browser, proxy, sandbox o aislamiento debe permanecer provisional.

## Seguridad y límites

No se introdujeron shell, `child_process`, `spawn`, `exec`, PowerShell, terminación arbitraria, credenciales, perfil principal, filesystem arbitrario ni dependencias nuevas. Los fixtures usan directorios temporales y registran solamente metadatos seguros.
