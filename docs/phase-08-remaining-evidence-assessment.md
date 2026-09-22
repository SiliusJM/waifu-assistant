# Phase 8 — Remaining Evidence Assessment

## Estado

`DOCUMENTARY SPIKE ONLY`. No existe una prueba nueva de evidencia suficientemente útil y segura para ejecutar en el entorno actual. Los criterios pendientes conservan sus estados `PASS`, `FAIL`, `LIMITATION`, `NOT EXECUTED` o `SIMULATED`; no se reclasifica ninguno.

Base auditada: `origin/main` en `9be8bed48dee0aa46ddc1bc93c8007a2bd62c92b`.

ADR-012 continúa provisional / `decision-gate`. Esta etapa no implementa `WebSearchProvider`, `WebFetchProvider` ni `BrowserProvider`, no selecciona arquitectura productiva y no avanza a Phase 9.

## 1. Alcance de la auditoría

Se revisaron ADR-012 y la documentación de definición, providers/sandbox, controlled tests, ejecución externa, egress boundary, hardening, gate evidence, DNS/socket, HTTPS/TLS, runtime provisioning, host isolation, capability spike, OS/network evidence y decision-gate review.

Los documentos de resultados conservan sus bases y fechas históricas porque describen ejecuciones concretas. Esta evaluación usa como referencia de estado actual el `origin/main` indicado arriba y no reinterpreta esas ejecuciones como nuevas.

### Reconciliación posterior

La evaluación original fue anterior a la ejecución browser con NetLog del 2026-09-22. Esa ejecución actualiza únicamente la caracterización del DNS rebinding browser a `REAL / OBSERVED + LIMITATION`: observó el primer endpoint `1.1.1.1:80`, el segundo endpoint `10.20.0.1:80` y un timeout real. No satisface el contrato formal del classifier ni demuestra egress artifact, `internalHits=0`, correlación cross-VM formal o pinning productivo; por tanto, no cierra el decision-gate ni convierte los criterios pendientes en `PASS`.

## 2. Criterios del decision-gate

| Criterio | Estado actual | Clasificación para una nueva prueba | Bloqueo y siguiente requisito |
|---|---|---|---|
| Service Worker en el runtime/provider elegido | `PASS` acotado en fixture `localhost`; cobertura general pendiente | `BLOCKED` | No existe provider productivo seleccionado; el `PASS` previo no se repite sin un runtime/boundary candidato concreto. |
| HTTPS público→HTTPS público | `NOT EXECUTED` | `BLOCKED` / `NOT EXECUTABLE IN CURRENT ENVIRONMENT` | El fixture TLS confiable y reproducible sigue sin estar disponible bajo las restricciones actuales. |
| HTTPS→HTTP | `NOT EXECUTED` | `BLOCKED` | Requiere fixture HTTPS controlado para medir la política de downgrade dentro del mismo boundary. |
| HTTPS→destino interno | `NOT EXECUTED` | `BLOCKED` | Requiere handshake TLS controlado y frontera inferior que registre el destino efectivo. |
| CONNECT/WebSocket sobre TLS | `NOT EXECUTED` | `BLOCKED` | Depende del mismo fixture TLS; no se usará `ignoreHTTPSErrors` ni trust store modificado. |
| DNS rebinding real, múltiples A/AAAA y pinning | Browser NetLog: `REAL / OBSERVED + LIMITATION`; pinning formal `SIMULATED` / `NOT EXECUTED` | `REQUIRES EXTERNAL/DEDICATED ENVIRONMENT` | El segundo endpoint TCP `10.20.0.1:80` y el timeout ya fueron observados; faltan fresh clock reference, DNS/egress JSON formal, `internalHits=0`, múltiples A/AAAA y pinning productivo. |
| Egress inferior al browser en el runtime elegido | `PASS` parcial en proxy fixture; aislamiento host `NOT EXECUTED` | `REQUIRES EXTERNAL/DEDICATED ENVIRONMENT` | El proxy fixture no demuestra política efectiva del SO; falta un límite inferior real dentro de VM/Sandbox o servicio remoto controlado. |
| Aislamiento OS-level de red y filesystem | `LIMITATION` / `NOT EXECUTED` | `REQUIRES EXTERNAL/DEDICATED ENVIRONMENT` | La sesión no es administrativa, Windows Sandbox no está confirmado y no hay VM/distro utilizable; no se habilitarán features ni Firewall. |
| Browser remoto | `NOT EXECUTED` | `REQUIRES EXTERNAL/DEDICATED ENVIRONMENT` | Faltan endpoint, aislamiento, lifecycle, observabilidad y credenciales temporales explícitas. |
| Search Brave/Tavily/Exa | `NOT EXECUTED` | `BLOCKED` | Faltan credenciales temporales proporcionadas para la ejecución; no se solicitarán, inventarán ni almacenarán secretos. |
| Crash cleanup | `NOT EXECUTED` | `NOT EXECUTABLE IN CURRENT ENVIRONMENT` | No existe un método seguro permitido para provocar el crash sin shell, PowerShell, `child_process`, `spawn`, `exec` o terminación arbitraria. |
| Cleanup normal/timeout/shutdown | `PASS` controlado | `EXECUTABLE NOW` (ya demostrado; no pendiente) | No requiere repetición. No equivale a crash cleanup ni a cleanup OS-level. |
| Separación de autoridad, no shell y logs seguros | `PASS` en regresión/policies existentes | `EXECUTABLE NOW` (ya demostrado; no pendiente) | Mantener como invariante en cualquier prototipo futuro; no constituye evidencia de aislamiento. |

## 3. Evidencia que no debe repetirse ahora

No se repiten los siguientes casos porque la limitación es la misma y el resultado no aportaría evidencia nueva:

- intento de fixture HTTPS/TLS sin mecanismo confiable de certificado efímero;
- simulación local de DNS rebinding ya marcada `SIMULATED`; la observación browser NetLog posterior no se repite mientras no cambie el entorno;
- comprobaciones browser-only de sandbox, filesystem o cleanup normal;
- capacidad OS/network sin permisos o infraestructura dedicada;
- crash cleanup mediante terminación de procesos;
- Search real sin credenciales temporales;
- browser remoto sin endpoint y entorno remoto.

Repetirlos en el mismo host podría producir el mismo `NOT EXECUTED` sin cerrar ningún criterio y aumentaría el riesgo de sobreinterpretar disponibilidad de Chromium o del proxy fixture.

## 4. Clasificación de evidencia actual

### Evidencia positiva acotada

- Fetch/SSRF/DNS y policies controladas: `29/29 PASS`.
- Egress proxy fixture: navegación, redirects, subrecursos, fetch/XHR y WebSocket bloqueados en los casos ejecutados, con `internalHits=0`.
- Service Worker: `PASS` solamente en el fixture `localhost` del gate.
- DNS/socket local: relación controlada entre hostname, IP validada, IP efectiva y `socket.remoteAddress`.
- Contextos efímeros, storage no heredado, cleanup normal/timeout/shutdown: `PASS` dentro del harness local.

### Evidencia negativa o pendiente que se conserva

- `browserContext.route()` como boundary único: `FAIL` deliberado por redirect público→interno.
- DNS rebinding browser: `REAL / OBSERVED + LIMITATION`; pinning productivo y consolidación formal: `SIMULATED` / `NOT EXECUTED`.
- HTTPS/TLS: `NOT EXECUTED` / `LIMITATION`.
- Aislamiento OS/network y filesystem: `LIMITATION` / `NOT EXECUTED`.
- Browser remoto: `NOT EXECUTED`.
- Search real: `NOT EXECUTED`.
- Crash cleanup: `NOT EXECUTED`.

## 5. Próximo experimento justificable

No se selecciona una prueba ejecutable en este entorno. El siguiente experimento útil requiere una máquina o sesión dedicada que proporcione, antes de modificar el repositorio:

1. permisos e infraestructura para una VM temporal, Windows Sandbox confirmado o browser remoto aislado;
2. una frontera de egress inferior que observe destino efectivo, DNS y socket;
3. un fixture TLS efímero y confiable, sin trust store permanente ni bypasses;
4. un método de cleanup y supervisión seguro, incluido un diseño explícito para crash cleanup;
5. credenciales temporales separadas únicamente si se decide ejecutar Search o browser remoto.

En ese entorno, el orden recomendado es: validar disponibilidad y rollback; ejecutar HTTPS y egress inferior; ejecutar DNS/socket con múltiples A/AAAA; repetir Service Worker en el runtime candidato; medir cleanup; y solo después ejecutar Search con credenciales temporales. Cada caso debe reportarse individualmente y conservar `internalHits`, hostname, IP validada, IP efectiva, socket, estado TLS y artefactos de cleanup.

## 6. Impacto en ADR-012

ADR-012 permanece provisional / `decision-gate`. Esta auditoría no añade evidencia de red, TLS, Search, browser remoto, crash cleanup ni aislamiento OS-level. Tampoco cambia la decisión provisional de exigir una frontera de egress inferior al browser.

La implementación productiva de `WebSearchProvider`, `WebFetchProvider` y `BrowserProvider` sigue bloqueada hasta que los criterios pendientes se ejecuten en un entorno que permita evidencia reproducible. No se selecciona proxy productivo, gateway, browser local/remoto, sandbox, VM, Firewall ni proveedor concreto.

## 7. Verificaciones de esta etapa

El cambio de esta rama es exclusivamente documental. Antes del commit deben pasar `npm test`, `npm run build`, `npm run lint`, `npm run typecheck`, `npm run check` y `git diff --check`; `src/`, `package.json` y lockfiles deben permanecer sin cambios.
