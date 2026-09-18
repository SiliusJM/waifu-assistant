# Project Status

## Current Phase

Phase 8 — Internet & Browser (definición, spikes y controlled/external tests aprobados y mergeados; implementación de producción no iniciada).

## Status

Phase 6 fue revisada técnicamente, corregida y mergeada en `main` mediante PR #6. El merge quedó registrado en `532c956e2a407b9e9e540584947a24739490bb03`. La definición de Phase 7 fue revisada, corregida y mergeada mediante PR #7; el merge quedó registrado en `c30ccd3bff298c37cc1dd12a01ec775074b83b02`. La implementación de Phase 7 fue revisada, corregida y mergeada mediante PR #8; el merge quedó registrado en `417a30deca884f55057164475b08b2521d47347d`. La definición de Phase 8 fue revisada y mergeada mediante PR #9; el merge quedó registrado en `ef17ff897b2d25d1c402d271d4a3631b26b3fa5b`. El spike de providers y sandbox fue revisado y mergeado mediante PR #10; el merge quedó registrado en `bb29fb303c83eeed2c73b7d4944479756c2362ea`. Los controlled tests fueron revisados y mergeados mediante PR #11; el merge quedó registrado en `35045dcf9bcd9ff6b31c9bb7908af7872daae5a3`. La ejecución externa fue revisada y mergeada mediante PR #12; el merge quedó registrado en `4be0966603feeb97ad04cb86ea1f1c95f08d1d82`. El egress boundary spike fue revisado y mergeado mediante PR #13; el merge quedó registrado en `cd22a2fd8f8b979c5ef32ecdb63f66ff50a94079`. El egress hardening fue revisado y mergeado mediante PR #14; el merge quedó registrado en `9dab02d72e710e691121da27489474d1ed4c f3b`. El architecture decision gate fue revisado y mergeado mediante PR #15; el merge quedó registrado en `8709da3cf3957f1f16163a9baecdff7ecb1c7cbd`.

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
- DNS rebinding sigue siendo una simulación controlada, no pinning real.
- Egress hardening por canal: 14 PASS, 0 FAIL, 6 NOT EXECUTED y 1 SIMULATED; `internalHits=[]`.
- No se seleccionó todavía proxy productivo, aislamiento de red, browser remoto ni combinación definitiva.

## In Progress

Ninguno. La evidencia de egress fue ampliada y mergeada; la implementación productiva de Phase 8 todavía no ha comenzado.

## Blocked

- Las métricas de hardware siguen pendientes por el bloqueo de WMI.
- La selección final de proveedores de STT/TTS requiere pruebas locales comparables de compatibilidad, latencia, calidad, consumo, cancelación y licencias.
- Search requiere credenciales temporales para ejecutar el benchmark real.
- Browser remoto y DNS rebinding real requieren entornos aislados apropiados.
- El redirect público → interno demuestra que `browserContext.route()` no debe tratarse como frontera completa de egress/SSRF.
- El egress boundary proxy fixture bloqueó el mismo caso con `internalHits=0`, pero esto no demuestra todavía aislamiento de red del host ni pinning real de sockets.
- Service Worker mantiene una frontera especial de interception; el fixture egress no pudo ejecutarlo y la arquitectura definitiva debe probar ese camino en un entorno apropiado.

## Next

Sin introducir código de producción todavía:
1. Probar el boundary inferior en un entorno con Service Worker realmente ejecutable y registrar si `internalHits` permanece en cero por canal.
2. Ejecutar una prueba controlada de HTTPS→HTTP y revisar el comportamiento de WebSocket/CONNECT con TLS donde corresponda.
3. Probar el mecanismo con resolución efectiva y DNS rebinding real en un entorno aislado; mantener la simulación separada.
4. Repetir Search con credenciales temporales para Brave, Tavily y Exa y medir las 20 consultas.
5. Evaluar browser remoto y crash cleanup seguro.
6. Convertir toda la evidencia en una decisión arquitectónica documentada antes de implementar `WebSearchProvider`, `WebFetchProvider` o `BrowserProvider`.

## Phase 8 — Internet & Browser

La definición arquitectónica, el spike de providers/sandbox, los controlled tests, la ejecución externa, el egress boundary spike y el egress hardening fueron revisados y mergeados a `main` mediante PR #9, PR #10, PR #11, PR #12, PR #13 y PR #14, respectivamente. El alcance actual sigue siendo preproducción.

La evidencia Fetch/SSRF/DNS/policies es 29/29 PASS en fixtures controlados. El experimento browser local ejecutó 19 comprobaciones: 17 PASS, 1 FAIL y 1 NOT EXECUTED. El FAIL es una evidencia negativa deliberada: el redirect público → interno alcanzó el fixture interno pese al routing configurado. Por tanto, `browserContext.route()` no debe considerarse suficiente para una frontera de egress/SSRF de producción.

Search real, browser remoto, Service Worker en el egress fixture, DNS rebinding real, HTTPS→HTTP y crash cleanup seguro continúan pendientes. No hay selección definitiva de provider, browser, sandbox o egress, y no hay implementación de producción.

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
