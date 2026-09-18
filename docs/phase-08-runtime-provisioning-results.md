# Phase 8 — Experimental Browser Runtime Provisioning Results

## Estado y alcance

Esta subetapa prepara únicamente el runtime experimental necesario para repetir los harnesses browser de Phase 8. La rama `phase/08-internet-browser-runtime-provisioning` parte de `origin/main` `11529d8f90a2027957a22675de0c63716bc79ad7`.

No se implementan `BrowserProvider`, `WebFetchProvider`, `WebSearchProvider`, `ToolManager` ni integración con `AssistantCore`. No se modifica `src/`, no se añaden dependencias y Playwright continúa siendo una `devDependency` experimental.

## Playwright y Chromium

| Comprobación | Antes del provisioning | Después del provisioning |
|---|---|---|
| Playwright | `1.63.0` instalado y declarado en `package.json` | `1.63.0`, sin cambios |
| Ejecutable browser | `chromium.launch()` falló porque faltaba `chromium_headless_shell-1243` | Inicio correcto |
| Chromium | No utilizable localmente | Chrome Headless Shell `153.0.8010.12`, Playwright `chromium-headless-shell v1243` |
| Sandbox | No se pudo comprobar sin browser | `chromiumSandbox=true`, sin `--no-sandbox` |

El provisioning se realizó mediante el mecanismo oficial de Playwright:

```text
npx playwright install chromium-headless-shell
```

El ejecutable quedó fuera del repositorio, administrado por Playwright, en:

```text
C:\Users\SILIUS\AppData\Local\ms-playwright\chromium_headless_shell-1243
```

No se instaló un navegador externo, no se modificó `package.json` ni ningún lockfile, no se cambió el trust store de Windows y no se instaló el browser dentro del workspace. Esta instalación es estado experimental de la máquina y no constituye una dependencia de producción.

## Inicio y aislamiento

La comprobación directa de inicio terminó en `PASS` con Chromium `153.0.8010.12`. Los harnesses repetidos solicitaron sandbox habilitado, contextos efímeros y directorios temporales dedicados. No se utilizó el perfil principal ni storage state persistente.

El cleanup normal de contexto, browser, proxy, fixture y directorio temporal terminó en `PASS` donde fue ejercitado. Crash cleanup sigue `NOT EXECUTED`; no se usaron APIs de terminación de procesos para simularlo.

## Harnesses repetidos

### External browser

`node scripts/phase-08-external-tests/run-browser.mjs`:

- `17 PASS`;
- `1 FAIL`: el redirect público → interno alcanzó el fixture bajo routing;
- `1 NOT EXECUTED`: crash cleanup.

El fallo se conserva explícitamente y confirma que `browserContext.route()` no es una frontera completa de egress/SSRF.

### Egress boundary spike

`node scripts/phase-08-egress-boundary-spike/run.mjs`:

- `21` comprobaciones;
- `19 PASS`;
- `0 FAIL`;
- `2 NOT EXECUTED` por Service Worker en ese fixture;
- `internalHits=[]`.

Navegación, redirects, imagen, script, stylesheet, iframe, fetch/XHR y WebSocket fueron observados y bloqueados por el proxy fixture cuando apuntaban a destinos internos. Service Worker no se convierte en `PASS` en este harness.

### Egress hardening

`node scripts/phase-08-egress-hardening/run.mjs`:

- `21` comprobaciones;
- `14 PASS`;
- `0 FAIL`;
- `6 NOT EXECUTED`;
- `1 SIMULATED` para DNS rebinding;
- `internalHits=[]`.

Los tres casos HTTPS permanecen `NOT EXECUTED`; no se introdujeron certificados, llaves, `ignoreHTTPSErrors` ni cambios de seguridad.

### Gate evidence

`node scripts/phase-08-gate-evidence/run.mjs`:

- `1 PASS`;
- Service Worker real en localhost observado por el proxy y bloqueado;
- `internalHits=[]`.

Esta evidencia permanece limitada al fixture localhost y no selecciona browser, provider, proxy o arquitectura productiva.

## Resultados no cubiertos

- HTTPS público → HTTPS, HTTPS → HTTP y HTTPS → interno: `NOT EXECUTED`.
- DNS/socket pinning real: `SIMULATED`/`NOT EXECUTED`.
- Browser remoto: `NOT EXECUTED`.
- Crash cleanup seguro: `NOT EXECUTED`.
- Search real: `NOT EXECUTED` por ausencia de credenciales.

Provisionar Chromium solo resuelve la disponibilidad del runtime. No convierte estos resultados en evidencia TLS, pinning de socket, aislamiento OS-level ni una decisión productiva.

## Seguridad y límites

No se solicitaron ni almacenaron credenciales. No se usó el perfil principal, no se desactivó el sandbox, no se añadieron APIs de procesos, `child_process`, `spawn`, `exec` ni shell al proyecto. No se implementaron providers ni browser automation integrada al producto.

ADR-012 permanece provisional y en `decision-gate`. Esta subetapa registra disponibilidad experimental del browser; no cierra el gate ni selecciona Playwright, Chromium, proxy, sandbox, aislamiento de red o provider como decisión definitiva.
