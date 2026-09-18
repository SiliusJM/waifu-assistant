# AGENTS.md — Waifu Assistant

## Propósito

Waifu Assistant es un proyecto incremental y seguro de asistente personal de escritorio. El repositorio se desarrolla por fases y la fase activa es la única que puede implementarse.

## Reglas de trabajo

- Leer este archivo, `docs/PROJECT_STATUS.md`, la documentación de la fase activa y el estado de Git antes de modificar el proyecto.
- Preservar el trabajo existente. No borrar, resetear, sobrescribir ni reescribir componentes sin una razón técnica documentada.
- No inventar APIs, credenciales, endpoints, versiones, resultados de pruebas ni integraciones.
- Mantener cambios pequeños, reversibles, medibles, documentados y versionados.
- No avanzar a otra fase hasta que la fase activa cumpla todos sus criterios de aceptación.
- Las tecnologías listadas como candidatas deben evaluarse antes de convertirse en decisiones.

## Alcance actual: Phase 8 - Internet & Browser

La definición arquitectónica de Phase 8 fue revisada y aprobada mediante PR #9 y mergeada a `main` en `ef17ff897b2d25d1c402d271d4a3631b26b3fa5b`. El spike de providers y sandbox fue revisado y mergeado mediante PR #10 en `bb29fb303c83eeed2c73b7d4944479756c2362ea`. Los controlled tests del spike fueron revisados y mergeados mediante PR #11 en `35045dcf9bcd9ff6b31c9bb7908af7872daae5a3`. La ejecución externa fue revisada y mergeada mediante PR #12 en `4be0966603feeb97ad04cb86ea1f1c95f08d1d82`. El egress boundary spike fue revisado y mergeado mediante PR #13 en `cd22a2fd8f8b979c5ef32ecdb63f66ff50a94079`. El egress hardening fue revisado y mergeado mediante PR #14 en `9dab02d72e710e691121da27489474d1ed4ccf3b`. El architecture decision gate fue revisado y mergeado mediante PR #15 en `8709da3cf3957f1f16163a9baecdff7ecb1c7cbd`. La evidencia ejecutable del gate fue revisada y mergeada mediante PR #16 en `068bef145b2a0092f806c98e0dfd623b54bb33c9`. La evidencia HTTPS/DNS fue revisada y mergeada mediante PR #17 en `0183ab6c76379ccda90e9602df3ce13aab0c0225`. La limitación del fixture TLS fue revisada y mergeada mediante PR #18 en `25985396222c8dc51db9f71b55606cf85aab2254`. El provisioning experimental del runtime browser fue revisado y mergeado mediante PR #19 en `4e442e1669f2d199228e0ad7829f585f67b18c58`. La evidencia DNS/socket fue revisada y mergeada mediante PR #20 en `88c49433ccf4922612c9eeafd7df32d947f35c18`. La evaluación HTTPS/TLS fue revisada y mergeada mediante PR #21 en `0288137f8b0eb5601d4a84060cd1091ad9aaef18`. La evidencia de aislamiento browser/host fue revisada y mergeada mediante PR #22 en `3f736d864a94c3139eff70acdc9a5e18417623ae`. La revisión consolidada de ADR-012 fue revisada y mergeada mediante PR #23 en `c0ecf47a342f21cddddfb7a2c75905ae9b144698`.

La fase continúa sin implementación productiva. Los tests externos muestran que `browserContext.route()` no constituye por sí solo una frontera completa de egress/SSRF: un redirect público → interno alcanzó el fixture interno. El egress boundary proxy fixture bloqueó ese caso con `internalHits=0`, pero sigue siendo evidencia de fixture local y no aislamiento del host. El hardening añade evidencia individual por canal. La nueva evidencia del gate ejecutó un Service Worker real en localhost y demostró observación/bloqueo con `internalHits=0`; HTTPS, HTTPS→HTTP, HTTPS→interno y CONNECT/WebSocket sobre TLS siguen `NOT EXECUTED`/`LIMITATION`; el fixture TLS queda documentado como una limitación de emisión/confianza X.509; DNS/socket pinning sigue `SIMULATED`/`NOT EXECUTED`; browser remoto y crash cleanup siguen `NOT EXECUTED` cuando el entorno no permite ejecutarlos. El ADR-012 deja Phase 8 en `decision-gate`: el criterio Service Worker ya tiene evidencia PASS en un fixture localhost, pero debe confirmarse para el browser/provider elegido; ningún provider productivo puede implementarse hasta cerrar HTTPS, DNS rebinding real, aislamiento de red/host, crash cleanup y las demás condiciones de aceptación. Search real continúa pendiente; no se interpreta la simulación de DNS rebinding como prueba real. La evidencia DNS/socket local demuestra resolución → IP efectiva → socket y bloqueo previo a conexión dentro del fixture, pero no demuestra DNS rebinding público ni pinning productivo. La evidencia host/browser demuestra aislamiento de storage entre contextos, cleanup normal/timeout/shutdown y una restricción browser-level de `file://`; no demuestra aislamiento OS-level ni crash cleanup. El runtime browser experimental ya está provisionado fuera del repositorio y se puede reutilizar para nuevas pruebas sin tratarlo como selección productiva.

La revisión consolidada de ADR-012 queda documentada en `docs/phase-08-decision-gate-review.md`: mantiene el gate provisional, conserva el `FAIL` del redirect bajo `browserContext.route()` y separa evidencia controlada, simulada, limitada y pendiente. No selecciona arquitectura ni autoriza providers productivos.

La definición separa `WebSearchProvider`, `WebFetchProvider` y `BrowserProvider`. Todo acceso futuro deberá pasar por `ToolManager`, tratar el contenido web como dato no confiable, usar permisos `auto`/`confirm`/`block`, aplicar `AbortSignal` y mantener concurrencia acotada. La evidencia externa no constituye implementación ni selección definitiva de browser o egress.

## Historial de Phase 7 — Avatar System

Phase 6 — Personality System está cerrada y mergeada en `main` mediante PR #6, con merge commit `532c956e2a407b9e9e540584947a24739490bb03`. La definición de Phase 7 fue revisada, corregida y mergeada mediante PR #7, con merge commit `c30ccd3bff298c37cc1dd12a01ec775074b83b02`.

La rama `phase/07-avatar-system` contiene la definición histórica de la fase y ya fue mergeada. La implementación de Phase 7 debe comenzar en una rama de implementación separada y seguir exactamente la definición aprobada. No elegir ni añadir renderer concreto, UI, assets, persistencia o capacidades fuera de alcance sin una decisión de fase correspondiente.

La implementación de Phase 7 se desarrolló en `phase/07-avatar-system-implementation` y fue revisada y mergeada a `main` mediante PR #8, con merge commit `417a30deca884f55057164475b08b2521d47347d`. La rama queda como histórico de implementación.

Phase 6 implementó únicamente personalidad declarativa: perfiles, validación estricta, política, compilación determinista, snapshots por interacción, registro multi-perfil en memoria, JSON canónico, hints de voz abstractos, logging seguro y tests. No implementó agente, tools nuevas, permisos, seguridad, memoria persistente, emoción, voz real, LLM real, UI, hot reload ni APIs de procesos.

Phase 5 — Streaming Voice & Interruptions está cerrada y mergeada en `main` mediante PR #5, con merge commit `1f076df8e880c273abe261142aab9757c541d73e`. La rama de fase queda como histórico de implementación.

Phase 5 agregó streaming de captura/STT/TTS, playback incremental, backpressure, interrupciones, supersede, coordinación específica de voz, cancelación jerárquica, métricas y mocks deterministas. Los providers reales, el LLM real y cualquier API de procesos o shell permanecen fuera de alcance.

Phase 3 — Realtime Engine está cerrada y mergeada en `main`.

Phase 4 — Voice Service está cerrada y mergeada en `main` mediante PR #4. La fase implementa infraestructura de voz desacoplada: contratos de entrada/salida de audio, `STTProvider`, `TTSProvider`, `VoiceService`, `VoiceSession`, `VoiceError`, providers mock, cancelación, timeout, cleanup, logging seguro y tests deterministas sin hardware ni red.

Los proveedores reales de STT/TTS no fueron seleccionados ni integrados. ADR-007 queda abierto para el spike comparativo posterior.

La definición, alcance, contratos, criterios de aceptación y riesgos de Phase 5 ya fueron revisados y aprobados para esta implementación.

La definición, alcance, contratos, criterios de aceptación y riesgos de Phase 6 fueron revisados y aprobados antes de su implementación.

La definición, alcance, contratos, criterios de aceptación y riesgos de Phase 7 fueron revisados, corregidos y aprobados mediante PR #7 antes de iniciar su implementación. La implementación fue revisada, corregida, verificada y mergeada mediante PR #8.

## Arquitectura y seguridad

- Mantener el núcleo desacoplado de proveedores externos mediante interfaces.
- Las órdenes deterministas deberán seguir una ruta local y explícita; un gateway LLM nunca es necesario para un fast path.
- Ningún modelo podrá ejecutar shell arbitrario ni controlar el equipo sin validación, allowlist, permisos, confirmación cuando corresponda y validación del resultado.
- No guardar secretos en Git, código, documentación ni logs. Usar variables de entorno locales y mantener solo ejemplos sin valores reales.
- No registrar audio ni transcripciones completas por defecto.
- Los errores técnicos deben registrarse con información segura y reservar las respuestas naturales para capas superiores.
- La cancelación debe propagarse cooperativamente mediante `AbortSignal` y todos los recursos temporales deben limpiarse en `finally`.
- Ningún provider de voz puede acceder por sí mismo a `Session`, `RealtimeEngine` ni herramientas.

## Comandos de verificación

Desde la raíz del repositorio:

- `npm run build`
- `npm run lint`
- `npm run typecheck`
- `npm test`
- `npm run check`

Las fases de voz mantienen TypeScript estricto y no deben introducir ejecución de procesos ni shell. Ningún código de voz puede importar `node:child_process` ni ejecutar comandos, scripts o código generado.

## Cierre de una fase

Antes de marcar una fase como completada: ejecutar las verificaciones disponibles, revisar `git diff` y `git status`, actualizar la documentación y el changelog, crear un commit reproducible y anotar riesgos pendientes. Publicar la rama de la fase y completar la revisión antes del merge. No iniciar la fase siguiente automáticamente.
