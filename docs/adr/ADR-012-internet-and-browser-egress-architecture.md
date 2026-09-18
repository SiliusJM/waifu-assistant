# ADR-012: Internet & Browser Egress Architecture Decision Gate

## Estado

Provisional / `decision-gate`. No es una decisión final ni autoriza implementación productiva. Preparado en `phase/08-internet-browser-architecture-decision` después del merge de PR #14.

## Contexto

Phase 8 ya tiene definición, spike de providers/sandbox, controlled tests, ejecución externa, egress boundary spike y hardening por canal. La evidencia demuestra que `browserContext.route()` no basta como frontera completa: un redirect público→interno alcanzó el fixture. Un proxy/egress fixture local bloqueó redirects, secundarios y WebSocket con `internalHits=0`, pero Service Worker, HTTPS, DNS rebinding real, browser remoto, aislamiento del host y crash cleanup seguro siguen sin evidencia suficiente.

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
- Hardening: ocho canales ejecutados con `PASS` individual y `internalHits=0`; Service Worker `NOT EXECUTED`.
- DNS rebinding: `SIMULATED`, sin pinning real.
- HTTPS, browser remoto y crash cleanup: `NOT EXECUTED`.
- Browser local: contexto efímero, sandbox solicitado y cleanup normal; sin prueba de aislamiento OS-level.

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

1. Service Worker que intente acceder a un destino interno y sea observado/bloqueado, o una limitación de provider explícitamente aceptada por threat model.
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
- `docs/adr/ADR-011-internet-and-browser-definition.md`
