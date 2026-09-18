# Phase 8 — Controlled Provider and Sandbox Test Results

## Estado

Esta es la segunda etapa del spike de Phase 8. El resultado es evidencia controlada y no una implementación de `WebSearchProvider`, `WebFetchProvider` o `BrowserProvider`. No se modificó `src/`, no se añadieron dependencias y no se ejecutó browser automation.

Fecha de ejecución: 2026-09-18
Base: `main` actual en `2cd5784d719c747d10749d04a11d54bd9d9d774b`
Rama: `phase/08-internet-browser-controlled-tests`
Entorno: Windows, PowerShell, Node.js `v22.18.0`

Comando del harness:

```text
node scripts/phase-08-controlled-tests/run.mjs
```

El harness usa únicamente APIs estándar de Node.js y fixtures locales. Las respuestas completas de proveedores no se guardan. Los resultados externos solo se ejecutan con la credencial correspondiente y con `PHASE_08_RUN_EXTERNAL=1` como opt-in explícito.

## 1. Fuentes oficiales revisadas

Antes de la ejecución se revisó la documentación vigente disponible para:

- [Brave Search authentication](https://api-dashboard.search.brave.com/documentation/guides/authentication) y [Web Search API](https://api-dashboard.search.brave.com/api-reference/web-search/post): `X-Subscription-Token`, endpoint REST y `count` máximo 20.
- [Tavily Search](https://docs.tavily.com/documentation/api-reference/endpoint/search), [rate limits](https://docs.tavily.com/documentation/rate-limits) y [pricing](https://www.tavily.com/pricing): `POST /search`, Bearer token, `max_results` hasta 20 y consumo por créditos según profundidad.
- [Exa Search](https://exa.ai/docs/reference/search): endpoint REST, `x-api-key`, `numResults` y campos de resultados.
- [Playwright BrowserContext](https://playwright.dev/docs/api/class-browsercontext), [context isolation](https://playwright.dev/docs/browser-contexts), [Service Workers](https://playwright.dev/docs/service-workers), [network routing](https://playwright.dev/docs/network) y [browser installation](https://playwright.dev/docs/browsers).

Estas son observaciones documentales actuales. No se transforman en decisiones definitivas ni sustituyen mediciones propias.

## 2. Search benchmark

El corpus reproducible contiene 20 consultas en `scripts/phase-08-controlled-tests/search-corpus.json`, con español e inglés, navegación, dominios oficiales, actualidad, ambigüedad, duplicados potenciales y prompt injection.

| Provider | Estado | Consultas | Motivo |
|---|---|---:|---|
| Brave | `NOT EXECUTED` | 0 | `BRAVE_API_KEY` no está disponible en el entorno. |
| Tavily | `NOT EXECUTED` | 0 | `TAVILY_API_KEY` no está disponible en el entorno. |
| Exa | `NOT EXECUTED` | 0 | `EXA_API_KEY` no está disponible en el entorno. |
| SerpApi | `NOT EXECUTED` | 0 | Provider opcional no solicitado y sin credencial. |

No se emitió ranking, p50, p95, utilidad, coste, error rate ni comportamiento 429 para providers que no se ejecutaron. No se inventaron respuestas ni métricas.

Cuando existan credenciales locales, el harness registrará únicamente por consulta:

- éxito/fallo y status HTTP;
- duración total, p50 y p95;
- cantidad de resultados, URLs inválidas y duplicados;
- estabilidad mínima del esquema;
- 429 y presencia de `Retry-After`;
- truncamiento y bytes acotados;
- utilidad definida previamente por dominio esperado o términos de relevancia.

Los cuerpos completos, API keys y headers privados no se persisten.

## 3. Fetch controlado

El harness levantó un servidor HTTP local de fixtures y un transporte controlado que separa hostname lógico, direcciones resueltas y destino efectivo. La URL pública lógica se mapea al fixture loopback únicamente para probar la política; por eso esta evidencia no se presenta como pinning de red de producción.

Resultado: **27/27 comprobaciones PASS**.

Se demostraron:

- respuesta 200 normal;
- límite y truncamiento de respuesta grande a 1 KiB en el caso de prueba;
- timeout de headers;
- cancelación durante lectura de body;
- redirect único y cadena limitada a cinco saltos;
- loop de redirects limitado;
- downgrade HTTPS → HTTP rechazado;
- content type HTML permitido y binario identificado como no permitido por la policy del harness;
- URLs `file:`, `data:`, `javascript:` y userinfo rechazadas;
- WebData conservado como dato no privilegiado;
- download hacia directorio temporal dedicado;
- upload desde archivo allowlisted;
- rechazo de path traversal por la policy de destino.

## 4. SSRF, DNS y egress controlado

La matriz local bloqueó:

- loopback IPv4 (`127.0.0.1`);
- loopback IPv6 (`::1`);
- RFC1918;
- link-local;
- multicast;
- unspecified;
- rangos reservados/documentación;
- IPv4-mapped IPv6;
- múltiples respuestas A con una dirección interna;
- múltiples respuestas AAAA con una dirección interna;
- redirect público → interno.

La prueba de DNS rebinding simuló una resolución pública para la validación y una IP privada como destino efectivo. El transporte rechazó el mismatch con `EFFECTIVE_DESTINATION_UNVERIFIED`.

Esto demuestra la decisión de política y la necesidad de verificar el destino efectivo dentro del boundary. No demuestra todavía que un socket real, un proxy o un navegador mantenga el pinning frente a DNS rebinding; esa prueba requiere un transporte/egress real aislado.

## 5. Browser local y remoto

| Área | Resultado |
|---|---|
| Browser local efímero | `NOT EXECUTED`: no hay Playwright/Selenium instalado y no se lanzó ningún proceso de browser. |
| Browser remoto/independiente | `NOT EXECUTED`: `BROWSER_REMOTE_ENDPOINT` y `BROWSER_REMOTE_TOKEN` no están disponibles. |
| Solicitudes secundarias | `NOT EXECUTED`: el harness de fetch no prueba egress de navegador. |
| Service Worker | `NOT EXECUTED`: requiere contexto real de browser. |
| Sandbox local | `NOT EXECUTED`: no se lanzó browser ni se modificaron flags de sandbox. |

Por tanto, todavía no existe evidencia propia para navegación, redirects, iframe, imagen, script, XHR/fetch, WebSocket, Service Worker, crash de browser, cleanup de browser o diferencia entre egress local y remoto. La ausencia de entorno remoto no se considera evidencia a favor de la opción local.

La documentación oficial de Playwright confirma que los `BrowserContext` no persistentes aíslan cookies y almacenamiento, pero también documenta límites de `browserContext.route()` con solicitudes atendidas por Service Workers. Esto mantiene abierta la solución definitiva entre interception, proxy/egress gateway, aislamiento de red o combinación de mecanismos.

## 6. Credenciales y observabilidad

- Credenciales utilizadas: ninguna.
- Variables consultadas sin imprimir valores: `BRAVE_API_KEY`, `TAVILY_API_KEY`, `EXA_API_KEY`, `SERPAPI_API_KEY`, `BROWSER_REMOTE_ENDPOINT`, `BROWSER_REMOTE_TOKEN`.
- Secretos persistidos: ninguno.
- Respuestas completas persistidas: ninguna.
- Logs persistentes con cookies, tokens, prompts completos o HTML completo: ninguno.
- El harness no importa `src/` ni providers productivos.

## 7. Límites observados

Los siguientes números siguen siendo hipótesis experimentales y no contratos:

| Límite | Valor del harness | Estado |
|---|---:|---|
| Resultados Search | 10 | Pendiente de medir con credenciales y coste real. |
| Timeout Search | 5 s | Pendiente de p50/p95 por provider. |
| Timeout Fetch | 500 ms en fixtures | Solo prueba determinista; el valor productivo sigue abierto. |
| Redirects | 5 | La cadena y loop pasan la prueba local. |
| Respuesta | 2 MiB por policy; caso de truncamiento a 1 KiB | Pendiente de corpus real. |

## 8. Decisiones propuestas

1. Mantener el corpus de 20 consultas y el esquema de métricas antes de ejecutar Search con credenciales.
2. Mantener el boundary de resolución completa, clasificación de todas las A/AAAA, validación del destino efectivo y fallo cerrado.
3. Mantener redirects manuales y revalidación por salto en cualquier futuro `WebFetchProvider`.
4. Mantener WebData separado de autoridad y no interpretar contenido de páginas como autorización.
5. Mantener el browser como `NOT EXECUTED` hasta disponer de una prueba aislada con contexto efímero, sandbox habilitado y suite de egress de solicitudes secundarias.
6. No añadir todavía Playwright, Selenium, un BaaS, un provider de búsqueda ni un egress proxy al producto.

## 9. Decisiones abiertas y riesgos residuales

- Provider Search final, coste, cuota, calidad en español y retención.
- Transporte real que garantice IP validada = IP utilizada.
- Egress del browser para subrecursos, WebSockets y Service Workers.
- Browser local frente a remoto/self-hosted y aislamiento real en Windows.
- Sandbox, downloads/uploads y cleanup tras crash de browser.
- Prueba dinámica de DNS rebinding con socket/proxy real.
- Documentos no HTML, extracción, límites productivos y corpus de utilidad.

## 10. Criterio de cierre

El controlled test **no está completo** porque Search no pudo ejecutarse sin credenciales y Browser no pudo ejecutarse sin un entorno aislado de browser. Esas ausencias están marcadas explícitamente como `NOT EXECUTED`; no se sustituyeron con afirmaciones teóricas.

La evidencia local obtenida es suficiente para validar el arnés de Fetch/SSRF/DNS/límites y para preparar la siguiente ejecución con credenciales temporales y un entorno de browser aislado. No autoriza aún una decisión definitiva de provider, sandbox ni egress.
