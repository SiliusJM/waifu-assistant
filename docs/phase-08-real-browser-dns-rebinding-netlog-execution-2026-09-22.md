# Phase 8 — Real Browser DNS Rebinding and NetLog Evidence

## Estado de la ejecución

- Fecha de la ejecución: `2026-09-22`.
- Resultado de esta etapa: `REAL / OBSERVED + LIMITATION`.
- No se ejecutó una nueva VM desde esta revisión documental.
- ADR-012 continúa provisional / `decision-gate`.
- No se implementa `BrowserProvider`, `WebFetchProvider` ni `WebSearchProvider`.
- No se modifica `classifier.mjs`.

Esta ejecución valida el parser NetLog contra capturas reales de Chromium. La evidencia demuestra qué resolución y qué endpoint TCP intentó Chromium en cada lanzamiento. No convierte por sí sola la ejecución en `PASS` consolidado.

## Evidencia observada

### Primer lanzamiento

| Observación | Resultado |
|---|---|
| Hostname | `rebind.test` |
| Resolución/endpoint | `1.1.1.1` |
| TCP connect attempt | `1.1.1.1:80` |
| CDP `remoteIPAddress` | `1.1.1.1` |
| HTTP | `409` |
| Clasificación de esta evidencia | `REAL / OBSERVED` |

### Segundo lanzamiento

| Observación | Resultado |
|---|---|
| `requestAt` | `2026-09-22T02:01:59.913Z` |
| Hostname | `rebind.test` |
| NetLog `HOST_RESOLVER_SYSTEM_TASK` | `addresses = ["10.20.0.1"]` |
| NetLog `TCP_CONNECT_JOB_CONNECTOR_CONNECT_START` | `addresses = ["10.20.0.1:80"]` |
| NetLog connect complete | `netError = -118` |
| NetLog connector done | `netError = -105` |
| Playwright | `net::ERR_CONNECTION_TIMED_OUT` |
| `requestfailed` | `2026-09-22T02:02:20.974Z` |
| `page.close` | `2026-09-22T02:02:21.040Z` |
| `browser.disconnected` | `2026-09-22T02:02:21.053Z` |
| Clasificación de esta evidencia | `REAL / OBSERVED` |

El NetLog demuestra directamente que el segundo Chromium intentó el endpoint TCP `10.20.0.1:80`. No demuestra que el socket se estableciera: los eventos posteriores registran errores de conexión/timeout y Playwright informa `ERR_CONNECTION_TIMED_OUT`.

## Diagnóstico del parser real

| Lanzamiento | `rawEventCount` | `recognizedEventCount` | `unknownTypeCount` | `eventsWithHostname` | `eventCount` |
|---|---:|---:|---:|---:|---:|
| Primero | 370 | 87 | 0 | 14 | 42 |
| Segundo | 224 | 56 | 0 | 8 | 29 |

Estos valores confirman que:

- el NetLog fue leído y parseado;
- `constants.logEventTypes` permitió resolver los IDs numéricos;
- no hubo tipos desconocidos en las capturas relevantes;
- se detectaron eventos asociados a `rebind.test`;
- el resumen conservó la evidencia de resolución y conexión sin guardar headers, cookies, autenticación, cuerpos ni bytes de socket.

`eventCount` es una cantidad de eventos reconocidos, no un resultado de seguridad ni un `PASS` del experimento.

## Comparación con `classifier.mjs`

El contrato actual de `classifier.mjs` valida solamente:

1. DNS JSON formal con las respuestas A 1 y 2.
2. Egress JSON formal con delta de paquetes/bytes e `internalHits=0`.
3. Clock reference válida con `maxOffsetMs`.
4. Dos requests target observadas por Playwright.
5. Ventanas `domainLookupStart`/`domainLookupEnd` y `responseEnd` utilizables.
6. Orden temporal completo entre DNS, requests y egress.

El classifier actual no consume `attempt.netlog.summary`, no valida `typeName`, no valida la cadena `source.id`/`source_dependency` y no comprueba el endpoint TCP observado por NetLog.

Por ello, la evidencia actual queda así:

```text
NetLog real:                 OBSERVED
DNS2 observado por NetLog:  REAL / OBSERVED
Endpoint TCP2 observado:    REAL / OBSERVED
Timeout posterior:          REAL / OBSERVED
Consolidación classifier:   LIMITATION
```

No se debe producir `PASS` artificialmente a partir de los contadores NetLog ni del timeout de Playwright.

## Evidencia externa todavía faltante

Para una futura consolidación formal todavía deben obtenerse, sin reutilizar artefactos anteriores:

1. **Fresh clock reference** capturada inmediatamente antes de la ejecución en Gateway y Browser VM, con `maxOffsetMs` medido por el operador.
2. **DNS JSON formal** exportado por el Gateway, con `sequence=1` para `1.1.1.1`, `sequence=2` para `10.20.0.1` y timestamps ISO reales.
3. **Egress JSON formal** exportado por el Gateway, con `packetsBefore/After/Delta`, `bytesBefore/After/Delta`, delta positivo y `observedAt` posterior a la ventana relevante.
4. **`internalHits=0` medido formalmente** por un fixture de aplicación separado. El timeout y el NetLog no sustituyen esta medición.

Además, con el classifier actual, la segunda request necesita una ventana `request.timing()` utilizable. El NetLog resuelve la ausencia de visibilidad del endpoint TCP, pero no sustituye todavía esa condición del classifier.

## Cambio mínimo de contrato propuesto para una futura consolidación

No se implementa en esta etapa. El cambio futuro debe ser aditivo y explícito:

1. Aceptar el resumen filtrado NetLog como evidencia opcional por lanzamiento, sin aceptar el NetLog crudo como contrato.
2. Añadir una validación dedicada, conceptualmente `validateNetLogEvidence()`, que exija para el segundo lanzamiento:
   - `status=AVAILABLE` y resumen suficiente;
   - `unknownTypeCount=0`;
   - evento DNS de `rebind.test` con `10.20.0.1`;
   - evento TCP connect attempt con `10.20.0.1:80`;
   - relación coherente mediante `source.id` y `source_dependency`;
   - evento posterior de timeout/error, sin interpretarlo como conexión exitosa;
   - timestamps NetLog conservados como ticks originales, sin convertirlos a UTC por inferencia.
3. Exigir que el resumen indique el lanzamiento al que pertenece y no mezclar eventos de los dos Chromium.
4. Mantener separadas las condiciones:
   - NetLog prueba resolución/endpoint y resultado del intento desde la perspectiva de Chromium.
   - DNS JSON prueba la secuencia observada en el Gateway.
   - Egress JSON prueba el delta de tráfico bloqueado.
   - `internalHits=0` prueba que el fixture interno no recibió la solicitud.
   - Clock reference permite correlacionar relojes de las VMs.
5. Solo después de validar todas esas fuentes, decidir si NetLog complementa la ventana `request.timing()` o si puede sustituirla para la condición específica de DNS2/endpoint TCP2. No se debe asumir esa sustitución antes de cambiar y probar el contrato.

## Condiciones para una futura consolidación

Una futura ejecución podrá evaluarse formalmente únicamente si:

- conserva esta observación NetLog real por cada lanzamiento;
- captura clock reference fresca;
- entrega DNS JSON formal;
- entrega egress JSON diferencial formal;
- demuestra `internalHits=0` por una medición independiente;
- resuelve explícitamente la ventana de correlación del segundo intento, mediante `request.timing()` o mediante el contrato NetLog aditivo aprobado;
- no existen condiciones `FAIL`;
- no se confunde un timeout con prueba suficiente de bloqueo.

Hasta entonces, el resultado correcto es `REAL / OBSERVED + LIMITATION`.

## Impacto en ADR-012

Esta ejecución mejora la evidencia del comportamiento real de Chromium frente al DNS rebinding controlado: el segundo nombre resolvió a `10.20.0.1` y Chromium intentó `10.20.0.1:80`. No demuestra pinning productivo, una frontera de egress completa, `internalHits=0`, aislamiento OS-level, HTTPS/TLS, browser remoto ni crash cleanup.

ADR-012 permanece provisional / `decision-gate`. No se selecciona arquitectura productiva ni se autoriza la implementación de providers.
