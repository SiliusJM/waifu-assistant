# Phase 8 — Provider & Sandbox Spike

## Estado

Spike técnico documental preparado en `phase/08-internet-browser-implementation`, basado en `origin/main` después del merge de la definición de Phase 8. No integra providers, no añade dependencias, no modifica `src/`, no ejecuta browser automation y no convierte ninguna tecnología candidata en decisión definitiva.

Fecha de investigación: 2026-09-18. No se usaron credenciales, llamadas de producción ni datos de usuarios. Los límites comerciales y las versiones deben verificarse de nuevo antes de una implementación.

## 1. Objetivo y método

El spike reduce incertidumbre en tres fronteras independientes:

```text
AssistantCore
    -> Internet/Browser capability
    -> ToolManager: schema, disponibilidad, riesgo, permiso y confirmación
    -> provider adapter
    -> provider concreto
```

Se revisaron documentación oficial de APIs, lifecycle, aislamiento, autenticación, rate limits, descargas, uploads y cancelación. No se realizó benchmark de calidad, latencia, coste real ni seguridad dinámica porque eso requeriría credenciales y una infraestructura de prueba aislada.

Las conclusiones siguientes son recomendaciones para el siguiente experimento controlado, no contratos de producción.

## 2. WebSearchProvider

### 2.1 Candidatos evaluados

| Candidato | API/auth/resultados | Límites y coste observados | Ventajas | Riesgos y conclusión |
|---|---|---|---|---|
| Brave Search API | REST `GET /res/v1/web/search`, `X-Subscription-Token`; JSON con URLs, títulos, snippets, noticias, imágenes y metadata. Extra snippets ofrece hasta cinco extractos adicionales por resultado. | La página comercial publicada indica $5 por 1.000 requests, $5 de crédito mensual y capacidad de 50 QPS. La API permite hasta 20 resultados por página y offset limitado. | Índice web independiente, formato directo para un `WebSearchProvider`, safe search, dominios y snippets controlables. | Dependencia comercial, términos de uso y cobertura/calidad aún no medidos para español. Primer candidato recomendado para un benchmark controlado, no seleccionado para producción. |
| Tavily | REST `POST /search`, API key/Bearer; resultados procesados para aplicaciones AI, `max_results`, profundidad, dominios, respuesta opcional y contenido crudo opcional. | Documenta 100 RPM para keys de desarrollo y 1.000 RPM para producción; 429 puede incluir `Retry-After`. La oferta publicada incluye créditos gratuitos y pago por crédito. | Reduce trabajo inicial de ranking/extracción y expone una forma cercana al uso de AI. | Acopla búsqueda con procesamiento de contenido; el contenido crudo sigue siendo `WebData` no confiable. Hay que medir coste por profundidad y fidelidad de snippets. Candidato de comparación. |
| Exa | REST `POST https://api.exa.ai/search`, `x-api-key`; `numResults`, dominios, fechas, highlights, resumen y contenido opcional. | La documentación muestra errores 429 y `RATE_LIMIT_EXCEEDED`; el coste depende del tipo de búsqueda y de contenido solicitado. No se fija un límite interno del proyecto sin consultar la cuenta. | Búsqueda orientada a investigación, filtros de dominio/fecha y resultados enriquecidos. | Puede mezclar retrieval, resumen y extracción en una operación; aumenta superficie de normalización, coste y riesgo de tratar salida generada como evidencia. Candidato de comparación, no decisión. |
| SerpApi | REST con `api_key`; JSON normalizado y selección de motor, localización, idioma y paginación. | La página de precios observada publica plan gratuito de 250 búsquedas/mes, Starter de 1.000 y límites de throughput por hora; los planes son de pago por volumen. | Amplia cobertura de motores y formatos verticales; útil como referencia de fallback. | Dependencia de múltiples motores/terms, variación de resultados y coste; mayor complejidad contractual. Mantener como fallback experimental si el benchmark demuestra valor. |
| Bing Search API | API histórica de Microsoft. | Microsoft anunció su retiro completo para el 11 de agosto de 2025. | No aplica. | Excluido del shortlist actual; no iniciar integración contra este producto. |

### 2.2 Formato y normalización propuestos

El adapter debe convertir cualquier respuesta a una forma pequeña y no privilegiada:

- `title`, `url`, `displayUrl` y `snippet` limitado;
- `source`, `publishedAt` si existe y `rank` local;
- `queryId`/`operationId` y `truncated`;
- `providerMetadata` solo con campos allowlisted;
- nunca HTML crudo, headers, tokens, prompts del proveedor ni respuesta generada como instrucción.

La calidad de snippets no se puede inferir de la documentación. Debe medirse con un corpus fijo en español e inglés: intención informativa, navegación, noticias recientes, consultas ambiguas, dominios oficiales, duplicados, contenido en español latinoamericano y consultas con posible prompt injection.

### 2.3 Cancelación, timeout y dependencia

El adapter debe usar `AbortSignal` del Tool System, timeout total y clasificación de 408/429/5xx. No se reintenta una consulta indefinidamente. La política de rate limit debe respetar `Retry-After` con un límite local y sin convertir una API externa en una cola ilimitada.

El primer benchmark debe comparar p50/p95, error rate, tiempo total, resultados relevantes en las primeras posiciones, duplicados, coste por consulta, comportamiento ante 429 y estabilidad del esquema. Todavía no hay evidencia suficiente para seleccionar un proveedor.

## 3. WebFetchProvider

### 3.1 Transporte

La base técnica más pequeña para un primer spike es el `fetch` incorporado en Node.js 22, sin dependencia productiva adicional. `AbortSignal` permite cancelar fetch y aplicar timeout; el timeout debe cubrir conexión, headers y lectura limitada del body, no solo la resolución de la promesa inicial.

El fetch no debe confiar en redirects automáticos ni en la resolución de red implícita. La implementación futura debe controlar manualmente cada redirect, volver a validar esquema/host/IP/política y limitar saltos, tamaño y tiempo.

### 3.2 SSRF y DNS

La defensa contractual ya aprobada requiere bloquear por defecto destinos HTTP(S) que resuelvan a loopback, redes privadas, link-local, multicast, rangos reservados u otros destinos internos. La regla aplica a la URL inicial y a cada redirect.

El spike debe probar una secuencia de:

1. parseo y normalización de URL sin aceptar `file:`, `data:`, `javascript:`, esquemas desconocidos, userinfo peligroso o representaciones ambiguas;
2. resolución de todos los resultados A y AAAA;
3. clasificación contra una fuente mantenida de rangos especiales, incluyendo IPv4, IPv6, IPv4-mapped IPv6, multicast y rangos reservados;
4. validación del destino efectivo de conexión, no solo del hostname;
5. revalidación por redirect y ante cambios de resolución;
6. rechazo seguro si no se puede demostrar que la conexión usa un destino permitido.

Node documenta que `dns.promises.lookup()` usa una facilidad del sistema y no necesariamente el protocolo DNS; con `all: true` devuelve varias direcciones. Esto es útil para la prevalidación, pero no demuestra por sí solo que el socket posterior mantenga la misma dirección. Para evitar DNS rebinding, el spike debe comparar:

- resolver todos los A/AAAA y bloquear si cualquiera es interno;
- fijar o controlar el destino de conexión mediante un transporte/egress proxy que preserve la validación;
- probar un resolver controlado que devuelva primero una IP pública y después una IP interna;
- probar múltiples respuestas y diferencias entre la validación y el socket;
- preferir fallo cerrado cuando no exista pinning verificable.

OWASP recomienda controlar redirects, revisar IPv4 e IPv6 y resolver todas las direcciones para evitar bypasses de validación y DNS pinning. IANA debe ser la referencia para clasificar rangos especiales; no se fija todavía una lista codificada en producción.

### 3.3 Extracción y contenido no confiable

El pipeline futuro debe separar transporte, parseo, extracción y normalización:

```text
HTTP response -> bounded bytes -> media type check -> HTML parser
             -> extraction policy -> WebContentSnapshot(untrusted)
```

`@mozilla/readability` es un candidato para artículos: devuelve título y texto sin tags, pero su propia documentación recomienda sanitizar la salida no confiable y advierte que no pretende ser un sanitizer. Si se evalúa, debe combinarse con un DOM/parser con scripts y fetch remotos deshabilitados, más una sanitización o serialización a texto controlada.

La primera versión no debe ejecutar scripts, cargar subrecursos arbitrarios, exponer HTML crudo ni interpretar instrucciones de la página. El límite debe aplicarse antes de parsear y también después de extraer. PDF, DOCX, imágenes con OCR, feeds no estándar, archivos comprimidos y contenido binario quedan pendientes de un spike separado.

### 3.4 Propuesta de límites para medir

Son valores iniciales del spike, no contratos definitivos:

| Parámetro | Propuesta inicial | Qué debe medirse |
|---|---:|---|
| Redirects | 5 por operación | Sitios legítimos, loops, HTTPS downgrade y coste de revalidación. |
| Timeout total | 15 s; conexión 3 s; headers 5 s | p50/p95 de hosts públicos y comportamiento bajo stall. |
| Respuesta HTTP | 2 MiB antes de extracción | Tasa de truncamiento, memoria y utilidad del snapshot. |
| Texto normalizado | 100.000 caracteres | Calidad para artículos largos y presión de contexto. |
| Content types | HTML/texto explícitos | Falsos positivos y documentos no HTML pendientes. |

El adapter debe devolver `truncated`, `contentType`, `bytesRead`, `redirectCount`, `resolvedAddressesClass` y error categorizado sin incluir contenido completo en logs.

## 4. BrowserProvider

### 4.1 Opciones técnicas

| Opción | Evidencia disponible | Ventajas | Riesgos / coste operativo |
|---|---|---|---|
| Playwright local efímero | BrowserContexts no persistentes, aislamiento de cookies/cache, Chromium/Firefox/WebKit, `acceptDownloads`, uploads y conexión a browser existente. | API única, contextos aislados, buena compatibilidad con Windows y lifecycle explícito de browser/context/page. | Descarga y mantiene binarios de navegador; la documentación publica varios cientos de MB en Windows. El sandbox de Chromium debe verificarse explícitamente. Las operaciones de página y el cierre requieren pruebas de cancelación física. |
| Puppeteer local | API madura centrada en Chromium; BrowserContext y control de downloads/proxy. | Menor variabilidad si solo se decide Chromium/Chrome/Edge; buena integración Node. | Menor cobertura de engines que Playwright; instalación descarga Chromium y ejecuta componentes externos. La superficie de host y el control de red siguen siendo responsabilidad del adapter. |
| Selenium/WebDriver BiDi local o remoto | Protocolo estándar bidireccional, soporte multi-browser, eventos de red y browsing context; Selenium Grid soporta downloads gestionados y uploads remotos. | Mejor separación si el browser corre en un servicio independiente; estándar y multi-vendor. | Más componentes, latencia y lifecycle distribuido; la API BiDi todavía tiene áreas de madurez desigual y requiere pruebas del binding Node/Windows. |
| Browserless u otro BaaS compatible con Playwright/Puppeteer | Conexión remota por WebSocket; oferta cloud, fleet privada o self-hosted. | Aísla proceso/browser del desktop y facilita capacidad operacional, límites y sesiones. | Coste por sesión/tiempo, dependencia de red y proveedor, residencia de datos y credenciales. Un servicio remoto puede alcanzar redes internas si no se impone egress policy en su propia red. |
| Browserbase u otro servicio remoto por CDP | Sesión remota y conexión Playwright/CDP; separa search/fetch/browser en su oferta. | Reduce carga local y ofrece sesiones administradas. | Riesgo de proveedor, transferencia de datos, coste, retención y necesidad de demostrar aislamiento/egress/credentials antes de usarlo. |

### 4.2 Local, remoto o servicio independiente

- **Local aislado:** menor latencia y más privacidad; requiere contener el proceso/browser, limitar filesystem, bloquear egress interno y verificar el impacto de procesos/binarios en Windows.
- **Remoto gestionado:** separa el host desktop del browser y facilita escalado; aumenta latencia, coste, superficie de credenciales y exposición de contenido.
- **Servicio independiente self-hosted:** permite una política de red y sandbox propios; añade despliegue, actualización, monitorización, autenticación entre servicios y recuperación ante crash.

La recomendación del spike es no elegir todavía un modo definitivo. La siguiente prueba controlada debe comparar Playwright local efímero contra un WebDriver/BaaS remoto con egress restringido. La decisión debe basarse en aislamiento probado, no únicamente en ergonomía de API.

### 4.3 Lifecycle, capabilities y cancelación

El provider futuro debe declarar capabilities para:

- engines y modo headless/headed;
- contextos efímeros y persistencia explícitamente desactivada;
- navegación, waits, click, type, select, scroll;
- interceptación/validación de redirects y requests;
- downloads/uploads con destino controlado;
- observación de crash, timeout y cierre;
- cancelación cooperativa por operación.

Playwright documenta `BrowserContext.close()` y `browser.close()` como cleanup explícito, y su API HTTP admite `AbortSignal`. No se debe asumir que todas las acciones de página tienen la misma semántica de abort: el spike debe probar abort durante navegación, wait, click, upload, download y shutdown, incluyendo el caso en que cerrar context/page sea la única cancelación física disponible.

Credenciales y storage state permanecerán fuera de la primera prueba. La documentación de Playwright advierte que los archivos de estado autenticado pueden contener cookies y headers utilizables para suplantación; no deben entrar en Git, logs ni persistencia del asistente.

## 5. Seguridad que debe demostrar el spike

El spike futuro necesita fixtures y pruebas aisladas, no una integración en `src/`:

### Red y SSRF

- loopback IPv4/IPv6;
- RFC1918 y redes privadas equivalentes;
- link-local IPv4/IPv6;
- multicast, broadcast, unspecified y rangos reservados;
- shared address space, documentación, benchmarking y otros rangos especiales según IANA;
- IPv4 embebido en IPv6 y representaciones numéricas/hexadecimales ambiguas;
- URL con userinfo, puertos inusuales, trailing dot, IDN/punycode y normalización;
- redirect público → interno, interno → público, loop de redirects y downgrade de HTTPS;
- DNS con múltiples A/AAAA, cambio de respuesta y DNS rebinding;
- diferencia entre IP validada y IP usada por el socket/browser;
- fallo cerrado si el proxy/browser remoto no permite verificar el egress.

### Datos y autoridad

- página con “ignore previous instructions”, solicitud de secretos y orden de shell;
- contenido que intenta autorizar una compra, descarga, upload o formulario;
- HTML con scripts, iframes, imágenes y links externos;
- extracción que confirma que el resultado solo produce `WebData` con procedencia y truncamiento;
- ausencia de cookies, tokens, prompts internos y formularios completos en logs/resultados.

### Host y filesystem

- upload sin ruta arbitraria y sin exploración del disco;
- download con destino allowlisted, tamaño/tipo máximos y cleanup;
- symlink/junction y path traversal en el harness aislado;
- comprobación de que el provider no requiere shell, `child_process`, `exec`, `spawn`, PowerShell o código generado;
- crash/timeout/shutdown que libera sesión, página, sockets y temporales.

## 6. Límites iniciales propuestos

Estos límites son hipótesis del spike y no contratos de Phase 8:

| Área | Valor inicial para experimentar | Criterio para cambiarlo |
|---|---:|---|
| Redirects | 5 | Cobertura de sitios legítimos y prevención de loops. |
| Timeout de búsqueda | 5 s | p95 y tasa de 429/error del proveedor. |
| Timeout de fetch | 15 s total | p95 de conexión/headers/body y cancelación. |
| Resultados de búsqueda | 10, nunca más de 20 del provider | Calidad de top-k, coste y contexto útil. |
| Páginas por sesión | 3 | RAM, estabilidad y aislamiento por context. |
| Operaciones por página | 1 activa | Corrección de lifecycle y no solapamiento. |
| Pending latest-wins | 1 lectura pendiente | Latencia y pérdida aceptable de estados obsoletos. |
| Download | 10 MiB, un archivo por operación | Casos legítimos, consumo y validación de tipo/destino. |
| Upload | 5 MiB, un archivo allowlisted por operación | Casos legítimos, privacidad y tiempo de transferencia. |
| Bytes de fetch | 2 MiB; texto 100.000 caracteres | Memoria, utilidad y truncamiento observable. |

Los números deben medirse con un corpus y un host de pruebas propio. No se deben copiar a contratos productivos hasta demostrar seguridad, coste, latencia, estabilidad y experiencia de usuario.

## 7. Propuesta de materialización futura

### WebSearchProvider

Un adapter por proveedor traducirá una consulta validada a REST, aplicará timeout/retry categorizado y devolverá resultados controlados. El adapter no entregará credenciales a `AssistantCore`, no ejecutará fetch adicional sin una invocación separada y marcará todo snippet como `WebData`.

### WebFetchProvider

Un transport boundary se encargará de URL normalization, allow/block policy, DNS/SSRF, redirects manuales, límites de bytes, timeout y `AbortSignal`. Un extractor separado convertirá HTML permitido a `WebContentSnapshot`; media types no soportados devolverán un error explícito. La salida nunca será una instrucción del sistema.

### BrowserProvider

Un adapter de sesión expondrá session/page IDs opacos, capabilities declaradas, acciones enumeradas y resultados controlados. La policy y `ToolManager` decidirán si una acción es `auto`, `confirm` o `block`; el provider no decide autorización. El host/sandbox será intercambiable y la integración no conocerá Playwright, Puppeteer, Selenium o BaaS concretos.

## 8. Decisiones propuestas y abiertas

### Propuestas basadas en la evidencia del spike

1. Shortlist de búsqueda: Brave como primera evaluación directa; Tavily y Exa como comparadores; SerpApi solo si la cobertura multi-engine justifica su coste y términos.
2. Bing Search API queda excluida por retiro del producto.
3. `fetch` nativo de Node es el baseline de transporte, condicionado a demostrar un boundary SSRF/DNS seguro; no usar una librería como sustituto de esa policy.
4. La extracción de artículos puede evaluar Mozilla Readability, siempre con sanitización/serialización controlada y sin scripts/subrecursos.
5. El primer experimento de browser debe comparar un contexto local efímero y una opción remota/independiente, con la misma suite de egress, lifecycle, cancelación y credentials boundary.
6. No añadir dependencias ni providers al producto durante este spike.

### Decisiones que permanecen abiertas

- proveedor de búsqueda final, precio, licencia, retención y calidad en español;
- provider y estrategia de extracción para HTML, PDF y documentos no HTML;
- forma de pinning de DNS y egress proxy/sandbox;
- Playwright, Puppeteer, Selenium/BiDi, BaaS o servicio self-hosted;
- local vs remoto vs servicio independiente;
- sandbox real en Windows, actualización de binarios y coste operacional;
- confirmación fuerte, autenticación y tratamiento de credentials;
- números definitivos de límites, cuotas, downloads/uploads y retención;
- métricas de fidelidad, latencia, coste, errores y prompt injection.

## 9. Pruebas que faltan

Antes de implementar contratos productivos deben existir pruebas controladas que demuestren:

- respuestas exitosas y errores HTTP de cada search provider sin credenciales en el repositorio;
- cancelación y timeout durante DNS, conexión, headers, body y backoff;
- SSRF para todos los rangos y variantes de URL relevantes;
- redirects y DNS rebinding sin alcanzar red interna;
- extracción determinista, truncamiento y contenido no HTML rechazado de forma segura;
- aislamiento de browser contexts/sesiones y cleanup tras crash;
- cancelación física o degradación bounded de cada operación de browser;
- downloads/uploads con tamaño, tipo, destino y path policy;
- ausencia de secretos en logs y de autoridad en `WebData`;
- no shell/process APIs y no acceso arbitrario al filesystem;
- límites de concurrencia, una operación por página y un solo pending latest-wins;
- regresión completa de Phase 1–7.

## 10. Resultado del spike

El spike reduce el espacio de búsqueda, pero no autoriza implementación productiva. La recomendación inmediata es ejecutar una segunda prueba aislada con credenciales temporales y hosts propios: comparar Brave/Tavily/Exa para search, `fetch` nativo con transporte SSRF controlado para fetch y Playwright local efímero contra Selenium/BaaS remoto para browser. Solo después de medir seguridad, calidad, p95, coste, cancelación y aislamiento se podrá registrar una decisión definitiva.

## Fuentes oficiales consultadas

- [Brave Search API](https://brave.com/search/api/) y [referencia Web Search](https://api-dashboard.search.brave.com/app/documentation/web-search/get-started).
- [Tavily Search API](https://docs.tavily.com/documentation/api-reference/endpoint/search), [rate limits](https://docs.tavily.com/documentation/rate-limits) y [pricing](https://www.tavily.com/pricing).
- [Exa Search API](https://exa.ai/docs/reference/search).
- [SerpApi Search API](https://serpapi.com/search-api) y [pricing](https://serpapi.com/pricing).
- [Microsoft: Bing Search APIs retirement](https://learn.microsoft.com/en-us/lifecycle/announcements/bing-search-api-retirement).
- [OWASP SSRF Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html).
- [Node.js DNS API](https://nodejs.org/api/dns.html) y [MDN AbortSignal](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal).
- [Mozilla Readability](https://github.com/mozilla/readability).
- [Playwright Browser](https://playwright.dev/docs/api/class-browser), [BrowserContext](https://playwright.dev/docs/api/class-browsercontext), [browsers](https://playwright.dev/docs/browsers) y [APIRequestContext](https://playwright.dev/docs/api/class-apirequestcontext).
- [Puppeteer installation](https://pptr.dev/guides/installation) y [BrowserContextOptions](https://pptr.dev/api/puppeteer.browsercontextoptions).
- [Selenium WebDriver BiDi](https://www.selenium.dev/documentation/webdriver/bidi/) y [Remote WebDriver](https://www.selenium.dev/documentation/webdriver/drivers/remote_webdriver/).
- [Browserless documentation](https://docs.browserless.io/) y [Browserbase session example](https://dev.browserbase.com/templates/getting-started-with-browserbase).
