# Project Status

## Current Phase

Phase 8 — Internet & Browser (definición, spikes y controlled/external tests aprobados y mergeados; implementación de producción no iniciada).

## Status

Phase 6 fue revisada técnicamente, corregida y mergeada en `main` mediante PR #6. El merge quedó registrado en `532c956e2a407b9e9e540584947a24739490bb03`. La definición de Phase 7 fue revisada, corregida y mergeada mediante PR #7; el merge quedó registrado en `c30ccd3bff298c37cc1dd12a01ec775074b83b02`. La implementación de Phase 7 fue revisada, corregida y mergeada mediante PR #8; el merge quedó registrado en `417a30deca884f55057164475b08b2521d47347d`. La definición de Phase 8 fue revisada y mergeada mediante PR #9; el merge quedó registrado en `ef17ff897b2d25d1c402d271d4a3631b26b3fa5b`. El spike de providers y sandbox fue revisado y mergeado mediante PR #10; el merge quedó registrado en `bb29fb303c83eeed2c73b7d4944479756c2362ea`. Los controlled tests fueron revisados y mergeados mediante PR #11; el merge quedó registrado en `35045dcf9bcd9ff6b31c9bb7908af7872daae5a3`. La ejecución externa fue revisada y mergeada mediante PR #12; el merge quedó registrado en `4be0966603feeb97ad04cb86ea1f1c95f08d1d82`. El egress boundary spike fue revisado y mergeado mediante PR #13; el merge quedó registrado en `cd22a2fd8f8b979c5ef32ecdb63f66ff50a94079`. El egress hardening fue revisado y mergeado mediante PR #14; el merge quedó registrado en `9dab02d72e710e691121da27489474d1ed4ccf3b`. El architecture decision gate fue revisado y mergeado mediante PR #15; el merge quedó registrado en `8709da3cf3957f1f16163a9baecdff7ecb1c7cbd`. La evidencia ejecutable del gate fue revisada y mergeada mediante PR #16; el merge quedó registrado en `068bef145b2a0092f806c98e0dfd623b54bb33c9`. La evidencia HTTPS/DNS fue revisada y mergeada mediante PR #17; el merge quedó registrado en `0183ab6c76379ccda90e9602df3ce13aab0c0225`. La limitación del fixture TLS fue revisada y mergeada mediante PR #18; el merge quedó registrado en `25985396222c8dc51db9f71b55606cf85aab2254`. El provisioning experimental del runtime browser fue revisado y mergeado mediante PR #19; el merge quedó registrado en `4e442e1669f2d199228e0ad7829f585f67b18c58`. La evidencia DNS/socket fue revisada y mergeada mediante PR #20; el merge quedó registrado en `88c49433ccf4922612c9eeafd7df32d947f35c18`. La evaluación HTTPS/TLS fue revisada y mergeada mediante PR #21; el merge quedó registrado en `0288137f8b0eb5601d4a84060cd1091ad9aaef18`. La evidencia de aislamiento browser/host fue revisada y mergeada mediante PR #22; el merge quedó registrado en `3f736d864a94c3139eff70acdc9a5e18417623ae`. La revisión consolidada de ADR-012 fue revisada y mergeada mediante PR #23; el merge quedó registrado en `c0ecf47a342f21cddddfb7a2c75905ae9b144698`. La evaluación de capacidades de aislamiento de red/host fue revisada y mergeada mediante PR #24; el merge quedó registrado en `4ab2bf774fd2d276a824415117a8303eadbab8f8`. La etapa de evidencia OS/network fue revisada y mergeada mediante PR #25; el merge quedó registrado en `d8d07c2a0eac845d593302e5ed19d19c71a12b3a`. La evaluación de evidencia restante fue revisada y mergeada mediante PR #26; el merge quedó registrado en `197cd1c24b6b9499f9a96861c7b5902b2d0d8104`. La preparación del entorno experimental fue revisada y mergeada mediante PR #27; el merge quedó registrado en `cdb70f5b6b61464e70492131e63818eacf827328`. La evidencia real de DNS rebinding controlado fue revisada y mergeada mediante PR #28; el merge quedó registrado en `e0dfefe36844f9c212828a4aeb78751cb42098a0`. El harness experimental de navegador para DNS rebinding fue revisado y mergeado mediante PR #29; el merge quedó registrado en `30646455dd2b5ab2285cb931a9fa3e32dd88c323`.

## Completed

- Diagnóstico inicial del entorno, repositorio, Git, herramientas y limitaciones.
- Repositorio Git local inicializado en la rama main.
- Reglas de trabajo y seguridad documentadas.
- Esqueleto mínimo Node.js ESM ejecutable.
- Logger estructurado con redacción de claves sensibles.
- Build, lint sintáctico y tests básicos reproducibles sin dependencias externas.
- Arquitectura base, riesgos y decisión provisional sobre proveedores documentados.
- Changelog actualizado.
- Remote origin configurado y rama main publicada en GitHub: https://github.com/SiliusJM/waifu-assistant.
- TypeScript estricto, ESLint y configuración de compilación reproducible implementados para Phase 1.
- AssistantCore, Session, Message, Context, Response y providers implementados.
- Errores categorizados, cancelación, timeout y retry explícito implementados.
- Tests unitarios y de integración HTTP controlados pasando sin credenciales externas.
- Rama `phase/02-tools` creada y publicada desde el merge de Phase 1.
- Contrato, registry, manager, validación, autorización, contexto, resultados y errores de tools implementados en la rama de Phase 2.
- PR #2 revisado y mergeado a `main`.
- EventBus, runtime, scheduler, stream, máquina de estados y adapters de Phase 3 implementados.
- PR #3 revisado, corregido y mergeado a `main`.
- Race condition de terminalización corregida y cubierta por pruebas adicionales.
- Documentación post-merge de Phase 2 y Phase 3 reconciliada con el estado real de `main`.
- Definición arquitectónica de Phase 4 auditada y aprobada.
- Contratos de audio, providers abstractos, `VoiceSession`, `VoiceService`, eventos, errores y mocks de Phase 4 implementados.
- Cancelación, timeout por etapa, cleanup, logging seguro y correlación explícita con `RealtimeEngine` implementados.
- Tests de Phase 4: 57/57 pasando según la verificación realizada en la rama de la fase.
- PR #4 revisado técnicamente y mergeado a `main`.
- Contratos streaming, queues acotadas, coordinación de concurrencia, interruption/supersede, cancelación jerárquica, métricas y mocks de Phase 5 implementados.
- PR #5 revisado, corregido y mergeado a `main`.
- Correcciones de métricas de interrupción y políticas de buffering revisadas y cubiertas por pruebas.
- Tests de Phase 5: 72/72 pasando según la verificación realizada antes del merge.
- Personality System, catálogo de traits/reglas, validación estricta, policy/compiler, snapshots, registry multi-perfil e integración opcional con `AssistantCore` implementados.
- PR #6 revisado, corregido y mergeado a `main`.
- Correcciones de inmutabilidad del registry, validación runtime de overrides y separación de `identity.description` revisadas y cubiertas por pruebas.
- Tests de Phase 6: 83/83 pasando según la verificación realizada antes del merge.
- Núcleo de Avatar System implementado con controller, runtime, provider abstracto, provider mock, snapshots, lifecycle, capabilities, policy cerrada, eventos y errores tipados.
- Tests de Phase 7 añadidos y endurecidos para lifecycle, estados, REACTION/baseState, ordering, latest-wins, providers interrumpibles/no interrumpibles, shutdown, capabilities, validación runtime de señales y seguridad; cierre verificado con 98/98 tests.
- Controlled tests de Phase 8 ejecutados y mergeados mediante PR #11.
- Harness reproducible con 20 consultas Search, fixtures de Fetch, SSRF/DNS/redirect/cancelación/límites y policies explícitas de MIME y workspace.
- Fetch/SSRF/DNS: 29/29 comprobaciones PASS.
- Search: Brave, Tavily y Exa permanecen `NOT EXECUTED` por falta de credenciales.
- External browser local: 17 PASS, 1 FAIL y 1 NOT EXECUTED; el FAIL observó un redirect público → interno que alcanzó el fixture interno.
- Egress secundario: se observaron/bloquearon image, script, stylesheet, iframe, fetch/XHR y WebSocket dentro del harness; esta evidencia no equivale a aislamiento de red.
- Service Worker: comportamiento observado con limitación explícita de routing.
- Sandbox: se solicitó Chromium con `chromiumSandbox=true` y sin `--no-sandbox`; esto no se considera prueba OS-level de efectividad del sandbox.
- Browser remoto y DNS rebinding real: `NOT EXECUTED`.
- Crash cleanup seguro: `NOT EXECUTED`; cleanup normal de context/browser y timeout sí fueron ejecutados.
- Playwright `1.63.0` fue añadido únicamente como `devDependency` experimental para el harness externo.
- El harness externo no añadió APIs de procesos, shell, providers productivos ni cambios en `src/`.
- Egress boundary spike: 19 PASS, 0 FAIL y 2 NOT EXECUTED, con `internalHits=0`.
- El proxy fixture bloqueó redirects públicos hacia destinos internos y WebSocket interno mediante CONNECT.
- Service Worker en el egress fixture: NOT EXECUTED; Chromium no expuso `navigator.serviceWorker` para el origen controlado.
- DNS rebinding controlado real dentro de VirtualBox ya tiene evidencia `PASS`; el rebinding público/productivo, el pinning y la validación IP efectiva justo antes del socket dentro de BrowserProvider siguen pendientes.
- Egress hardening por canal: 14 PASS, 0 FAIL, 6 NOT EXECUTED y 1 SIMULATED; `internalHits=[]`.
- Egress architecture decision gate: ADR-012 provisional; `browserContext.route()` queda descartado como boundary único y cualquier BrowserProvider futuro deberá usar una frontera de egress inferior. La selección concreta sigue abierta.
- Gate evidence: Service Worker real en localhost `PASS`, con request generada, proxy observado, destino `127.0.0.1`, bloqueo e `internalHits=0`.
- HTTPS público→HTTPS, HTTPS→HTTP y HTTPS→interno permanecen `NOT EXECUTED`; la viabilidad del fixture TLS queda documentada como `NOT EXECUTED`/`LIMITATION`; DNS/socket pinning permanece `SIMULATED`/`NOT EXECUTED`.
- No se seleccionó todavía proxy productivo, aislamiento de red, browser remoto ni combinación definitiva.
- Runtime browser experimental provisionado fuera del repositorio mediante Playwright `1.63.0`; Chrome Headless Shell `153.0.8010.12` inició con sandbox solicitado. El provisioning no modifica `src/`, manifests ni lockfiles y no cierra ADR-012.
- Evidencia DNS/socket local controlada: `public.test` observó `127.0.0.2` como IP validada, efectiva y `socket.remoteAddress`; `internal.test` fue bloqueado antes del socket con `internalHits=0`; el cambio `127.0.0.2 → 127.0.0.3` permanece `SIMULATED`.
- Evaluación HTTPS/TLS: Chromium inicia y cierra correctamente en contexto efímero, pero HTTPS→HTTPS, HTTPS→HTTP, HTTPS→interno y CONNECT/WebSocket sobre TLS permanecen `NOT EXECUTED / LIMITATION`; no se creó certificado ni se modificaron trust store, dependencias o APIs de proceso.
- Evidencia host/browser: `10` checks con `7 PASS`, `0 FAIL`, `2 LIMITATION` y `1 NOT EXECUTED`; storage entre contextos efímeros, timeout, shutdown y cleanup normal pasaron. Filesystem y sandbox OS-level permanecen como `LIMITATION` y crash cleanup como `NOT EXECUTED`.
- Revisión consolidada de ADR-012 preparada en `docs/phase-08-decision-gate-review.md`; el gate permanece provisional, conserva el `FAIL` de `browserContext.route()` y separa evidencia controlada, simulada, limitada y pendiente.
- Spike de capacidades de network/host isolation documentado en `docs/phase-08-network-host-isolation-capability-spike.md`; se observaron señales de Hyper-V, Firewall, vEthernet y WSL2, pero no se obtuvo evidencia OS-level ni se modificó el host.
- Evidencia OS/network documentada en `docs/phase-08-network-host-isolation-evidence-results.md`; la ejecución real quedó `NOT EXECUTED`/`LIMITATION` por falta de un entorno administrativo/dedicado reproducible, sin nuevos `PASS`/`FAIL`.
- Evaluación consolidada de evidencia restante documentada en `docs/phase-08-remaining-evidence-assessment.md`; no se identificó una nueva prueba segura y útil ejecutable en el entorno actual y los criterios pendientes conservan sus categorías.
- Checklist de readiness del entorno experimental documentado en `docs/phase-08-experimental-environment-readiness.md`; define requisitos de entrada, rollback y evidencia por prueba sin alterar el host de trabajo.
- Evidencia real de DNS rebinding controlado documentada en `docs/phase-08-dns-rebinding-real-evidence.md`; `rebind.test` alternó entre `1.1.1.1` y `10.20.0.1`, el intento a `10.20.0.1:22` fue bloqueado y `nftables` registró 12 paquetes/788 bytes DROP.
- Harness experimental de navegador DNS rebinding documentado en `docs/phase-08-browser-dns-rebinding-evidence.md`; 27/27 pruebas deterministas pasan y el consolidado exige DNS1/DNS2 correlacionados con `request.timing()`, referencia de reloj, delta diferencial de `nftables` e `internalHits=0`.

## In Progress

Ninguno. El architecture decision gate fue documentado y mergeado; la implementación productiva de Phase 8 todavía no ha comenzado.

## Blocked

- Las métricas de hardware siguen pendientes por el bloqueo de WMI.
- La selección final de proveedores de STT/TTS requiere pruebas locales comparables de compatibilidad, latencia, calidad, consumo, cancelación y licencias.
- Search requiere credenciales temporales para ejecutar el benchmark real.
- Browser remoto y DNS rebinding público/productivo requieren entornos/evidencia adicionales; el rebinding controlado real ya fue ejecutado y documentado en VirtualBox y ahora dispone de un harness de correlación Chromium reproducible.
- La evidencia DNS/socket continúa limitada al fixture local controlado para IP efectiva/socket; el nuevo experimento sí demuestra rebinding DNS controlado real (`rebind.test`) y bloqueo del destino privado, pero no demuestra pinning productivo, DNS público cambiante ni múltiples A/AAAA en un escenario productivo.
- El fixture HTTPS/TLS sigue bloqueado por la ausencia de un mecanismo de emisión y confianza X.509 efímero compatible con Chromium bajo las restricciones actuales.
- La evidencia de host isolation no demuestra aislamiento OS-level del filesystem ni efectividad OS-level del sandbox; crash cleanup continúa sin ejecutar.
- El spike de network/host isolation no confirmó Windows Sandbox ni capacidad administrativa para gestionar VMs/switches; la identificación exacta del producto/versión del sistema operativo permanece `LIMITATION` por señales inconsistentes.
- El redirect público → interno demuestra que `browserContext.route()` no debe tratarse como frontera completa de egress/SSRF.
- El egress boundary proxy fixture bloqueó el mismo caso con `internalHits=0`, pero esto no demuestra todavía aislamiento de red del host ni pinning real de sockets.
- El fixture egress original no pudo ejecutar Service Worker, pero el nuevo gate fixture en localhost sí demostró una request de Service Worker observada y bloqueada; todavía falta confirmar el comportamiento en el browser/provider elegido.

## Next

Sin introducir código de producción todavía:
1. Resolver, solo si es posible sin debilitar TLS ni usar APIs de proceso, la limitación del fixture X.509 efímero y después repetir HTTPS→HTTPS, HTTPS→HTTP y HTTPS→interno.
2. Probar el mecanismo con resolución efectiva y DNS rebinding real en un entorno aislado; mantener la simulación separada.
3. Evaluar un entorno de aislamiento de red/host que permita demostrar límites OS-level sin depender de una configuración browser-only.
4. Repetir Search con credenciales temporales para Brave, Tavily y Exa y medir las 20 consultas.
5. Evaluar browser remoto y crash cleanup seguro.
6. Cerrar el `decision-gate` de ADR-012 con evidencia reproducible antes de implementar `WebSearchProvider`, `WebFetchProvider` o `BrowserProvider`.
7. Ejecutar el harness de DNS rebinding en el laboratorio VirtualBox y obtener evidencia real correlacionada de `DNS -> lookup Chromium -> intento browser -> delta de egress -> decisión del boundary`.
8. Solo en un entorno administrativo/dedicado, evaluar una VM temporal o mecanismo equivalente para demostrar aislamiento de red/host y cleanup sin modificar el host de trabajo.

## Phase 8 — Internet & Browser

La definición arquitectónica, el spike de providers/sandbox, los controlled tests, la ejecución externa, el egress boundary spike, el egress hardening, el decision-gate, la evidencia ejecutable, la evidencia HTTPS/DNS, la limitación de fixture TLS, el provisioning experimental del runtime browser, la evidencia DNS/socket, la evaluación HTTPS/TLS y la evidencia de aislamiento browser/host fueron revisados y mergeados a `main` mediante PR #9, PR #10, PR #11, PR #12, PR #13, PR #14, PR #15, PR #16, PR #17, PR #18, PR #19, PR #20, PR #21 y PR #22, respectivamente. El spike de capacidades de aislamiento de red/host fue revisado y mergeado mediante PR #24. La evidencia OS/network fue revisada y mergeada mediante PR #25. La evaluación de evidencia restante fue revisada y mergeada mediante PR #26. El alcance actual sigue siendo preproducción.

La evidencia Fetch/SSRF/DNS/policies es 29/29 PASS en fixtures controlados. El experimento browser local ejecutó 19 comprobaciones: 17 PASS, 1 FAIL y 1 NOT EXECUTED. El FAIL es una evidencia negativa deliberada: el redirect público → interno alcanzó el fixture interno pese al routing configurado. Por tanto, `browserContext.route()` no debe considerarse suficiente para una frontera de egress/SSRF de producción.

Search real, browser remoto, la ejecución del nuevo harness de DNS rebinding con Chromium real, HTTPS→HTTPS/HTTP, aislamiento OS-level/de red y crash cleanup seguro continúan pendientes. La evidencia host/browser mejora la caracterización local, pero no constituye aislamiento OS-level. El PR #29 añade un harness experimental para ejecutar ahora el escenario de rebinding con Chromium real y correlacionar las ventanas de `request.timing()` con DNS/egress del laboratorio. La evaluación TLS no produjo handshake ni evidencia de egress HTTPS; la limitación del fixture queda documentada. DNS/socket real solo está demostrado en el fixture local controlado; el rebinding DNS controlado real ya fue demostrado en VirtualBox y el PR #29 añade la correlación browser pendiente de ejecución; no se demuestra pinning productivo. El fixture TLS reproducible permanece bloqueado por la limitación documentada del entorno actual. Service Worker ya tiene evidencia PASS en el fixture localhost, pero debe confirmarse para el browser/provider elegido. ADR-012 mantiene la fase en `decision-gate`; no hay selección definitiva de provider, browser, sandbox o egress, y no hay implementación de producción. El nuevo spike solo registra capacidades observadas de Hyper-V/Firewall/vEthernet y WSL2; no demuestra aislamiento OS-level y no cambia el gate.

## Known Risks

- Diferencias entre formatos de audio PCM/WAV/MP3/Opus.
- Permisos y enumeración de dispositivos Windows.
- Compatibilidad de Python y dependencias de voz con el entorno real.
- Consumo de CPU/RAM y cold start de modelos locales.
- Cancelación difícil en bindings nativos.
- Fuga de datos mediante proveedores cloud.
- Licencias distintas entre software, modelos y voces.
- Calidad variable en español.
- Falsos parciales de STT.
- Backpressure entre audio y transcripción.
- Reproducción solapada.
- Recursos temporales no eliminados.
- Acoplamiento accidental entre voz y `RealtimeEngine`.
- Riesgos de egress del browser y límites de interception cuando existen Service Workers.
