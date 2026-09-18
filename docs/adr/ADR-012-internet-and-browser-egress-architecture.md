# ADR-012: Internet & Browser Egress Architecture Decision Gate

## Estado

Provisional / `decision-gate`. No es una decisión final ni autoriza implementación productiva. Se mantiene vigente tras las actualizaciones posteriores de evidencia de Phase 8. Service Worker tiene evidencia `PASS` en localhost; HTTPS sigue `NOT EXECUTED`; DNS/socket pinning sigue `SIMULATED`/`NOT EXECUTED`, y no existe selección productiva definitiva.

## Contexto

Phase 8 ya tiene definición, spike de providers/sandbox, controlled tests, ejecución externa, egress boundary spike y hardening por canal. La evidencia demuestra que `browserContext.route()` no basta como frontera completa: un redirect público→interno alcanzó el fixture. Un proxy/egress fixture local bloqueó redirects, secundarios y WebSocket con `internalHits=0`. Un fixture adicional en `localhost` permitió ejecutar un Service Worker real y demostró observación/bloqueo del destino interno con `internalHits=0`; HTTPS, DNS rebinding real, browser remoto, aislamiento del host y crash cleanup seguro siguen sin evidencia suficiente.

## Decisión provisional

Establecer como gate obligatorio que cualquier `BrowserProvider` futuro use una frontera de egress inferior al browser. `browserContext.route()` puede aportar observabilidad o rechazo temprano, pero no puede ser el único control SSRF/egress.

El proxy/egress boundary es el candidato provisional mejor respaldado por la evidencia disponible porque permitió observar el destino efectivo del fixture y bloquear por canal. Esto **no** selecciona un proxy productivo ni descarta aislamiento de red o una combinación. La elección final queda bloqueada hasta cerrar las pruebas pendientes.

La ruta futura permanece conceptualmente:

```text
AssistantCore
  -> Internet/Browser capability
  -> ToolManager / policy boundary
  -> provider adapter
  -> browser + egress boundary
```

## Evidencia

- Fetch/SSRF/DNS: `29/29 PASS` en fixtures controlados.
- Route baseline: `17 PASS`, `1 FAIL`, `1 NOT EXECUTED`; redirect público→interno con `internalHits=1`.
- Egress boundary: `19 PASS`, `0 FAIL`, `2 NOT EXECUTED`; `internalHits=0`.
- Hardening: ocho canales ejecutados con `PASS` individual y `internalHits=0`; el fixture adicional de Service Worker en `localhost` obtuvo `PASS` con observación y bloqueo individual.
- DNS rebinding/socket pinning: `SIMULATED`/`NOT EXECUTED` para socket real, sin pinning demostrado.
- DNS/socket egress controlado: el fixture local observó `public.test` → `127.0.0.2` y `socket.remoteAddress=127.0.0.2`; bloqueó `internal.test` → `127.0.0.3` antes de conectar con `internalHits=0`. El cambio controlado `127.0.0.2 → 127.0.0.3` para `rebind.test` permanece `SIMULATED` y no demuestra DNS rebinding público ni pinning productivo.
- HTTPS público→HTTPS, HTTPS→HTTP y HTTPS→interno: `NOT EXECUTED`; no existe fixture TLS seguro y reproducible en este entorno.
- La subetapa HTTPS/TLS confirmó que Playwright/Chromium puede iniciar en un contexto efímero, pero no existe un mecanismo de emisión y confianza de certificado X.509 efímero compatible con las restricciones actuales. HTTPS público→HTTPS, HTTPS→HTTP, HTTPS→interno y CONNECT/WebSocket sobre TLS permanecen `NOT EXECUTED`; no se usó `ignoreHTTPSErrors`, no se modificó el trust store y no se añadió una dependencia de certificados.
- Browser remoto y crash cleanup: `NOT EXECUTED`.
- Browser local: contexto efímero, sandbox solicitado y cleanup normal; sin prueba de aislamiento OS-level.
- Host isolation evidence: contexto efímero sin storage heredado, rechazo browser-level de `file://` desde una página HTTP y cleanup normal/timeout/shutdown con árbol temporal eliminado. El sandbox fue solicitado, pero filesystem/sandbox OS-level y crash cleanup permanecen `LIMITATION`/`NOT EXECUTED`; esta evidencia no cierra el gate ni selecciona Playwright como dependencia productiva.
- Provisioning experimental: Playwright `1.63.0` pudo iniciar Chrome Headless Shell `153.0.8010.12` con sandbox solicitado; esta disponibilidad local no selecciona un browser productivo ni cierra el gate.

## Revisión consolidada

La revisión consolidada de `docs/phase-08-decision-gate-review.md` clasifica la evidencia sin convertir `FAIL`, `SIMULATED`, `LIMITATION` o `NOT EXECUTED` en `PASS`. Confirma como evidencia reproducible acotada los policies Fetch/SSRF, el bloqueo por proxy fixture de navegación, redirects, subrecursos, fetch/XHR y WebSocket, la relación DNS/IP/socket del fixture local, y el storage/cleanup normal del browser efímero.

La misma revisión conserva como evidencia negativa el redirect público→interno que alcanzó el fixture bajo `browserContext.route()`. Service Worker tiene `PASS` únicamente en el fixture localhost del gate; debe confirmarse para el browser/provider elegido. HTTPS/TLS, DNS rebinding/pinning productivo, aislamiento OS/network, browser remoto, Search real y crash cleanup siguen pendientes o limitados por el entorno.

Esta clasificación no cambia la decisión provisional: no selecciona proxy, gateway, browser local/remoto, Playwright productivo, sandbox, aislamiento de red ni provider.

## No decidido

Este ADR no decide:

- proxy o gateway concreto;
- aislamiento de red del host;
- combinación route + proxy;
- browser local, remoto o servicio independiente;
- Playwright como dependencia productiva;
- provider Search/Fetch/Browser;
- límites numéricos definitivos.

## Criterios para convertir el gate en decisión

La decisión final requiere evidencia reproducible de:

1. Service Worker que intente acceder a un destino interno y sea observado/bloqueado. Esta condición está demostrada en el fixture `localhost`; todavía debe confirmarse para el provider/browser elegido.
2. HTTPS público→HTTPS público, HTTPS→HTTP y HTTPS→interno.
3. Resolución controlada con múltiples A/AAAA, cambio de respuesta y relación entre IP validada, IP efectiva y socket usado.
4. `internalHits=0` por navegación, redirects, subrecursos, fetch/XHR, WebSocket y Service Worker.
5. Egreso y aislamiento verificables para browser local o remoto, incluyendo filesystem, sandbox y credenciales.
6. Cleanup normal, timeout, shutdown y crash seguro.
7. Coste, latencia, cancelación, observabilidad y operación Windows medidos en el modo elegido.

## Consecuencias

La consecuencia positiva es que no se inicia producción con una garantía basada solo en interception. La consecuencia negativa es que la implementación de providers permanece bloqueada hasta obtener un entorno de evidencia más completo. La simulación DNS y el cleanup normal no se presentan como equivalentes a pinning o crash cleanup.

## Referencias

- `docs/phase-08-remaining-evidence-results.md`
- `docs/phase-08-architecture-decision-draft.md`
- `docs/phase-08-egress-boundary-spike.md`
- `docs/phase-08-egress-hardening-results.md`
- `docs/phase-08-decision-gate-review.md`
- `docs/adr/ADR-011-internet-and-browser-definition.md`
