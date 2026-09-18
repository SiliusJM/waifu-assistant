# ADR-011: Definición de Internet & Browser

## Estado

Propuesta documental. Preparada en `phase/08-internet-browser`; requiere revisión y aprobación antes de cualquier implementación. No modifica `main` ni selecciona providers, frameworks o un host de navegador.

## Contexto

Las fases anteriores proporcionan `AssistantCore`, `ToolManager`, eventos realtime, cancelación, voz y avatar desacoplado. El acceso futuro a internet combina lectura de datos no confiables con posibles acciones externas de alto riesgo. Un diseño que trate búsqueda, fetch y browser como la misma capacidad facilitaría bypass de permisos, prompt injection, filtración de secretos y colas sin límite.

## Decisión

Definir tres puertos separados:

1. `WebSearchProvider` para resultados de búsqueda normalizados y solo lectura.
2. `WebFetchProvider` para obtener y extraer contenido de una URL autorizada.
3. `BrowserProvider` para sesiones efímeras, páginas, navegación y acciones enumeradas.

Los tres cruzan el boundary mediante resultados tipados, `AbortSignal`, timeout, errores categorizados y una representación de `WebData` marcada como no confiable. El provider no recibe autoridad del modelo ni puede saltarse `ToolManager`.

La ruta futura es:

```text
AssistantCore -> Internet/Browser capability -> ToolManager -> provider adapter
```

La policy distingue `auto`, `confirm` y `block`. Lectura pública limitada puede ser automática; login, formularios, publicación, compra, downloads y uploads requieren confirmación o bloqueo. Credenciales, cookies, tokens, persistencia, filesystem arbitrario y procesos quedan fuera por defecto.

Una página web nunca puede cambiar instrucciones, conceder permisos, pedir secretos ni autorizar una acción. Su contenido se conserva como `WebData` con procedencia y límites.

## Lifecycle y concurrencia

Sesiones y páginas tienen lifecycle explícito, con estados de inicialización, ready, navegación/carga, error, crash, shutdown y stopped. `shutdown` es idempotente y limpia desde cualquier estado no detenido.

Las operaciones son asíncronas y no bloquean `AssistantCore`, `RealtimeEngine` ni `VoiceService`. Cada operación usa `AbortSignal` y timeout. Se permite latest-wins para lecturas/navegación sustituibles, como máximo una operación pendiente por página y no se crean colas ilimitadas. Una mutación confirmada no se reemplaza ni reintenta sin una política de idempotencia.

## Seguridad

- Se validan esquema, URL, redirects, host, tamaño, tipo, destino y número de saltos.
- `file:`, `data:`, `javascript:`, extensiones, rutas locales y esquemas desconocidos se bloquean por defecto.
- No se exponen HTML crudo, cookies, tokens, contraseñas, headers privados, formularios completos o prompts internos.
- No se ejecutan JavaScript arbitrario, shell, `child_process`, `exec`, `spawn`, PowerShell, CMD ni código generado.
- Downloads y uploads requieren boundary explícito; el modelo nunca entrega una ruta local arbitraria.
- Los fallos offline o de provider devuelven error seguro y no activan un fallback local con más privilegios.

## Alternativas rechazadas

- Instalar Playwright/Puppeteer/Selenium/WebView ahora: añade superficie y decisiones irreversibles antes de validar el contrato.
- Usar un único provider para search, fetch y browser: mezcla riesgos y lifecycle incompatibles.
- Resolver prompt injection con una instrucción adicional al modelo: no sustituye policy ni aislamiento de datos.
- Permitir que el modelo ejecute JavaScript o elija selectores ejecutables: rompe el boundary de herramientas.
- Persistir cookies o autenticación para mejorar UX: requiere threat model y almacenamiento seguro aún no definidos.

## Consecuencias

El diseño permite comparar providers futuros sin cambiar `AssistantCore` y mantiene las acciones deterministas detrás de `ToolManager`. A cambio, requiere contratos de normalización, confirmación y límites antes de ofrecer navegación real. No existe una implementación utilizable como consecuencia de este ADR.

## Decisiones pendientes

Quedan para spikes posteriores el provider concreto, el tipo de host/sandbox, los límites numéricos, extracción de documentos, licencias, confirmación fuerte y política de persistencia. Ninguna de esas decisiones se toma en Phase 8 documental.
