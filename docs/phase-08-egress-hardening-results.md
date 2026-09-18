# Phase 8 — Egress Boundary Hardening Results

## Estado y alcance

Este documento registra el hardening experimental ejecutado en la rama `phase/08-internet-browser-egress-hardening`, basada en `origin/main` `a7e59bc594b317f5269ed316f0a2ab661ef70eea`.

No se implementan `BrowserProvider`, `WebFetchProvider`, `WebSearchProvider`, `ToolManager`, `AssistantCore`, UI, Electron/Vue ni providers productivos. El código nuevo está limitado a `scripts/phase-08-egress-hardening/run.mjs`. Playwright continúa siendo únicamente una `devDependency` experimental ya existente.

La evidencia usa fixtures locales y un proxy inferior al browser. `public.test` es un hostname controlado por el fixture y no representa DNS público, pinning real ni aislamiento de red del sistema operativo.

## Estados

- `PASS`: la comprobación ejecutada cumplió la política.
- `FAIL`: una comprobación ejecutada no cumplió la política. Un acceso interno real es `FAIL`.
- `NOT EXECUTED`: faltó capacidad o entorno; no se interpreta como éxito.
- `LIMITATION`: la prueba tiene una frontera explícita y no demuestra una propiedad más fuerte.
- `SIMULATED`: el comportamiento se modeló localmente y no demuestra una propiedad de red real.

## Resultado por canal

El harness deja evidencia independiente para cada canal: si se intentó la request, si el proxy la observó, destino detectado, bloqueo, conexiones efectivas al fixture interno y número de `internalHits` asociado. Un bypass de cualquier canal ejecutado termina en `FAIL`; no se usa el contador agregado como única evidencia.

| Canal | Request intentada | Observado por proxy | Destino | Bloqueado | Internal hit | Resultado |
|---|---:|---:|---|---:|---:|---|
| navigation | Sí | Sí | `127.0.0.1` / loopback | Sí | 0 | `PASS` |
| redirect | Sí | Sí | `127.0.0.1` / loopback | Sí | 0 | `PASS` |
| image | Sí | Sí | `127.0.0.1` / loopback | Sí | 0 | `PASS` |
| script | Sí | Sí | `127.0.0.1` / loopback | Sí | 0 | `PASS` |
| stylesheet | Sí | Sí | `127.0.0.1` / loopback | Sí | 0 | `PASS` |
| iframe | Sí | Sí | `127.0.0.1` / loopback | Sí | 0 | `PASS` |
| fetch/XHR | Sí | Sí | `127.0.0.1` / loopback | Sí | 0 | `PASS` |
| WebSocket | Sí | Sí | `127.0.0.1` / loopback | Sí | 0 | `PASS` |
| Service Worker | No | No | — | — | 0 | `NOT EXECUTED` |

En esta ejecución Chromium no expuso `navigator.serviceWorker` para el origen controlado. No se convirtió esa ausencia en `PASS` y no se afirmó bloqueo del request del Service Worker.

### Totales del harness de hardening

`node scripts/phase-08-egress-hardening/run.mjs` produjo:

- **21 comprobaciones**;
- **14 `PASS`**;
- **0 `FAIL`**;
- **6 `NOT EXECUTED`**;
- **1 `SIMULATED`**;
- `internalHits=[]`.

Las seis comprobaciones `NOT EXECUTED` corresponden al canal Service Worker, tres casos HTTPS, browser remoto y crash cleanup. El resto incluye cleanup normal de contexto, browser, proxy, fixture y directorio temporal.

## HTTPS controlado

No se ejecutó TLS local en esta iteración:

| Caso | Resultado | Motivo |
|---|---|---|
| HTTPS público → HTTPS público | `NOT EXECUTED` | No había un fixture de certificados reproducible en proceso. |
| HTTPS público → HTTP | `NOT EXECUTED` | Sin fixture TLS; la política de downgrade permanece abierta. |
| HTTPS público → destino interno | `NOT EXECUTED` | El fixture ejecutado fue HTTP-only. |

No se usaron certificados reales, se modificó la seguridad del sistema, ni se invocaron OpenSSL, shell o APIs de procesos para fabricar la prueba. No se inventa resultado TLS.

## Service Worker

El fixture intenta registrar un Service Worker solo si Chromium expone la API. En este entorno la API no estuvo disponible, por lo que el caso quedó `NOT EXECUTED` con la siguiente evidencia:

- request generada por Service Worker: no demostrada;
- observación por proxy: no demostrada;
- destino: no disponible;
- bloqueo: no demostrado;
- `internalHits` del caso: `0`, pero no es evidencia de bloqueo.

La prueba futura debe mantener el criterio: si el Service Worker alcanza el fixture interno sin pasar por el boundary, `FAIL`; si el proxy lo bloquea, `PASS`; si Chromium no permite ejecutar el fixture, `NOT EXECUTED`. No se deben desactivar medidas de seguridad ni interpretar la ausencia de la API como aislamiento.

## DNS rebinding

El caso controlado se registró como `SIMULATED`:

- IP validada inicialmente: `93.184.216.34`;
- IP efectiva posterior: `10.0.0.9`;
- decisión del boundary: bloquear;
- conexión interna efectiva: `0`.

Esto no demuestra resolución DNS real, pinning de socket ni comportamiento de un resolver/proxy/browser real. La simulación permanece como `SIMULATED`/`LIMITATION`; no se afirma protección completa contra DNS rebinding.

## Browser remoto

`BROWSER_REMOTE_ENDPOINT` y `BROWSER_REMOTE_TOKEN` no estaban presentes. Los casos críticos de browser remoto quedaron `NOT EXECUTED` y no se solicitaron ni publicaron credenciales.

Quedan pendientes, para un entorno ya proporcionado y aislado:

- navegación pública;
- redirect público → interno;
- subrecurso interno;
- fetch/XHR interno;
- WebSocket;
- Service Worker, si está disponible.

El criterio seguirá siendo `internalHits=0` por canal, con evidencia individual de observación y bloqueo.

## Crash cleanup y cleanup normal

No se ejecutó crash cleanup controlado porque no existe una simulación segura en el entorno actual sin terminación arbitraria de procesos, `child_process`, `taskkill`, PowerShell o shell.

Sí se verificaron con `PASS`:

- cierre explícito de `BrowserContext`;
- cierre explícito de browser;
- cierre del proxy fixture;
- cierre del fixture HTTP;
- eliminación del directorio temporal;
- cleanup agrupado tras el flujo normal.

Timeout y shutdown ordenado no implican que el crash cleanup esté demostrado.

## Comparación de mecanismos

| Mecanismo | Evidencia | Resultado documentado |
|---|---|---|
| route baseline | `17 PASS`, `1 FAIL`, `1 NOT EXECUTED`; redirect público → interno alcanzó el fixture (`internalHits=1`). | Limitación real: routing no es frontera completa por sí solo. |
| proxy boundary | Canales HTTP y WebSocket ejecutados individualmente; todos los canales ejecutados fueron observados y bloqueados con `internalHits=0`. | Evidencia experimental positiva, no decisión productiva. |
| network isolation | No ejecutada. | `NOT EXECUTED`. |
| route + proxy | No ejecutada como combinación integrada. | `NOT EXECUTED`. |

No se asigna winner, ranking ni score. Tampoco se seleccionan todavía proxy definitivo, browser, sandbox, aislamiento de red o provider Search.

## Seguridad y datos

El harness no persiste API keys, Authorization, cookies, HTML completo, cuerpos completos ni prompts completos. El proxy registra solo metadatos de request. Las pruebas escriben únicamente en directorios temporales creados por el harness y no usan el perfil principal del navegador.

No se añadieron APIs de procesos, shell, `child_process`, `spawn`, `exec`, PowerShell ni automatización integrada al producto.

## Verificaciones

Resultados ejecutados en esta rama:

- `node scripts/phase-08-egress-hardening/run.mjs`: **14 PASS, 0 FAIL, 6 NOT EXECUTED, 1 SIMULATED**; canales ejecutados sin bypass; `internalHits=[]`.
- `node scripts/phase-08-controlled-tests/run.mjs`: Fetch **29/29 PASS**; Search no ejecutado por ausencia de credenciales.
- `node scripts/phase-08-external-tests/run-browser.mjs`: **17 PASS, 1 FAIL, 1 NOT EXECUTED**; el FAIL conocido del redirect público → interno bajo `route()` permanece visible.
- `npm test`: **98/98 PASS**.
- `npm run build`: `PASS`.
- `npm run lint`: `PASS`.
- `npm run typecheck`: `PASS`.
- `npm run check`: `PASS`.
- `git diff --check`: `PASS`.

No se añadieron dependencias. `src/`, `package.json`, `package-lock.json` y `pnpm-lock.yaml` deben permanecer sin cambios.
