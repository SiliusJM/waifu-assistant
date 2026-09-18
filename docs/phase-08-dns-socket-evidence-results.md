# Phase 8 — DNS/Socket Egress Evidence Results

## Objetivo y alcance

Esta subetapa verifica, en un fixture local controlado, la relación entre hostname solicitado, resolución DNS, IP validada, IP efectiva y dirección remota del socket utilizado por el boundary.

La rama `phase/08-internet-browser-dns-socket-evidence` parte de `origin/main` `4cffd78bb175ccd0a84b887f1cecaf6f5125c8eb`. No implementa `BrowserProvider`, `WebFetchProvider`, `WebSearchProvider` ni egress productivo. No modifica `src/` ni cierra ADR-012.

## Entorno y método

- Node.js: `v22.18.0`.
- Playwright: `1.63.0`.
- Chromium: Chrome Headless Shell `153.0.8010.12`, provisionado fuera del repositorio.
- Sandbox: `chromiumSandbox=true`; no se usó `--no-sandbox`.
- Contexto: efímero, sin perfil principal ni storage state.
- TLS: fuera de alcance; todos los casos usan HTTP controlado.

El harness `scripts/phase-08-dns-socket-evidence/run.mjs` reutiliza el patrón de browser/proxy de Phase 8 y añade únicamente la instrumentación experimental necesaria:

1. Un servidor DNS UDP local responde registros A controlados y registra cada consulta.
2. El boundary usa `dns.promises.Resolver` apuntando exclusivamente a ese DNS local.
3. El boundary registra hostname, respuestas DNS, IP validada, IP efectiva y decisión de bloqueo.
4. Para el destino permitido del fixture, la conexión HTTP se abre hacia la IP efectiva y se registra `socket.remoteAddress`.
5. Para destinos internos, el boundary responde `403` antes de abrir el socket.
6. El fixture interno mantiene un contador independiente `internalHits`.

El uso de `127.0.0.2` como endpoint permitido es una excepción explícita del fixture para demostrar la conexión local. No representa una autorización general de loopback ni modifica la política SSRF de producción.

## Fixtures y resolución DNS

| Hostname | Respuesta inicial | Respuesta posterior | Uso |
|---|---|---|---|
| `public.test` | `127.0.0.2` | — | Fixture controlado permitido |
| `internal.test` | `127.0.0.3` | — | Fixture interno que debe bloquearse |
| `rebind.test` | `127.0.0.2` | `127.0.0.3` | Cambio controlado de respuesta |

El DNS local recibió cuatro consultas A: una para `public.test`, una para `internal.test` y dos para `rebind.test`. La diferencia `127.0.0.2 → 127.0.0.3` fue observada por el resolver del boundary, no inventada en el reporte.

## Resultados por caso

| Caso | IP validada | IP efectiva | Socket observado | Bloqueo | `internalHits` | Resultado |
|---|---|---|---|---|---:|---|
| `public.test` | `127.0.0.2` | `127.0.0.2` | `127.0.0.2` | No | 0 | `PASS` |
| `internal.test` | `127.0.0.3` | `127.0.0.3` | Ninguno | Sí, antes de conectar | 0 | `PASS` |
| `rebind.test` | `127.0.0.2` | `127.0.0.3` | Ninguno | Sí, tras revalidar | 0 | `SIMULATED` |

### `public.test` — socket local controlado

La navegación terminó con HTTP `200`. La IP validada y la IP efectiva fueron `127.0.0.2`, y el socket TCP observado por el boundary reportó `remoteAddress=127.0.0.2`. El fixture interno no recibió conexiones.

Esta es evidencia real de la relación DNS controlada → destino efectivo → socket local dentro del fixture. No demuestra conexión a un destino público real.

### `internal.test` — bloqueo antes del socket

La resolución produjo `127.0.0.3`. El boundary clasificó el destino como interno y respondió HTTP `403` sin abrir conexión. `socketRemoteAddress` permaneció nulo y `internalHits=0`.

Esta es evidencia real del comportamiento de bloqueo y de ausencia de conexión al fixture interno en este entorno controlado.

### `rebind.test` — cambio controlado de respuesta

La primera resolución produjo `127.0.0.2` y la segunda `127.0.0.3`. El boundary revalidó la respuesta efectiva, bloqueó antes de conectar y mantuvo `internalHits=0`.

El resultado es `SIMULATED`, no `PASS` de DNS rebinding real. El fixture demuestra la lógica de revalidación frente a una secuencia DNS controlada, pero no demuestra comportamiento de un resolver público, múltiples A/AAAA, cambios temporales en DNS real, pinning de socket del sistema ni protección completa contra DNS rebinding en producción.

## Resumen ejecutable

`node scripts/phase-08-dns-socket-evidence/run.mjs` produjo:

- `3` comprobaciones;
- `2 PASS`;
- `0 FAIL`;
- `0 NOT EXECUTED`;
- `1 SIMULATED`;
- `internalHits=[]`.

## Evidencia real frente a simulación

### Evidencia real dentro del fixture

- Consultas DNS A recibidas por un servidor UDP local.
- IP validada registrada por el boundary.
- IP efectiva registrada por el boundary.
- `socket.remoteAddress` real para el endpoint controlado permitido.
- Bloqueo antes del socket para el destino interno.
- Ausencia de conexiones al fixture interno.

### Evidencia que permanece simulada o limitada

- `rebind.test` modela un cambio de respuesta DNS; no es DNS rebinding público real.
- `public.test` no es un dominio público y `127.0.0.2` solo está permitido por la excepción del fixture.
- No se probaron múltiples A/AAAA, HTTPS, CONNECT/WebSocket sobre TLS, proxy remoto ni aislamiento OS-level.
- El socket observado es local y controlado; no demuestra la política de red del sistema operativo ni un provider productivo.

## Seguridad y limpieza

El harness no solicita credenciales, no usa el perfil principal, no escribe fuera de recursos temporales controlados y no cambia el trust store de Windows. No usa `ignoreHTTPSErrors`, shell, `child_process`, `spawn` ni `exec`. El browser, contexto, proxy, servidores HTTP y servidor DNS se cierran en `finally`.

## Impacto sobre ADR-012

La evidencia fortalece el conocimiento experimental sobre la relación resolución → IP efectiva → socket y demuestra bloqueo local antes de conectar a un destino interno. No cierra el decision-gate.

ADR-012 permanece provisional porque todavía faltan DNS real con múltiples respuestas y cambios de resolución, pinning verificable en un entorno de red real, HTTPS, aislamiento OS-level, browser remoto y crash cleanup seguro. No se selecciona una arquitectura productiva ni un provider definitivo.
