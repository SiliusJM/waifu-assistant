# Waifu Assistant

Asistente personal de escritorio desarrollado de forma incremental y segura.

## Estado

La unidad offline de contratos/base de Phase 8 comienza sin habilitar providers reales ni navegación. ADR-012 permanece provisional y la ejecución de laboratorio sigue separada.

Phase 8 — Internet & Browser está definida y aprobada a nivel arquitectónico y sus spikes de providers/sandbox, controlled tests, external tests y egress boundary ya fueron revisados y mergeados. La definición fue revisada y mergeada a `main` mediante PR #9 (`ef17ff897b2d25d1c402d271d4a3631b26b3fa5b`), el spike mediante PR #10 (`bb29fb303c83eeed2c73b7d4944479756c2362ea`), los controlled tests mediante PR #11 (`35045dcf9bcd9ff6b31c9bb7908af7872daae5a3`), la ejecución externa mediante PR #12 (`4be0966603feeb97ad04cb86ea1f1c95f08d1d82`) y el egress boundary mediante PR #13 (`cd22a2fd8f8b979c5ef32ecdb63f66ff50a94079`) y el egress hardening mediante PR #14 (`9dab02d72e710e691121da27489474d1ed4ccf3b`) y el decision-gate de arquitectura mediante PR #15 (`8709da3cf3957f1f16163a9baecdff7ecb1c7cbd`) y la evidencia ejecutable del gate mediante PR #16 (`068bef145b2a0092f806c98e0dfd623b54bb33c9`) y la evidencia HTTPS/DNS mediante PR #17 (`0183ab6c76379ccda90e9602df3ce13aab0c0225`) y la limitación de fixture TLS mediante PR #18 (`25985396222c8dc51db9f71b55606cf85aab2254`) y el provisioning experimental del runtime browser mediante PR #19 (`4e442e1669f2d199228e0ad7829f585f67b18c58`) y la evidencia DNS/socket mediante PR #20 (`88c49433ccf4922612c9eeafd7df32d947f35c18`) y la evaluación de evidencia HTTPS/TLS mediante PR #21 (`0288137f8b0eb5601d4a84060cd1091ad9aaef18`) y la evidencia de aislamiento browser/host mediante PR #22 (`3f736d864a94c3139eff70acdc9a5e18417623ae`). La revisión consolidada de ADR-012 fue revisada y mergeada mediante PR #23 (`c0ecf47a342f21cddddfb7a2c75905ae9b144698`). La evaluación de capacidades de aislamiento de red/host fue revisada y mergeada mediante PR #24 (`4ab2bf774fd2d276a824415117a8303eadbab8f8`); conserva las señales del entorno como evidencia limitada, deja la identificación exacta del sistema operativo como `LIMITATION` y no demuestra aislamiento OS-level ni habilita componentes del host. La etapa de evidencia OS/network fue revisada y mergeada mediante PR #25 (`d8d07c2a0eac845d593302e5ed19d19c71a12b3a`); no produjo nueva evidencia OS-level y mantiene el experimento como `NOT EXECUTED`/`LIMITATION`. La evaluación de evidencia restante fue revisada y mergeada mediante PR #26 (`197cd1c24b6b9499f9a96861c7b5902b2d0d8104`); confirma que no existe una prueba nueva segura y útil ejecutable en el entorno actual y mantiene el decision-gate abierto. La preparación del entorno experimental fue revisada y mergeada mediante PR #27 (`cdb70f5b6b61464e70492131e63818eacf827328`); deja definido el checklist operativo y los requisitos de entrada para ejecutar las pruebas pendientes sin modificar el host de trabajo. La evidencia real de DNS rebinding controlado fue revisada y mergeada mediante PR #28 (`e0dfefe36844f9c212828a4aeb78751cb42098a0`); demuestra el cambio reproducible de `rebind.test` entre `1.1.1.1` y `10.20.0.1` y el bloqueo del destino privado en el boundary inferior, pero no demuestra pinning productivo. La evidencia del harness experimental de navegador para DNS rebinding fue revisada y mergeada mediante PR #29 (`30646455dd2b5ab2285cb931a9fa3e32dd88c323`); correlaciona dos intentos Chromium con las ventanas `request.timing()`, una referencia de reloj cross-VM, deltas diferenciales de `nftables` y `internalHits=0`. El harness sigue siendo experimental y no implementa `BrowserProvider` ni cierra ADR-012. La evidencia actual incluye 29/29 comprobaciones controladas de Fetch/SSRF/DNS/policies, 19 PASS, 0 FAIL y 2 NOT EXECUTED en el proxy/egress fixture, y 14 PASS, 0 FAIL, 6 NOT EXECUTED y 1 SIMULATED en el hardening por canal, con `internalHits=[]` y evidencia individual para los canales ejecutados. El browser baseline continúa con 17 PASS, 1 FAIL y 1 NOT EXECUTED; el FAIL conocido se conserva porque demuestra la limitación de `browserContext.route()`. Search real y Browser remoto continúan sin ejecutarse; DNS/socket real sigue demostrado en el fixture local controlado y DNS rebinding controlado real ya tiene evidencia `PASS` dentro del laboratorio VirtualBox. DNS rebinding público, pinning productivo y validación de IP efectiva justo antes del socket dentro de BrowserProvider siguen pendientes. HTTPS, HTTPS→HTTP, HTTPS→interno y CONNECT/WebSocket sobre TLS permanecen NOT EXECUTED/LIMITATION porque el entorno no dispone de un mecanismo seguro y reproducible de certificado X.509 efímero confiable para Chromium. El Service Worker tiene un fixture localhost real con observación y bloqueo por el boundary e `internalHits=0`. No se han añadido providers de producción, BrowserProvider, egress proxy productivo ni código de producción.

Documentacion de Phase 8:

- `docs/phases/phase-08-internet-and-browser.md`: definicion, seguridad, lifecycle, criterios y límites de la unidad offline.
- `docs/adr/ADR-011-internet-and-browser-definition.md`: decision arquitectonica de Internet & Browser.
- `docs/phase-08-provider-and-sandbox-spike.md`: spike documental de providers, transporte, browser y sandbox.
- `docs/phase-08-controlled-test-results.md`: resultados del harness controlado y límites de la evidencia.
- `docs/phase-08-external-test-results.md`: ejecución externa de Search/Browser y limitaciones observadas.
- `docs/phase-08-egress-boundary-spike.md`: evidencia experimental del boundary de egress inferior al browser.
- `docs/phase-08-egress-hardening-results.md`: hardening por canal y límites pendientes.
- `docs/phase-08-remaining-evidence-results.md`: matriz de evidencia restante.
- `docs/phase-08-architecture-decision-draft.md`: borrador de decision-gate arquitectónico.
- `docs/adr/ADR-012-internet-and-browser-egress-architecture.md`: gate de arquitectura de egress.
- `docs/phase-08-gate-evidence-results.md`: evidencia ejecutable del gate, incluyendo Service Worker real en localhost.
- `docs/phase-08-runtime-provisioning-results.md`: provisioning experimental de Chrome Headless Shell y repetición de harnesses sin cambios de producción.
- `docs/phase-08-dns-socket-evidence-results.md`: evidencia controlada de DNS, IP efectiva, socket y bloqueo previo a conexión.
- `docs/phase-08-https-tls-evidence-results.md`: evaluación de viabilidad TLS y limitación reproducible del fixture HTTPS.
- `docs/phase-08-host-isolation-evidence-results.md`: evidencia experimental de almacenamiento, filesystem browser-level y cleanup.
- `docs/phase-08-decision-gate-review.md`: revisión consolidada de la matriz y criterios de cierre de ADR-012.
- `docs/phase-08-network-host-isolation-capability-spike.md`: capacidades observadas de aislamiento de red/host y límites del entorno.
- `docs/phase-08-network-host-isolation-evidence-results.md`: evidencia de la etapa OS/network, protocolo futuro y límites de ejecución.
- `docs/phase-08-remaining-evidence-assessment.md`: auditoría consolidada de criterios pendientes y requisitos para el siguiente entorno experimental.
- `docs/phase-08-experimental-environment-readiness.md`: checklist operativo del entorno dedicado, rollback y evidencia requerida.
- `docs/phase-08-dns-rebinding-real-evidence.md`: evidencia real de DNS rebinding controlado, bloqueo de destino privado y límites frente a pinning productivo.
- `docs/phase-08-browser-dns-rebinding-evidence.md`: harness experimental de Chromium para correlacionar DNS rebinding real, `request.timing()`, referencia de reloj y bloqueo diferencial de egress.
Phase 3 — Realtime Engine está COMPLETA y mergeada en `main`. La base incluye conversación de texto, tools seguras y un runtime interno de eventos, streaming abstracto, cancelación y concurrencia.

Phase 4 — Voice Service está COMPLETA y mergeada en `main` mediante PR #4, con merge commit `1ec4384dc529ed303e85413e7969a3896c741a69`. Incluye contratos desacoplados de audio, STT, TTS y reproducción, `VoiceService`, `VoiceSession`, `VoiceError`, lifecycle, cancelación, timeout por etapa, cleanup, logging seguro, eventos correlacionados y mocks deterministas. Los proveedores reales de voz no fueron seleccionados ni integrados.

Phase 5 — Streaming Voice & Interruptions está COMPLETA y mergeada en `main` mediante PR #5, con merge commit `1f076df8e880c273abe261142aab9757c541d73e`. Añade streaming de audio/STT/TTS, playback incremental, backpressure, interruption/supersede, coordinación por sesión/dispositivo, cancelación jerárquica, métricas y mocks deterministas. Los proveedores reales de voz y el LLM real siguen fuera de alcance.

Phase 6 — Personality System está COMPLETA y mergeada en `main` mediante PR #6, con merge commit `532c956e2a407b9e9e540584947a24739490bb03`. Añade personalidad declarativa, catálogos controlados, validación estricta, snapshots por interacción, registry multi-perfil, JSON canónico e integración opcional con `AssistantCore`. No añade memoria persistente, emoción, voz real ni UI multi-personaje.

Phase 7 — Avatar System está COMPLETA y mergeada en `main` mediante PR #8, con merge commit `417a30deca884f55057164475b08b2521d47347d`. Incluye contratos, lifecycle, máquina visual, concurrencia bounded, capabilities, eventos, policy cerrada, provider mock, validación runtime y tests; no incluye renderer ni UI.

## Principios

Seguridad, integridad del proyecto, correctitud, estabilidad, baja latencia, mantenibilidad, experiencia de usuario, coste y nuevas capacidades, en ese orden.

La arquitectura mantendrá el núcleo separado de proveedores de IA, voz, memoria, avatar y herramientas. Electron, Vue, TypeScript, Python, faster-whisper, Edge-TTS, RVC, SQLite, Three.js, Live2D/VTube Studio, RAG y OmniRoute permanecen como candidatos sujetos a evaluación por fase.

## Requisitos locales detectados

- Windows
- Node.js 22 o posterior
- npm o pnpm
- Git

Python está disponible para la evaluación posterior de proveedores especializados de voz.

## Verificación

Instalar las dependencias y ejecutar:

    npm install
    npm run build
    npm run lint
    npm run typecheck
    npm test

`dist` y `dist-tests` son artefactos generados y no se versionan.

## Conversación efímera multi-turno

El modo CLI existente acepta una entrada única. Para mantener una conversación
de varios turnos durante una ejecución, usa `node dist/main.js --interactive`.
Cada línea es un turno; `/exit` termina explícitamente y EOF también finaliza.
El historial vive en la `Session` durante la ejecución; solo se persiste cuando
el usuario lo solicita explícitamente con los comandos de sesiones guardadas.

## Persistencia explícita de conversaciones

Yuki permite guardar y recuperar conversaciones de forma explícita con:

```text
/save-session <name>
/sessions
/load-session <name>
/delete-session <name>
```

Las sesiones se guardan por defecto en `~/.waifu-assistant/sessions.json` y
pueden redirigirse mediante `YUKI_SESSIONS_PATH`. Esta persistencia es
independiente de `PersistentMemory`, no guarda automáticamente al salir y
`/clear` solo limpia la `Session` actual; no elimina sesiones guardadas.

## MVP local con LLM real

Sin `AI_PROVIDER`, el CLI usa `MockAIProvider` y no realiza llamadas externas.
Para usar el `DirectAIProvider`, configura temporalmente `AI_PROVIDER=direct`,
`AI_BASE_URL`, `AI_API_KEY` y `AI_MODEL`. El historial y la personalidad de Yuki
siguen siendo efímeros durante la ejecución.

En PowerShell, el smoke test real opt-in se ejecuta así:

```powershell
$env:AI_PROVIDER="direct"; $env:AI_BASE_URL="<ENDPOINT>"; $env:AI_API_KEY="<API_KEY>"; $env:AI_MODEL="<MODEL>"; $env:AI_TIMEOUT_MS="10000"; node scripts/smoke-real-ai.mjs
```

El comando consume una llamada real, no forma parte de `npm test` ni de
`npm run check`, y nunca imprime la API key ni el header de autorización.

## Próximo paso

Cerrar y revisar la unidad offline de contratos/base: datos web no confiables, policy URL pura, lifecycle, cancelación, mocks y adapters de `ToolManager`. La red, los providers reales, el browser, el egress y la ejecución del laboratorio siguen fuera de esta unidad; ADR-012 permanece provisional y el resultado debe conservar `PASS`, `FAIL`, `LIMITATION` o `NOT EXECUTED` sin convertir mocks en evidencia real.

Los proveedores reales de STT/TTS se evaluarán mediante un spike comparativo independiente y ADR-007; no forman parte del cierre de Phase 4.

## Documentación

- `docs/PROJECT_DISCOVERY.md`: diagnóstico del entorno y del repositorio.
- `docs/PROJECT_STATUS.md`: estado y riesgos.
- `docs/architecture/overview.md`: arquitectura y límites.
- `docs/adr/ADR-001-provider-abstraction-and-optional-omniroute.md`: evaluación inicial del gateway.
- `docs/adr/ADR-002-typescript-strict-toolchain.md`: decisión de toolchain.
- `docs/adr/ADR-003-phase-1-core-contracts.md`: contratos del core.
- `docs/phases/phase-00-foundation.md`: alcance y criterios de aceptación de Phase 0.
- `docs/phases/phase-01-assistant-core.md`: alcance y criterios de aceptación de Phase 1.
- `docs/phases/phase-02-tool-system.md`: alcance y criterios de aceptación de Phase 2.
- `docs/phases/phase-03-realtime-engine.md`: alcance, criterios y cierre de Phase 3.
- `docs/phases/phase-04-voice-service.md`: alcance, contratos, seguridad y criterios de Phase 4.
- `docs/phases/phase-05-streaming-voice-and-interruptions.md`: alcance, contratos, seguridad y verificación de Phase 5.
- `docs/phases/phase-06-personality-system.md`: alcance, contratos, seguridad y verificación de Phase 6.
- `docs/phases/phase-07-avatar-system.md`: definición, implementación acotada y criterios de Phase 7.
- `docs/adr/ADR-010-avatar-system-definition.md`: decisión arquitectónica de Avatar System y límites de implementación.
