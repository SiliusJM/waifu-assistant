# Phase 8 — Architecture Gate Evidence Results

## Estado

Evidencia ejecutable de la rama `phase/08-internet-browser-gate-evidence`, basada en `origin/main` `261d96823fde00f21ec67564d85cfc0117082f00`.

Esta etapa no implementa providers productivos ni modifica `src/`. Los resultados distinguen evidencia nueva de ejecuciones repetidas y no convierten `NOT EXECUTED` o `SIMULATED` en `PASS`.

## Estados usados

- `PASS`: criterio demostrado en el entorno indicado.
- `FAIL`: criterio ejecutado y no cumplido.
- `NOT EXECUTED`: el entorno o mecanismo necesario no estuvo disponible.
- `LIMITATION`: la evidencia no demuestra una propiedad más fuerte.
- `SIMULATED`: comportamiento modelado, no resolución/socket real.

## Evidencia nueva frente a evidencia repetida

### Nueva

Se añadió `scripts/phase-08-gate-evidence/run.mjs` para ejecutar un fixture Service Worker en `http://localhost`. Chromium expuso `navigator.serviceWorker` en un contexto efímero con `chromiumSandbox=true`, sin perfil principal ni storage state. El proxy fue forzado a observar localhost mediante una opción exclusiva del fixture (`--proxy-bypass-list=<-loopback>`); no se desactivó el sandbox.

Resultado nuevo:

```text
requestAttempted: true
proxyObserved: true
destination: 127.0.0.1
blocked: true
internalHits: 0
result: PASS
```

La request fue generada por el Service Worker y el `fetch()` falló como consecuencia esperada del bloqueo. El fixture no recibió la conexión interna.

### Repetida

- Fetch/SSRF/DNS controlado: `29/29 PASS`.
- Browser route baseline: `17 PASS`, `1 FAIL`, `1 NOT EXECUTED`; el redirect público→interno sigue alcanzando el fixture (`internalHits=1`).
- Egress boundary: `19 PASS`, `0 FAIL`, `2 NOT EXECUTED`, `internalHits=0`.
- Egress hardening: `14 PASS`, `0 FAIL`, `6 NOT EXECUTED`, `1 SIMULATED`, `internalHits=[]`.
- Tests del repositorio: `98/98 PASS`.

## Matriz de criterios de ADR-012

| Criterio | Evidencia | Resultado | Limitación |
|---|---|---|---|
| Service Worker intenta destino interno y el boundary lo bloquea | Fixture localhost; proxy observó `GET /internal/service-worker-target`; `internalHits=0`. | `PASS` | Fixture controlado; no prueba todos los providers ni aislamiento OS-level. |
| HTTPS público→HTTPS público | No se creó fixture TLS reproducible sin mecanismos inseguros. | `NOT EXECUTED` | Falta TLS in-process seguro y reproducible. |
| HTTPS→HTTP | No ejecutado. | `NOT EXECUTED` | La política de downgrade sigue abierta. |
| HTTPS→destino interno | No ejecutado. | `NOT EXECUTED` | El fixture egress existente es HTTP-only. |
| Múltiples A/AAAA y cambio de resolución | Solo existe evidencia controlada del harness Fetch y simulación. | `SIMULATED` | No se observó resolver/socket real ni pinning. |
| IP validada, IP efectiva y socket usado | Simulación: `93.184.216.34` → `10.0.0.9`. | `SIMULATED` | No demuestra destino real del socket. |
| `internalHits=0` por navegación, redirect y subrecursos | Hardening por canal: navigation, redirect, image, script, stylesheet, iframe, fetch/XHR y WebSocket. | `PASS` | Evidencia de proxy fixture, no aislamiento del host. |
| `internalHits=0` por Service Worker | Harness nuevo: `internalHits=0`. | `PASS` | Solo localhost controlado. |
| Egreso/aislamiento local verificable | Contextos efímeros, sandbox solicitado, filesystem temporal y cleanup normal observados. | `LIMITATION` | No demuestra aislamiento OS-level de Windows. |
| Egreso/aislamiento remoto | No hay `BROWSER_REMOTE_ENDPOINT` ni `BROWSER_REMOTE_TOKEN`. | `NOT EXECUTED` | No se solicitaron credenciales. |
| Cleanup normal, timeout y shutdown | Context/browser/proxy/fixture/directorio temporal verificados. | `PASS` | No equivale a crash cleanup. |
| Crash cleanup seguro | No existe método permitido sin APIs de procesos. | `NOT EXECUTED` | No se usó terminación arbitraria. |
| Coste, latencia, cancelación y operación Windows | No se realizó benchmark de esta etapa. | `NOT EXECUTED` | Requiere entorno y diseño de provider más concretos. |

## Evidencia por canal

| Canal | Observado por proxy | Bloqueado | `internalHits` | Resultado |
|---|---:|---:|---:|---|
| navigation | Sí | Sí | 0 | `PASS` |
| redirect | Sí | Sí | 0 | `PASS` |
| image | Sí | Sí | 0 | `PASS` |
| script | Sí | Sí | 0 | `PASS` |
| stylesheet | Sí | Sí | 0 | `PASS` |
| iframe | Sí | Sí | 0 | `PASS` |
| fetch/XHR | Sí | Sí | 0 | `PASS` |
| WebSocket | Sí (`CONNECT`) | Sí | 0 | `PASS` |
| Service Worker | Sí | Sí | 0 | `PASS` |

Estos resultados son composición de fixtures experimentales; no seleccionan aún una arquitectura productiva.

## HTTPS evidence

Esta subetapa intentó cerrar HTTPS sin OpenSSL por shell, APIs de procesos, cambios permanentes del sistema ni debilitamiento de TLS. No se encontró un fixture TLS reproducible y seguro dentro del entorno actual.

| Caso | Resultado | Evidencia | Limitación |
|---|---|---|---|
| HTTPS público → HTTPS público | `NOT EXECUTED` | No se inició un servidor TLS reproducible. | Falta certificado temporal in-process seguro. |
| HTTPS → HTTP | `NOT EXECUTED` | No se siguió un redirect TLS→HTTP. | La política de downgrade permanece abierta. |
| HTTPS → destino interno | `NOT EXECUTED` | No se ejecutó request/redirect HTTPS al fixture interno. | El fixture egress disponible es HTTP-only. |

No se fabrican resultados HTTPS. La evidencia Fetch histórica de downgrade bloqueado no equivale a evidencia browser/proxy TLS de esta etapa.

## DNS/socket evidence

La evidencia `93.184.216.34 → 10.0.0.9` continúa siendo `SIMULATED`. El harness no pudo controlar simultáneamente resolver, cambio de respuesta, IP validada, IP efectiva y destino real del socket.

| Campo | Resultado actual |
|---|---|
| Hostname inicial | Controlado en fixture |
| IP validada | `93.184.216.34` — simulada |
| Resolución posterior | `10.0.0.9` — simulada |
| IP efectiva | `10.0.0.9` — clasificada por policy, no observada en socket real |
| Socket utilizado | No demostrable (`NOT EXECUTED`) |
| Decisión del boundary | Bloqueo simulado/controlado |
| Conexión interna efectiva | `0` en el fixture proxy; no prueba pinning real |

No se marca `PASS` para DNS rebinding/socket pinning. Permanecen pendientes múltiples A/AAAA, cambio de resolución controlado y comparación entre IP validada, IP conectada y conexión efectiva.

## Search y browser remoto

Brave, Tavily y Exa permanecieron `NOT EXECUTED` por ausencia de credenciales temporales. `BROWSER_REMOTE_ENDPOINT` y `BROWSER_REMOTE_TOKEN` tampoco estaban presentes. No se solicitaron, imprimieron ni almacenaron secretos.

## Conclusión del gate

La nueva evidencia cierra el caso Service Worker dentro del fixture localhost: el boundary inferior observó y bloqueó el destino interno. El gate completo **permanece abierto** por HTTPS, DNS/socket pinning, aislamiento real del host, browser remoto, crash cleanup y mediciones operativas.

No se selecciona proxy, browser, sandbox, aislamiento de red ni combinación definitiva. ADR-012 permanece provisional.

## Seguridad

No se modificó `src/`, ningún manifest o lockfile. No se introdujeron shell, `child_process`, `spawn`, `exec`, PowerShell, APIs de terminación arbitraria, perfil principal ni almacenamiento de secretos.
