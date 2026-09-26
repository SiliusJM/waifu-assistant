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
/session-search <id> <texto>
/load-session <name>
/delete-session <name>
/rename <nombre>
/session-info
```

Las sesiones se guardan por defecto en `~/.waifu-assistant/sessions.json` y
pueden redirigirse mediante `YUKI_SESSIONS_PATH`. Esta persistencia es
independiente de `PersistentMemory`, no guarda automáticamente al salir y
`/clear` solo limpia la `Session` actual; no elimina sesiones guardadas.

### Acciones pendientes

El journal local versionado se guarda en `~/.waifu-assistant/pending-actions.json`
fuera del repositorio; `YUKI_PENDING_ACTIONS_PATH` permite indicar otra ruta
absoluta externa al repositorio. En CLI, `/pending [id]` inspecciona acciones,
`/confirm-action <id>` registra confirmación sin ejecutarla,
`/defer-action <id>` la devuelve a preparada y `/discard-action <id>` descarta
una acción que todavía no comenzó. Ninguna acción se ejecuta automáticamente;
si había una ejecución en curso al reiniciar, requiere reconciliación explícita.
El journal es independiente de Session, Persistent Memory y conversaciones
guardadas: `/clear` y `/forget` no lo modifican. En esta versión no se conectan
acciones externas de Calendar o Tasks ni se añade un comando de usuario para
crear propuestas; los productores futuros podrán usar la API local allowlisted.

La conversación actual puede organizarse con `/rename Proyecto Waifu Assistant`
y consultarse con `/session-info`. `/sessions` muestra, de más reciente a más
antigua, título, cantidad de mensajes e instante de actualización, sin revelar
el contenido. Renombrar no guarda automáticamente el contenido;
`/save-session <name>` sigue siendo
explícito y conserva el título. Los títulos son metadata, no sustituyen los IDs
seguros usados por `/load-session` y `/delete-session`.

Las respuestas interactivas pueden mostrarse progresivamente mediante streaming; la respuesta completa se guarda como un único mensaje de `Session`.

### Micrófono local (STT experimental)

En Windows, prepara explícitamente el modelo local fuera del repositorio y configura `YUKI_STT_MODEL_DIR` antes de iniciar el CLI:

```text
$env:STT_MODEL_DIR = "$env:LOCALAPPDATA\WaifuAssistant\models\whisper-tiny"
npm run setup:local-stt-model -- $env:STT_MODEL_DIR
$env:YUKI_STT_MODEL_DIR = $env:STT_MODEL_DIR
node dist/main.js --interactive
```

En la conversación usa `/listen` para iniciar PTT y `/listen-stop` para finalizar manualmente. El modo duplex opt-in se activa con `/duplex`; `/duplex-stop` lo detiene. `YUKI_DUPLEX_ENABLED=true` lo inicia al arrancar el CLI interactivo, y el default es `false`. Whisper Tiny multilingüe usa autodetección local de idioma (`AUTO`). La aceptación acústica real dio español `PASS`, español con romaji `PASS`, japonés hablado `PARTIAL` y español con inglés embebido `FAIL` (el término “Spring Boot” solo se conservó parcialmente). Por tanto, el soporte funciona con limitaciones conocidas; no implica soporte multilingüe perfecto. Yuki responde normalmente en español y conserva nombres, títulos, código y citas en su idioma original. No hay traducción automática de la utterance completa, romanización automática del japonés ni conversión automática de romaji a kana/kanji. El audio STT se procesa localmente, no se envía por red ni se persiste como audio crudo. PTT permanece disponible como fallback; no se habilitan wake word ni escucha automática al iniciar, salvo opt-in duplex.

VAD Silero es opcional. Prepara explícitamente el modelo ONNX oficial de
Sherpa-ONNX fuera del repositorio (SHA-256 y tamaño fijados en el proyecto) y
configura `YUKI_VAD_MODEL_PATH`:

```powershell
$vadModelDir = "$env:LOCALAPPDATA\WaifuAssistant\models\vad"
npm run setup:local-vad-model -- $vadModelDir
$env:YUKI_VAD_MODEL_PATH = Join-Path $vadModelDir "silero_vad.onnx"
```

El setup escribe un `manifest.json` local con fuente, asset y hash. No descarga
automáticamente al iniciar Yuki ni durante tests. El modelo Silero VAD se
distribuye bajo MIT según la atribución upstream; conserva la referencia a
[Silero VAD](https://github.com/snakers4/silero-vad). `YUKI_VAD_MIN_SILENCE_MS` controla la pausa de
cierre (350–1500 ms; 650 por defecto). El modelo no se descarga automáticamente;
es obligatorio para `/duplex`. `YUKI_DUPLEX_PAUSE_GRACE_MS` (0–2000 ms; 500 por
defecto) espera una continuación tras el endpoint VAD. Duplex rota la captura
periódicamente para respetar los límites de buffers, vuelve a abrir el micrófono
entre ventanas y agrega segmentos separados por pausas dentro de un único turno.
Sin VAD, `/listen` conserva PTT y su flujo previo. El VAD procesa audio en memoria
y solo las transcripciones finales llegan a la conversación.

La cancelación de reproducción/TTS al detectar habla confirmada funciona como
barge-in básico. No hay cancelación de eco acústico: si el micrófono capta la voz
de Yuki, puede causar una interrupción falsa. El comportamiento duplex se cubre
con providers deterministas; esta versión no declara aceptación acústica real.

### TTS local y reproducción en Windows

La respuesta de `/listen` y `/duplex` se sintetiza localmente con Sherpa-ONNX
(modelo Piper VITS español) y se reproduce por el dispositivo de salida
predeterminado de Windows. El texto y el audio permanecen en memoria; no se
envían a un servicio remoto ni se guardan como archivos. No se descargan modelos
al iniciar la aplicación o al ejecutar tests.

Prepara el modelo explícitamente en una carpeta fuera del repositorio. En
PowerShell, la descarga oficial fijada se puede verificar y extraer así:

```powershell
$modelRoot = "$env:LOCALAPPDATA\WaifuAssistant\models\tts"
$archive = Join-Path $env:TEMP "vits-piper-es_AR-daniela-high-int8.tar.bz2"
Invoke-WebRequest "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-es_AR-daniela-high-int8.tar.bz2" -OutFile $archive
if ((Get-FileHash $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne "7218f0a119e4c16533ac187f71ab3019f2092f1594e43fef8392ae1f5b64abab") { throw "TTS model archive SHA-256 mismatch" }
New-Item -ItemType Directory -Force $modelRoot | Out-Null
tar -xjf $archive -C $modelRoot
$env:YUKI_TTS_MODEL_DIR = Join-Path $modelRoot "vits-piper-es_AR-daniela-high-int8"
```

El directorio debe contener `es_AR-daniela-high.onnx`, `tokens.txt` y
`espeak-ng-data`. El modelo es Daniela, español de Argentina, calidad alta,
int8; conserva la atribución y condiciones indicadas en el `MODEL_CARD` incluido
en el archivo oficial. Configura `YUKI_TTS_MODEL_DIR` antes de iniciar la app;
`YUKI_STT_MODEL_DIR` sigue siendo necesario para `/listen`.

Después de `npm run build`, se puede verificar TTS y reproducción reales sin
micrófono ni provider de IA mediante `node scripts/voice-tts-smoke.mjs`. El
smoke reproduce una frase breve por el dispositivo predeterminado y reporta
solo metadatos de resultado. Para la conversación de voz, inicia el CLI
interactivo, usa `/listen` y luego `/listen-stop` para PTT, o `/duplex` para
endpointing automático por VAD; la respuesta normal de Yuki se envía tanto al
canal de texto como a síntesis/reproducción local.

## Comandos locales

`/help` es la fuente actualizada de comandos y capacidades locales; las preguntas
naturales claras sobre cómo usarlas consultan el mismo catálogo. Las acciones
explícitas locales no requieren una llamada al LLM. La memoria explícita se guarda
localmente y puede redirigirse mediante `YUKI_MEMORY_PATH`; no se mezcla con las
sesiones guardadas. En turnos normales, Yuki solo comparte con el provider hasta
tres memorias explícitas que coincidan claramente con la consulta; no crea
memorias automáticamente y ese contexto interno no se guarda en la Session ni en
sesiones exportadas/guardadas.
Una solicitud natural explícita para corregir una memoria existente muestra la
clave y los valores actual/nuevo y requiere un “sí” claro antes de escribir;
sin confirmación, ante conflicto o para una clave nueva no modifica la memoria.
Una solicitud explícita como `Recuerda que mi ciudad es Guayaquil` puede proponer
una sola memoria nueva; Yuki muestra únicamente la clave y el valor y espera un
“sí” claro. Las frases casuales no se guardan, los datos sensibles se rechazan y
una clave existente sigue el flujo de confirmación de actualización.
Una solicitud explícita para olvidar una memoria existente muestra solo esa
entrada y requiere confirmación; si el valor cambió mientras esperabas, Yuki no
elimina el valor nuevo. Los valores sensibles se ocultan en la confirmación.

`/session-search <id> <texto>` busca texto literal, sin distinguir mayúsculas,
en los mensajes visibles de una sola conversación guardada. Muestra como máximo
cinco fragmentos breves y no carga ni modifica la sesión activa o guardada.

Los recordatorios se guardan localmente en `~/.waifu-assistant/reminders.json`
(o en la ruta indicada por `YUKI_REMINDERS_PATH`). Aceptan fecha/hora explícita
`YYYY-MM-DD HH:mm` en la zona horaria del sistema; también se admite `HH:mm` para
la siguiente ocurrencia futura. `/reminders` muestra pendientes y
`/reminders --all` incluye el historial completado. Usa
`/reminder-complete <id>` para conservar un recordatorio como completado, o
`/reminder-delete <id>` para eliminarlo. Al vencer, Yuki muestra un aviso en la
consola mientras la sesión interactiva está abierta; los vencidos al iniciar se
avisan una vez en esa ejecución y permanecen pendientes hasta completarlos o
eliminarlos. No se ejecuta un daemon ni se programan avisos cuando Yuki está
cerrada. Las notificaciones toast nativas de Windows quedan diferidas; el
fallback de consola es portable y no ejecuta contenido del recordatorio.

`/summary` resume mediante el provider configurado los mensajes visibles (`user` y
`assistant`) recientes y acotados de la conversación actual. No incluye memoria,
tools ni otras sesiones, y no guarda el prompt o el resumen en la Session.

### Notas locales

Las aclaraciones naturales seguras solicitan un solo dato faltante. Su estado es
efímero, queda asociado a la sesión interactiva y se descarta tras una respuesta
inválida, cancelación, cambio de tema, `/clear`, carga de otra sesión o salida.
No inicia una acción con datos ambiguos ni repite la pregunta.
Si corriges inmediatamente una intención local pendiente con una instrucción
inequívoca, Yuki puede redirigirla una sola vez; no deshace acciones que ya se
ejecutaron y descarta el contexto de reparación al cambiar de tema o sesión.
También puede redirigir una consulta local de solo lectura a otra consulta
compatible; conserva solo el tipo y los identificadores/texto de búsqueda mínimos,
y no guarda resultados de herramientas en la Session. Una consulta de solo lectura
puede recibir un único seguimiento breve (por ejemplo, cambiar el término buscado
en la misma conversación guardada); ese contexto mínimo se consume enseguida y se
descarta ante comandos, cambios de tema o sesión.

El estilo de respuesta puede cambiarse localmente con `/tone` o `/tone <nombre>`:
`default`, `concise`, `warm`, `technical` y `playful`. Solo se persiste el
identificador elegido en `~/.waifu-assistant/conversation-tone.json` (o en
`YUKI_TONE_PREFERENCES_PATH`). Peticiones naturales inequívocas como
`Respóndeme más breve` también pueden cambiarlo; una frase casual no lo modifica.
El estilo solo influye en la presentación enviada al provider: no reemplaza la
personalidad ni cambia seguridad, tools o memoria. La instrucción interna no se
añade a la Session.

La estructura de respuesta se configura por separado con `/format` o
`/format <nombre>`: `default`, `prose`, `bullets` y `steps`. Solo se persiste
el identificador en `~/.waifu-assistant/response-format.json` (o mediante
`YUKI_RESPONSE_FORMAT_PATH`). Frases naturales explícitas pueden seleccionar
una opción cerrada; comentarios casuales no cambian la preferencia. El formato
no altera el tono, la personalidad, las políticas ni la Session.

Las notas se guardan en `~/.waifu-assistant/notes.json` (o en la ruta configurada
con `YUKI_NOTES_PATH`) y se gestionan explícitamente con `/note-add Comprar
adaptador HDMI`, `/notes`, `/note-show n-a1b2c3d4` y `/note-delete n-a1b2c3d4`. No usan IA,
no se agregan automáticamente a Persistent Memory ni a la conversación, y no
se sincronizan con la nube.

Yuki también puede crear una nota o un recordatorio mediante una instrucción
natural explícita, por ejemplo: `Recuérdame mañana a las 7 pagar la luz` o
`Guarda una nota: comprar adaptador HDMI`. Estas acciones pasan por las herramientas
locales permitidas; requieren una fecha y hora concretas para recordatorios y
pedirán aclaración cuando falten. No sustituyen los comandos `/remind` y
`/note-add`, no ejecutan acciones de borrar/editar/listar automáticamente y no
se guardan como mensajes de la Session. Las instrucciones naturales requieren
un proveedor/modelo compatible con tool calling; los comandos explícitos siguen
siendo el fallback local cuando esa capacidad no esté disponible.

También puede consultar datos locales con lenguaje natural: `¿Qué recordatorios tengo?`,
`¿Cuál es mi próximo recordatorio?`, `¿Qué notas tengo guardadas?` o `Muéstrame la nota n-a1b2c3d4`.
Estas consultas son de solo lectura: los recordatorios devuelven únicamente metadata,
el listado de notas usa previews acotadas y `note_show` muestra solo la nota solicitada.
Pedir explícitamente todos los recordatorios permite incluir los completados; una consulta
normal muestra solo los pendientes. Las consultas no modifican stores ni contaminan la Session.

Yuki puede resumir su estado local con preguntas como `¿Qué proveedor y modelo usas?`,
`¿Tienes configurada la credencial?`, `¿Qué sesión tengo abierta?` o `Dame un resumen de tu estado local`.
El resumen incluye solo metadata segura del provider, la sesión actual, el conteo de notas y
conteos/fecha del próximo recordatorio. Nunca revela credenciales ni entrega al modelo el contenido
de notas, recordatorios o Persistent Memory. La consulta no cambia el provider ni la configuración;
`/status` sigue disponible como comando explícito.

También puede consultar metadata de conversaciones guardadas: listarlas, contarlas,
identificar la más reciente o pedir la metadata de un ID concreto. Estas consultas no muestran
mensajes ni cargan ni modifican la sesión activa; abrir, borrar o renombrar sigue requiriendo
los comandos explícitos de sesiones. El lenguaje natural requiere un provider compatible con
tool calling; los comandos slash de sesiones no cambian.

### Exportar conversaciones

En el modo interactivo, `/export` guarda la conversación actual como Markdown;
`/export charla-yuki` permite elegir un nombre de archivo. Los archivos se
guardan en `~/.waifu-assistant/exports`. La exportación es explícita, no modifica
la Session ni incluye memoria persistente, datos internos de herramientas o
metadatos del proveedor.

`/help` también resume las capacidades actuales. Preguntas claras como «¿Qué puedes hacer?»
o «¿Cómo creo un recordatorio?» se responden desde un catálogo local: explican el uso,
pero no ejecutan acciones ni consultan el contenido de notas, recordatorios, memoria o sesiones.

## MVP local con LLM real

Sin `AI_PROVIDER` ni `AI_PROVIDER_PROFILE`, el CLI usa `MockAIProvider` y no realiza llamadas externas.
Para usar el `DirectAIProvider`, configura temporalmente `AI_PROVIDER=direct`,
`AI_BASE_URL`, `AI_API_KEY` y `AI_MODEL`. La personalidad se mantiene durante
la ejecución; el historial solo se conserva entre procesos cuando el usuario
lo guarda explícitamente.

En PowerShell, el smoke test real opt-in se ejecuta así:

```powershell
$env:AI_PROVIDER="direct"; $env:AI_BASE_URL="<ENDPOINT>"; $env:AI_API_KEY="<API_KEY>"; $env:AI_MODEL="<MODEL>"; $env:AI_TIMEOUT_MS="10000"; node scripts/smoke-real-ai.mjs
```

El comando consume una llamada real, no forma parte de `npm test` ni de
`npm run check`, y nunca imprime la API key ni el header de autorización.

## Provider Profiles

`AI_PROVIDER_PROFILE` selecciona `omniroute`, `groq`, `gemini` u `openrouter`.
Por ejemplo, carga previamente `GROQ_API_KEY` desde tu secret loader y establece
`AI_PROVIDER_PROFILE=groq` y `GROQ_MODEL=<modelo-vigente>` antes de iniciar Yuki.
Cada perfil exige su propia `<PROVIDER>_MODEL` y `<PROVIDER>_API_KEY`; no hay
modelos permanentes incorporados ni mezcla con `AI_BASE_URL/AI_MODEL/AI_API_KEY`.
Un perfil desconocido o incompleto produce un error de configuración.

Los endpoints incorporados son `http://localhost:20128/v1` (OmniRoute),
`https://api.groq.com/openai/v1`, `https://generativelanguage.googleapis.com/v1beta/openai`
y `https://openrouter.ai/api/v1`. `<PROVIDER>_BASE_URL` permite reemplazarlos;
solo se aceptan URLs HTTP(S) sin credenciales, query ni fragmento.
`AI_TIMEOUT_MS` y los controles de retry existentes siguen siendo globales.
El modelo puede cambiar por environment sin cambiar código. No hay discovery
al iniciar ni fallback entre proveedores. `/status` muestra perfil, modelo,
host y presencia de credencial; nunca la clave.

Sin selector (o vacío), la configuración legacy `AI_PROVIDER=direct` más
`AI_BASE_URL/AI_API_KEY/AI_MODEL` sigue disponible, al igual que mock.
El smoke opt-in existente conserva su contrato legacy.

V1 utiliza `CredentialResolver` respaldado por el environment del proceso,
incluidas configuraciones inyectadas al bootstrap. Puedes seguir cargando tus
credenciales protegidas desde PowerShell antes de lanzar VS Code/Yuki; para un
perfil OmniRoute el loader debe definir `OMNIROUTE_API_KEY` (legacy usa `AI_API_KEY`).
Yuki no lee los XML de credenciales, no lanza PowerShell y no persiste claves.
Los objetos resueltos ocultan la clave de JSON, enumeración e inspección estándar;
`toSafeProviderConfig` proporciona una representación explícita para diagnóstico.
Esto no convierte el environment en un almacén permanente seguro: integración
OS Secret Store / first-run credential bootstrap queda diferida para V2.
Nunca incluyas claves en Git ni archivos de configuración de texto plano.

### Windows credential setup

En Windows, configura una credencial por perfil una sola vez:

```powershell
.\scripts\setup-provider-credentials.ps1 -Profile groq
.\scripts\start-yuki.ps1 -Profile groq
```

Usa `omniroute`, `groq`, `gemini` u `openrouter` como perfil. En el diálogo
seguro, pega la API key en el campo Password; el nombre de usuario es solo una
etiqueta. Las credenciales quedan fuera del repositorio en
`%APPDATA%\WaifuAssistant` mediante `Export-Clixml`, protegido para el usuario
de Windows que las creó; no se debe asumir que otro usuario o equipo pueda
descifrarlas. Un archivo existente se conserva; `-Force` reemplaza únicamente
el perfil seleccionado. El launcher importa solo ese perfil y entrega su clave
al proceso de Yuki mediante environment temporal, nunca como argumento CLI.
El `<PROFILE>_MODEL` sigue siendo configuración pública independiente y debe
estar configurado antes de iniciar. El flujo manual por environment sigue
siendo compatible. La integración nativa con Windows Credential Manager,
macOS Keychain o Linux Secret Service queda para una versión futura.

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
Interactive responses are streamed progressively. While a response is active, a new normal input replaces it; `/cancel` stops the active response and `/exit` closes the session cleanly.

El benchmark real de OmniRoute es opt-in: `node scripts/benchmark-ai.mjs --model <route> --prompt latency --json` permite medir una ruta aislada, y la matriz continúa aunque una ruta falle. Los resultados solo muestran metadatos seguros; no imprimen credenciales, prompts completos ni respuestas.
