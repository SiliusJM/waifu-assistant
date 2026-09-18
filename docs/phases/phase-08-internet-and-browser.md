# Phase 8 — Internet & Browser

## Estado

Definición arquitectónica preparada en la rama `phase/08-internet-browser`. Esta rama no implementa Phase 8, no añade dependencias, no cambia `main` y no abre un PR. La implementación solo podrá comenzar después de revisar y aprobar esta definición y de conservar el cierre de Phase 7 como base.

## 1. Objetivo

Definir un perímetro seguro para capacidades futuras de internet, búsqueda, lectura de páginas y navegación controlada. La fase separa claramente datos web no confiables, autorización de herramientas, providers externos y estado de una sesión de navegador.

La definición prioriza seguridad, estabilidad, correctitud, latencia, mantenibilidad, experiencia de usuario, coste y nuevas funciones, en ese orden.

## 2. Alcance de la definición

Esta fase define únicamente:

- límites entre búsqueda, fetch de contenido y browser interactivo;
- contratos conceptuales para providers reemplazables;
- lifecycle, timeout, cancelación y cleanup;
- permisos para acciones de lectura y acciones con efectos externos;
- tratamiento de redirects, cookies, credenciales, uploads y downloads;
- defensa contra prompt injection proveniente de páginas web;
- representación controlada de contenido extraído;
- límites de concurrencia y política latest-wins/cola acotada;
- integración futura con `ToolManager`, `AssistantCore`, `RealtimeEngine` y `VoiceService`;
- observabilidad segura, fallos offline y decisiones pendientes.

No se implementa ningún provider, navegador, renderer, UI, integración externa ni flujo autónomo.

## 3. Fuera de alcance y perímetro prohibido

No se introduce en Phase 8:

- Playwright, Puppeteer, Selenium, WebView, Electron, Vue, Chromium embebido ni browser automation;
- scraping, crawling o ejecución de JavaScript de páginas;
- providers reales de búsqueda, fetch o navegador;
- login automático, gestión de contraseñas, extracción de cookies o tokens;
- publicación, compra, envío de formularios o acciones irreversibles;
- persistencia de cookies, credenciales, historial, páginas o descargas;
- shell, `child_process`, `exec`, `spawn`, PowerShell, CMD o ejecución de procesos;
- filesystem arbitrario, código generado, `eval` o fallback local inseguro;
- bypass de autenticación, CAPTCHA, políticas de origen o permisos del host;
- memoria persistente, RAG, agente autónomo o UI.

La disponibilidad de una capacidad futura de internet nunca concede autoridad para actuar sobre el sistema local.

## 4. Arquitectura y separación de responsabilidades

El boundary futuro será:

```text
AssistantCore
    -> Browser/Internet capability
    -> ToolManager: schema, disponibilidad, permiso y confirmación
    -> provider adapter
    -> WebSearchProvider / WebFetchProvider / BrowserProvider
```

El modelo puede proponer una llamada estructurada, pero no obtiene un objeto provider ni puede convertir texto web en una instrucción del sistema. `ToolManager` sigue siendo el perímetro de autorización; ningún provider puede saltárselo.

### 4.1 Búsqueda

`WebSearchProvider` responde consultas de búsqueda y devuelve referencias normalizadas: título, URL, snippet limitado, fuente, fecha disponible y señales de truncamiento. No abre una sesión de navegador ni ejecuta acciones de página. Los snippets son datos no confiables.

### 4.2 Fetch

`WebFetchProvider` obtiene contenido de una URL autorizada en modo lectura. Normaliza metadata y contenido extraído sin exponer HTML crudo como instrucciones. No mantiene una sesión interactiva, no envía formularios y no ejecuta acciones de página.

### 4.3 Browser

`BrowserProvider` representa una capacidad interactiva futura: sesión, páginas, navegación y acciones acotadas. No es un sinónimo de fetch. Puede requerir un host, un perfil efímero y un sandbox del provider, pero esa tecnología queda pendiente.

Una solicitud se clasifica antes de elegir provider. Búsqueda, lectura y acción interactiva tienen permisos, timeouts, resultados y riesgos distintos.

## 5. Contratos conceptuales

Los siguientes nombres son contratos de diseño, no archivos ni código de producción de esta fase.

### WebSearchProvider

- `search(query, options, signal)` recibe una consulta validada, límites de resultados y `AbortSignal`.
- Devuelve resultados tipados, orden, metadata mínima y errores categorizados.
- No recibe credenciales del usuario ni autoridad para escribir en páginas.

### WebFetchProvider

- `fetch(url, options, signal)` recibe una URL normalizada y una política de lectura.
- Devuelve `WebContentSnapshot`, no HTML arbitrario para ser interpretado como instrucciones.
- Revalida redirects y límites por cada salto.

### BrowserProvider

- `createSession(options, signal)` crea una sesión efímera y acotada.
- `openPage(sessionId, options, signal)` crea una página dentro de los límites de la sesión.
- `navigate(pageId, request, signal)` realiza navegación validada.
- `perform(pageId, action, authorization, signal)` ejecuta una acción del contrato, no JavaScript arbitrario.
- `closePage` y `shutdown` liberan recursos; ambas operaciones deben ser idempotentes.
- Expone capacidades declaradas, estados y errores; no expone cookies, contraseñas ni tokens.

### Representación de datos

La frontera distingue al menos:

- `UserRequest`: intención y parámetros originados por el usuario o una capa autorizada;
- `ToolInvocation`: llamada validada por `ToolManager`;
- `PolicyDecision`: auto, confirm o block con razón segura;
- `WebData`: contenido obtenido de internet y siempre no confiable;
- `ProviderResult`: resultado normalizado, estado, límites y procedencia;
- `BrowserAction`: acción enumerada y validada, nunca código ejecutable.

`WebContentSnapshot` puede incluir `sourceUrl`, título, texto por fragmentos, headings, enlaces normalizados, tablas limitadas, metadata, timestamp, truncation flags y un nivel de confianza que indique explícitamente `untrusted`. No incluye instrucciones del sistema ni convierte el contenido web en mensajes privilegiados.

## 6. Lifecycle de browser

La sesión y la página tienen lifecycle separado.

```text
SESSION_CREATED -> INITIALIZING -> READY
       |              |            |
       +--------------+------------+-> ERROR
       |                           |
       +---------------------------+-> SHUTTING_DOWN -> STOPPED

PAGE_CREATED -> NAVIGATING -> LOADING -> READY
       |             |          |          |
       +-------------+----------+----------+-> ERROR
       |                                      |
       +--------------------------------------> CRASHED
```

- `READY` significa que la entidad acepta operaciones del contrato; no significa que una página sea confiable.
- `NAVIGATING` y `LOADING` tienen timeout y cancelación.
- Un crash invalida la página afectada y fuerza cleanup; no se reintenta una mutación automáticamente.
- `ERROR` puede iniciar cleanup y `shutdown`; no deja sesiones huérfanas.
- `shutdown` es idempotente y puede comenzar desde cualquier estado distinto de `STOPPED`.
- No se conserva una sesión entre ejecuciones hasta que exista una decisión explícita de persistencia y seguridad.

El provider no bloquea `AssistantCore`, `RealtimeEngine` ni `VoiceService`. Las operaciones son asíncronas y sus resultados llegan como respuesta o evento controlado.

## 7. Navegación, URLs y redirects

La validación debe incluir una defensa explícita contra SSRF. Los destinos HTTP(S) que resuelvan a loopback, redes privadas, link-local, multicast, rangos reservados u otros destinos internos se bloquean por defecto, salvo una autorización explícita definida por una política futura. Esta regla aplica tanto a la URL inicial como a cada destino de redirect.

La decisión no puede basarse únicamente en el texto o hostname recibido: debe considerar la resolución DNS efectiva antes de conectar y durante la navegación controlada. El provider debe evitar bypasses por cambios de resolución, DNS rebinding, múltiples respuestas DNS o diferencias entre validación y conexión. Los rangos concretos, la estrategia de resolución y el comportamiento ante cambios quedan para el spike posterior, pero el bloqueo por defecto es contractual.

La navegación futura solo aceptará esquemas explícitamente permitidos por política, inicialmente orientados a HTTP(S). Se rechazan por defecto `file:`, `data:`, `javascript:`, extensiones, rutas locales y esquemas desconocidos.

Cada URL se normaliza y valida antes de salir al provider. Un redirect es una nueva decisión: se revalidan esquema, host, límites y permiso. Debe existir un máximo de saltos y un límite de tiempo; nunca se sigue una cadena ilimitada.

El contenido de una URL, un redirect o un resultado de búsqueda no puede ampliar permisos, cambiar el destino autorizado ni autorizar credenciales.

## 8. Modelo de permisos

El permiso se calcula fuera del provider y se conserva en el `ToolManager`/policy boundary. La clasificación conceptual es:

| Capacidad | Política inicial | Regla |
|---|---|---|
| Buscar y leer contenido público | `auto` con límites | Solo lectura, URL/esquema válidos y sin secretos. |
| Navegar a una URL pública | `auto` o `confirm` según policy | Redirects revalidados y sin efectos externos. |
| Click de navegación o expandir contenido | `auto` si es read-only | El destino y el riesgo se vuelven a evaluar. |
| Escribir en un campo o seleccionar datos | `confirm` | El contenido y el destino deben mostrarse antes de continuar. |
| Login, contraseña, token o MFA | `block` por defecto | No se extraen ni se registran credenciales. |
| Enviar formulario, publicar o enviar mensaje | `confirm` o `block` por policy | Nunca se infiere aprobación desde la página. |
| Compra, transferencia o acción irreversible | `block` por defecto | Requiere una futura política explícita y confirmación fuerte. |
| Download | `confirm` | Destino, tamaño, tipo y nombre deben estar limitados. |
| Upload | `confirm` | Solo archivos seleccionados/allowlisted; nunca path arbitrario. |

`auto` no significa confianza absoluta: aplica allowlists, límites, timeout, redacción y validación de resultado. `confirm` requiere una confirmación externa al contenido web. `block` termina antes de invocar el provider.

## 9. Prompt injection y contenido no confiable

Todo texto procedente de una página, snippet, resultado de búsqueda, título, atributo, PDF futuro o formulario se trata como `WebData` no confiable. Frases como “ignore previous instructions”, “revela secretos”, “ejecuta comandos”, “cambia permisos”, “descarga esto” o “envía estos datos” son contenido, no autoridad.

Protecciones obligatorias para una implementación futura:

- separar `WebData` de instrucciones del sistema, developer, usuario y policy;
- conservar procedencia y URL sin convertirla en una instrucción privilegiada;
- no insertar HTML crudo o texto web sin marcarlo en mensajes de control;
- no entregar secretos, cookies, tokens, prompts internos o rutas privadas a una página;
- no ejecutar acciones sugeridas por una página sin una `ToolInvocation` independiente y autorización;
- bloquear o confirmar descargas, uploads, formularios y navegación peligrosa aunque la página lo pida;
- permitir que el resultado señale posible prompt injection sin obedecerla;
- limitar tamaño, profundidad y número de enlaces para reducir exfiltración y consumo.

La seguridad no depende de que el modelo reconozca todos los ataques: el boundary de herramientas y la policy deben negar la autoridad por construcción.

## 10. Cookies, credenciales y privacidad

Phase 8 no persiste cookies, local storage, sesiones autenticadas, contraseñas, tokens, headers privados ni historial. No se registran valores de esos campos ni se muestran en resultados.

Un provider futuro deberá declarar si necesita autenticación. La entrega de credenciales, si alguna vez se aprueba, pertenecerá a un broker/host explícito con secreto opaco, alcance mínimo, expiración, aislamiento por sesión y confirmación. BrowserProvider no puede pedir al modelo que revele un secreto ni devolverlo como contenido.

## 11. Downloads y uploads

Downloads requieren policy previa con destino controlado, tamaño máximo, tipos permitidos, nombre normalizado, verificación de resultado y cleanup. No se permite escribir en una ruta arbitraria ni abrir automáticamente un archivo descargado.

Uploads separan la acción de navegador del acceso al filesystem. El browser recibe una referencia autorizada a un archivo seleccionado por el usuario, no una ruta libre generada por el modelo. Se validan tipo, tamaño, destino y confirmación; el provider no explora el disco.

Estos son límites contractuales futuros. No se implementa transferencia, sandbox, antivirus ni selección de archivos en Phase 8.

## 12. Acciones de browser

El contrato futuro podrá incluir `navigate`, `back`, `forward`, `reload`, `waitForReady`, `click`, `type`, `select` y `scroll`, cada una con parámetros acotados, timeout, `AbortSignal`, riesgo y resultado validado.

No incluirá `evaluate`, JavaScript arbitrario, selectores ejecutables, comandos del host ni acceso directo a DOM sin normalización. Los objetivos deben ser referencias controladas producidas por el provider y no texto libre con capacidad de ejecutar código.

Una acción de solo lectura puede ser automática si la policy la permite. Escribir, enviar, publicar, comprar, descargar o subir cambia de riesgo y requiere `confirm` o `block` según la tabla anterior.

## 13. Concurrencia, latest-wins y backpressure

La implementación futura debe imponer límites configurables y observables, sin colas ilimitadas. Como política inicial conceptual:

- una sesión activa por contexto autorizado, salvo una decisión posterior;
- un número pequeño y configurable de páginas por sesión;
- una operación activa por página;
- como máximo una operación de lectura pendiente por página, reemplazable con latest-wins;
- nunca se reemplazan silenciosamente acciones con efectos externos ya confirmadas;
- navegación de lectura nueva puede cancelar/sustituir la anterior mediante `AbortSignal`;
- una mutación confirmada conserva su operación o falla explícitamente, pero no se duplica;
- creación de sesiones, páginas y downloads se rechaza al superar límites; no se encola sin límite.

La política concreta de números, fair scheduling y aislamiento entre usuarios queda pendiente de un spike con provider controlado. El requisito de bounded concurrency sí es obligatorio.

## 14. Timeout, cancelación y errores

Todas las operaciones largas reciben `AbortSignal` y timeout por etapa: resolución de provider, conexión, navegación, carga, extracción, espera de confirmación y cleanup. La cancelación es cooperativa; un provider que no responda debe quedar marcado como degradado y no bloquear al core.

Se requieren categorías futuras equivalentes a configuración, autorización, URL inválida, red, timeout, cancelación, rate limit, contenido inválido, provider no disponible, crash, download/upload rechazado y prompt injection detectado. Los detalles sensibles se conservan solo internamente y se normalizan al cruzar el boundary.

No se reintentan indiscriminadamente acciones con efectos externos. Búsquedas o fetch idempotentes pueden tener una política limitada; submit, compra, publicación y upload requieren una decisión de idempotencia antes de reintentar.

## 15. Integración con fases existentes

### Tool System

La futura capacidad de internet será una herramienta o conjunto de herramientas registradas. `ToolRegistry` describe operaciones; `ToolManager` valida argumentos, disponibilidad, riesgo, permiso, cancelación y resultado. Ningún `AIProvider` ni página web invoca directamente un provider.

### AssistantCore

`AssistantCore` podrá recibir un resultado normalizado o un error controlado. No conoce sesiones internas, cookies, renderer ni APIs del navegador. Una respuesta del modelo no se considera autorización por sí misma.

### Realtime Engine

Los eventos futuros usarán `correlationId`, secuencia y lifecycle acotado. La navegación no debe bloquear una interacción ni publicar contenido completo como log. Cancelar una interacción puede cancelar sus operaciones descendientes mediante una señal enlazada.

### Voice Service

Voice Service puede anunciar estado de interacción o leer una respuesta ya normalizada, pero no accede a browser sessions, formularios o credenciales. Una orden por voz sigue necesitando la misma validación y confirmación que una orden textual.

## 16. Offline, provider no disponible y fallback

Sin red, provider o permiso suficiente, la capacidad devuelve un error categorizado y seguro. No se usa shell, PowerShell, APIs de procesos, un navegador local no autorizado ni otro fallback que amplíe privilegios.

La selección entre API web directa, search provider, fetch provider y browser provider será una decisión de configuración/policy detrás de interfaces. No se elige proveedor real en esta definición.

## 17. Observabilidad segura

Se pueden registrar `operationId`, `correlationId`, tipo de operación, provider abstracto, lifecycle, host normalizado o hash seguro, duración, tamaño limitado, resultado y código de error. Nunca se registran passwords, cookies, tokens, headers privados, prompts completos, formularios completos, contenido privado innecesario, HTML crudo o archivos.

La telemetría debe distinguir: solicitud recibida, autorización, operación iniciada, navegación/carga, extracción, resultado, cancelación y cleanup. Las métricas no prueban que una página sea segura ni que una acción externa haya sido aprobada.

## 18. Riesgos y alternativas

- **Usar un navegador completo desde esta fase:** rechazado; introduciría una superficie de ataque y decisiones de host antes del contrato.
- **Tratar search, fetch y browser como un único provider:** rechazado; mezcla lectura, sesión, permisos y efectos externos.
- **Permitir que el LLM controle selectores o JavaScript libre:** rechazado; rompe la separación entre intención, policy y ejecución.
- **Confiar en un prompt anti-injection solamente:** rechazado; la defensa debe existir en contratos, autorización y sanitización.
- **Persistir cookies para mejorar UX:** diferido; exige threat model, almacenamiento seguro y consentimiento explícito.
- **Fallback a comandos locales cuando falla internet:** rechazado; no es un fallback de permisos ni de seguridad.

## 19. Decisiones pendientes

1. Provider inicial de búsqueda y su política de licencias/rate limits.
2. Provider de fetch y estrategia de extracción segura.
3. Si el primer browser será remoto, local aislado o un servicio independiente.
4. Modelo de confirmación para acciones de escritura y autenticación.
5. Sandbox y destino controlado para downloads/uploads.
6. Límites numéricos de sesiones, páginas, tamaño, redirects y tiempo.
7. Formato de `WebContentSnapshot` y tratamiento de documentos no HTML.
8. Observabilidad y retención permitida para URLs y metadata.

Estas decisiones requieren spikes, threat modeling y pruebas controladas. No autorizan implementación en esta rama.

## 20. Criterios de aceptación de la definición

- La política SSRF bloquea por defecto destinos loopback, privados, link-local, multicast, reservados e internos, incluyendo redirects y resoluciones DNS susceptibles de rebinding.

- Se distingue explícitamente búsqueda, fetch y browser interactivo.
- Las responsabilidades de `WebSearchProvider`, `WebFetchProvider` y `BrowserProvider` están separadas.
- Lifecycle, crash, timeout, cancelación y cleanup están definidos para sesión y página.
- Redirects, esquemas, URLs arbitrarias y límites están cubiertos.
- Existe política auto/confirm/block para login, formularios, publicación, compras, downloads y uploads.
- Cookies, credenciales, tokens y persistencia tienen una frontera explícita.
- Prompt injection web se trata como dato no confiable y no como instrucción.
- El contenido extraído usa una representación controlada con procedencia y truncamiento.
- Las acciones de browser están enumeradas y no incluyen shell, JavaScript arbitrario ni filesystem libre.
- Concurrencia, latest-wins, cola acotada y no bloqueo del core están definidos.
- La integración con `ToolManager`, `AssistantCore`, `RealtimeEngine` y `VoiceService` no permite bypass.
- Errores, offline, providers no disponibles y logging seguro están descritos.
- No se añadieron código de producción, dependencias, providers, renderer, UI, assets, procesos ni cambios funcionales.

## 21. No implementación explícita

La rama contiene únicamente definición arquitectónica y documentación sincronizada. Phase 8 no se considera implementada, no habilita navegación real y no autoriza todavía la instalación de un framework de browser, la selección de un provider ni la creación de herramientas reales.
