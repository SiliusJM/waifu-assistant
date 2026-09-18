# Phase 8 — Egress Architecture Decision Draft

## Estado

**Borrador provisional / decision-gate.** La evidencia actual no permite seleccionar todavía una arquitectura productiva ni un browser/provider definitivo. Este documento no autoriza implementación.

## Pregunta

¿Qué frontera debe proteger en el futuro a `BrowserProvider` contra SSRF y egress interno, cubriendo navegación, redirects, subrecursos, `fetch`/XHR, WebSocket y Service Worker sin bloquear el core ni convertir el contenido web en autoridad?

## Evidencia disponible

- Fetch/SSRF/DNS controlado: `29/29 PASS`, pero con resolución y fixtures controlados.
- `browserContext.route()` baseline: `17 PASS`, `1 FAIL`, `1 NOT EXECUTED`; un redirect público→interno alcanzó el fixture (`internalHits=1`).
- Proxy/egress fixture: `19 PASS`, `0 FAIL`, `2 NOT EXECUTED`, `internalHits=0`.
- Egress hardening individual: navegación, redirect, image, script, stylesheet, iframe, fetch/XHR y WebSocket dieron `PASS` con observación y bloqueo por canal; Service Worker quedó `NOT EXECUTED`.
- DNS rebinding solo está `SIMULATED`; no existe evidencia de pinning real entre resolución y socket.
- HTTPS controlado, browser remoto y crash cleanup seguro están `NOT EXECUTED`.
- Chromium local se ejecutó con contexto efímero y sandbox solicitado; esto no demuestra aislamiento OS-level ni cleanup ante crash.

## Comparación

| Alternativa | Cobertura observada | Ventajas | Riesgos/limitaciones | Estado |
|---|---|---|---|---|
| `browserContext.route()` | Secundarios observados y bloqueados en parte del fixture; redirect interno falló. | API simple y buena observabilidad. | No es boundary de red completo; bypasses por redirects/Service Workers y dependencia del comportamiento del browser. | Rechazado como control único. |
| Proxy/egress boundary | Redirect interno, recursos secundarios, fetch/XHR y WebSocket bloqueados; `internalHits=0`. | Frontera inferior, política centralizada, observabilidad del destino efectivo y aplicable a todas las solicitudes que atraviesen el proxy. | Fixture local; TLS, pinning, Service Worker, host isolation y browser remoto pendientes. | Candidato provisional, no seleccionado. |
| Aislamiento de red | No probado. | Puede controlar egress fuera del browser y reducir bypasses. | Complejidad Windows/operacional, diagnóstico y despliegue pendientes. | Abierto. |
| Route + proxy | No probado en combinación. | Route puede aportar trazas/early rejection y proxy la frontera inferior. | Complejidad duplicada, semántica de bypass y consistencia pendientes. | Abierto. |
| Browser local | Contexto efímero, sandbox solicitado, cleanup normal. | Privacidad y latencia potencialmente mejores. | Superficie local, filesystem, procesos, sandbox OS-level y crash cleanup no demostrados. | Abierto. |
| Browser remoto | No ejecutado. | Separa el browser del desktop y puede centralizar aislamiento/egress. | Credenciales, datos, latencia, coste, red del servicio y egress remoto no evaluados. | Abierto. |

## Análisis por propiedad

### Navegación y redirects

La evidencia negativa del baseline demuestra que validar o interceptar la navegación principal no basta. El proxy fixture sí revalidó el redirect hacia loopback y mantuvo `internalHits=0`, pero esto todavía es evidencia local y no prueba el socket real en todos los providers.

### Subrecursos, fetch/XHR y WebSocket

El proxy observó y bloqueó image, script, stylesheet, iframe, fetch/XHR y WebSocket mediante `CONNECT`, con evidencia individual por canal. El resultado respalda exigir una frontera que cubra todas las solicitudes, no solo `navigate()`.

### Service Worker

No hay evidencia de bloqueo porque Chromium no expuso `navigator.serviceWorker` en el fixture. La arquitectura no puede tratar este caso como resuelto. Debe permanecer como criterio de aceptación previo a producción.

### DNS rebinding y HTTPS

La simulación diferencia IP validada `93.184.216.34` e IP efectiva interna `10.0.0.9`, pero no prueba resolver, socket ni pinning real. HTTPS→HTTPS, HTTPS→HTTP y HTTPS→interno no se ejecutaron. No se puede concluir una política TLS o anti-rebinding definitiva.

### Aislamiento del host

Los contextos efímeros, sandbox solicitado y directorios temporales muestran configuración de harness, no aislamiento suficiente de Windows. Siguen pendientes filesystem boundary, crash cleanup, sockets/procesos y egress efectivo del host.

## Propuesta provisional

Adoptar como **gate arquitectónico**, no como decisión final, el siguiente requisito:

```text
BrowserProvider futuro
    -> boundary de egress inferior obligatorio
    -> provider/browser aislado y efímero
    -> ToolManager / policy boundary
```

`browserContext.route()` puede conservarse como observabilidad o rechazo temprano, pero no debe ser la única defensa. El candidato más respaldado por la evidencia actual es un proxy/egress boundary inferior, posiblemente combinado con aislamiento de red; la combinación no está probada y no se selecciona todavía.

No se decide aún entre proxy, gateway, aislamiento de red, combinación, browser local o browser remoto. Tampoco se decide Playwright como dependencia productiva.

## Condiciones de aceptación del gate

Antes de implementar providers productivos deben existir pruebas reproducibles que demuestren:

1. bloqueo por canal para navegación, redirects, image, script, stylesheet, iframe, fetch/XHR, WebSocket y Service Worker;
2. `internalHits=0` y evidencia individual de request, observación, destino y bloqueo;
3. HTTPS→HTTPS, HTTPS→HTTP y HTTPS→interno con política explícita;
4. DNS con múltiples A/AAAA, cambio de resolución y comparación entre IP validada e IP usada por el socket;
5. aislamiento de red/host y límites de filesystem en el modo local o remoto elegido;
6. cleanup normal, timeout, shutdown y crash seguro;
7. cancelación, timeout, observabilidad y costo/latencia compatibles con el contrato;
8. ausencia de secretos en logs, contenido web no autoritativo y ausencia de shell/proceso arbitrario.

## Riesgos si se implementa antes de cerrar el gate

- SSRF por redirects o mecanismos de red no cubiertos.
- Falsa confianza en `route()` por ausencia de evidencia Service Worker.
- DNS rebinding entre validación y conexión.
- Egress interno desde un browser remoto no controlado.
- Falsa afirmación de aislamiento por usar un contexto efímero sin control OS-level.
- Cleanup incompleto tras crash o timeout.

## Decisión pendiente

Este documento no selecciona arquitectura final. El siguiente paso válido es cerrar las pruebas faltantes en un entorno seguro y actualizar este borrador/ADR con evidencia nueva. Hasta entonces, Phase 8 continúa en preproducción y no se implementan `WebSearchProvider`, `WebFetchProvider` ni `BrowserProvider`.
