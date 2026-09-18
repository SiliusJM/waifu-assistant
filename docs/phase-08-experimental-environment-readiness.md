# Phase 8 — Experimental Environment Readiness

## Estado y propósito

Este documento es un checklist operativo para preparar una máquina o sesión dedicada antes de ejecutar la evidencia pendiente de Phase 8. No habilita features, no instala software, no crea VMs, no modifica Firewall y no cambia el host de trabajo.

Base revisada: `origin/main` en `444ab6ec9c2c275a0141a997fb7f29a3c971552a`.

ADR-012 permanece provisional / `decision-gate`. La implementación de `WebSearchProvider`, `WebFetchProvider` y `BrowserProvider` sigue fuera de alcance.

## 1. Regla de entrada

No iniciar ninguna prueba si falta uno de estos puntos:

- [ ] La máquina es dedicada, desechable o tiene snapshot/reimagen verificable.
- [ ] El propietario del entorno autorizó explícitamente los permisos administrativos requeridos.
- [ ] Existe rollback documentado para features, red, perfiles, temporales, certificados y credenciales.
- [ ] El tráfico experimental puede separarse del tráfico personal o de producción.
- [ ] El perfil principal, storage state, cookies, tokens y trust store del usuario no se utilizarán.
- [ ] Se sabe dónde se guardarán los artefactos y cómo se redacted secretos antes de conservarlos.
- [ ] Las categorías `PASS`, `FAIL`, `LIMITATION`, `NOT EXECUTED` y `SIMULATED` se reportarán por caso, sin inferencias.

Si la máquina no cumple la regla de entrada, el resultado de la etapa debe ser `NOT EXECUTED`, no una simulación presentada como aislamiento.

## 2. Requisitos comunes del entorno

### Hardware y Windows

- [ ] Equipo físico o entorno de virtualización dedicado, separado del host de trabajo habitual.
- [ ] Virtualización por hardware disponible y habilitada únicamente en el entorno dedicado si el mecanismo elegido la necesita.
- [ ] Recursos suficientes para ejecutar simultáneamente browser, fixture, boundary de egress, observabilidad y temporales. Los mínimos exactos no están fijados por la evidencia actual y deben medirse en el spike dedicado.
- [ ] Edición, versión y build de Windows comprobadas directamente en la sesión dedicada; no reutilizar la combinación ambigua documentada en el host actual.
- [ ] Reloj, zona horaria, rutas y adaptadores registrados antes de la prueba para poder detectar cambios.

### Permisos

- [ ] Cuenta administrativa temporal o sesión elevada disponible solo en la máquina dedicada.
- [ ] Permiso explícito para consultar y, si fuera imprescindible, habilitar componentes de virtualización en esa máquina.
- [ ] Permiso explícito para crear recursos temporales de VM/Sandbox y eliminarlos mediante el procedimiento de rollback.
- [ ] Cualquier regla de Firewall debe estar limitada al entorno experimental, tener propietario, TTL/rollback y snapshot previo. Nunca modificar reglas globales del host de trabajo.
- [ ] Los permisos no autorizan a introducir shell arbitrario, APIs de procesos o cambios productivos en el repositorio.

### Software

- [ ] Node.js y los harnesses de Phase 8 disponibles en la revisión exacta que se vaya a probar.
- [ ] Playwright/Chromium disponibles fuera del repositorio o provisionados únicamente en el entorno experimental.
- [ ] `chromiumSandbox=true`, sin `--no-sandbox` y sin `ignoreHTTPSErrors`.
- [ ] Un mecanismo de certificado TLS efímero, confiable para el browser y aprobado para el fixture. Si no existe, HTTPS permanece `NOT EXECUTED`.
- [ ] Un método de resolver/egress controlado que permita observar DNS, IP validada, IP efectiva y socket sin cambiar el DNS global del host.
- [ ] Un método de supervisión y cleanup aprobado para timeout, shutdown y crash. Si solo existe cleanup cooperativo, crash cleanup permanece `NOT EXECUTED`.
- [ ] No instalar software ni dependencias en esta rama; cualquier dependencia dev-only futura necesita justificación separada y revisión de alcance.

## 3. Separación host / entorno aislado

### Puede ejecutarse en el host dedicado

- [ ] Orquestación del experimento y lectura de configuración no secreta.
- [ ] Recopilación de metadatos del entorno, hashes, timestamps y resultados redacted.
- [ ] Boundary de observabilidad inferior, solo si puede demostrarse que todo el tráfico del browser atraviesa ese boundary.
- [ ] Fixture Search con credenciales temporales, preferentemente en un workspace efímero sin datos personales.
- [ ] Control de rollback y verificación posterior.

La ejecución en el host dedicado no demuestra aislamiento OS-level por sí sola. La disponibilidad de servicios, un adaptador virtual o `chromiumSandbox=true` tampoco es evidencia de seguridad del SO.

### Debe ejecutarse dentro de VM/Sandbox o browser remoto

- [ ] Browser, contexto/perfil efímero y todas las páginas de la prueba de aislamiento.
- [ ] Workload de navegación y solicitudes secundarias.
- [ ] Fixtures que deban representar el lado aislado del boundary.
- [ ] Archivos ficticios y storage de prueba.
- [ ] Credenciales ficticias del fixture; nunca secretos del usuario.

La topología definitiva queda abierta: una VM temporal Hyper-V, Windows Sandbox confirmado o browser remoto pueden ser candidatos. Este checklist no selecciona ninguno como arquitectura productiva.

## 4. Checklist por prueba

### 4.1 HTTPS/TLS

**Requisitos de hardware/Windows y permisos**

- [ ] Entorno dedicado con capacidad de ejecutar browser y fixture TLS sin modificar el trust store global.
- [ ] Permisos para crear y eliminar temporales del fixture, no para instalar certificados permanentemente.

**Software y ubicación**

- [ ] Browser y fixture HTTPS efímero dentro del entorno de prueba o en una frontera controlada.
- [ ] Mecanismo de emisión de certificado de prueba confiable para el hostname del fixture, validado antes de comenzar.
- [ ] El host puede orquestar y observar; la navegación y la conexión TLS deben ocurrir dentro del entorno bajo prueba.

**Credenciales y persistencia**

- [ ] No se requieren credenciales de proveedor.
- [ ] Clave/certificado solo temporales, fuera de Git, fuera de logs y eliminados en `finally`.
- [ ] No usar certificados del sistema, trust store permanente, `ignoreHTTPSErrors` ni claves reales.

**Rollback**

- [ ] Registrar temporales antes de iniciar.
- [ ] Eliminar certificado, clave, fixture, sockets y perfiles al finalizar.
- [ ] Confirmar que trust store, políticas Windows y configuración del host no cambiaron.

**Evidencia obligatoria**

- [ ] Hostname solicitado y redirect chain.
- [ ] Estado TLS y hostname validado, sin guardar secretos de la clave.
- [ ] IP validada, IP efectiva y socket observado por el boundary inferior.
- [ ] Resultados individuales HTTPS→HTTPS, HTTPS→HTTP, HTTPS→interno y CONNECT/WebSocket TLS si el fixture lo permite.
- [ ] `internalHits`, errores, timeout, cancelación y cleanup.

**Clasificación**

- `PASS`: handshake y política esperada se observan con el boundary inferior, sin bypass TLS y con cleanup confirmado.
- `FAIL`: el caso ejecutado incumple la política o alcanza un destino interno no autorizado.
- `LIMITATION`: el fixture funciona parcialmente, pero no demuestra la propiedad completa.
- `NOT EXECUTED`: no hubo fixture confiable, trust válido o conexión reproducible.
- `SIMULATED`: solo se modeló la política; no hubo handshake/socket real.

### 4.2 DNS rebinding, múltiples A/AAAA y socket

**Requisitos de hardware/Windows y permisos**

- [ ] Red experimental aislada o VM/Sandbox cuya resolución pueda controlarse sin tocar DNS global, hosts file global o router del usuario.
- [ ] Permisos para observar la red del entorno dedicado y eliminar cualquier resolver temporal.

**Software y ubicación**

- [ ] Resolver de prueba y boundary inferior que registren todas las respuestas relevantes.
- [ ] Browser dentro del entorno aislado; resolver, fixture y observabilidad ubicados de forma que se conozca qué conexiones atraviesan el boundary.
- [ ] El host solo recopila evidencia; no se debe confundir una consulta local de Node con el socket real del browser.

**Credenciales y persistencia**

- [ ] No se requieren credenciales de proveedor.
- [ ] No cambiar DNS global, router, trust store ni configuración permanente del host.
- [ ] Cualquier cache, resolver, ruta o adapter temporal debe tener snapshot y rollback.

**Rollback**

- [ ] Registrar configuración DNS/rutas/adaptadores antes de iniciar.
- [ ] Vaciar o eliminar únicamente caches y recursos temporales del entorno experimental.
- [ ] Verificar que ningún proceso, socket, regla o resolver temporal sobreviva.

**Evidencia obligatoria**

- [ ] Hostname solicitado y respuesta inicial con múltiples A/AAAA cuando corresponda.
- [ ] IP validada por la política, IP efectiva usada y `socket.remoteAddress` real.
- [ ] Cambio controlado de respuesta y decisión ante mismatch.
- [ ] Momento de validación frente al momento de conexión.
- [ ] `internalHits=0` cuando el destino interno deba bloquearse.

**Clasificación**

- `PASS`: el browser/boundary registra la cadena completa y bloquea el mismatch antes del socket no autorizado.
- `FAIL`: el socket efectivo difiere de la política o un destino interno recibe tráfico.
- `LIMITATION`: solo se observa el resolver o un fixture local, no el socket del browser bajo la política real.
- `NOT EXECUTED`: no hay red/resolver aislado reproducible.
- `SIMULATED`: el cambio de respuesta se representa sin resolver/socket real.

### 4.3 Aislamiento OS/network y filesystem

**Requisitos de hardware/Windows y permisos**

- [ ] Máquina dedicada con virtualización y permisos administrativos, o servicio remoto cuyo aislamiento sea auditable.
- [ ] Snapshot/reimagen antes de cualquier habilitación experimental.
- [ ] No usar el host de trabajo ni una regla Firewall host-wide como única frontera.

**Software y ubicación**

- [ ] VM temporal o Windows Sandbox confirmado, con red explícita y filesystem efímero.
- [ ] Browser, perfil, fixtures y archivos ficticios dentro del entorno aislado.
- [ ] Observabilidad fuera del browser y, cuando sea posible, debajo de la capa que se desea probar.

**Credenciales y persistencia**

- [ ] Sin credenciales reales, perfil principal ni storage state del host.
- [ ] No montar el workspace completo ni carpetas personales del host.
- [ ] Cualquier carpeta compartida debe ser mínima, temporal y registrada; si no puede restringirse, el caso es `LIMITATION`.

**Rollback**

- [ ] Snapshot o imagen limpia antes del experimento.
- [ ] Eliminar VM/Sandbox, disco, perfiles, sockets, adaptadores y temporales.
- [ ] Restaurar features y políticas únicamente dentro del entorno dedicado; confirmar que el host de trabajo no cambió.

**Evidencia obligatoria**

- [ ] Identidad del entorno y límites de red/filesystem.
- [ ] Directorios permitidos y tentativa controlada de acceso fuera del workspace.
- [ ] Cookies, storage y perfiles antes/después, siempre ficticios.
- [ ] Navegación, redirects, subrecursos, fetch/XHR, WebSocket y Service Worker bajo el boundary inferior.
- [ ] Estado de red, `internalHits`, artefactos, cleanup normal, timeout y shutdown.

**Clasificación**

- `PASS`: la frontera aislada está demostrada por evidencia inferior al browser y se verifica cleanup/rollback.
- `FAIL`: un canal accede al host/red interna o queda un artefacto no autorizado.
- `LIMITATION`: solo se observa una restricción browser-level o una opción de lanzamiento.
- `NOT EXECUTED`: no existe entorno aislado utilizable.
- `SIMULATED`: la separación se describe o modela sin ejecutar el boundary real.

### 4.4 Browser remoto o browser dentro de VM/Sandbox

**Requisitos de hardware/Windows y permisos**

- [ ] Para VM/Sandbox: host dedicado con virtualización y permisos de lifecycle.
- [ ] Para remoto: endpoint experimental, propietario identificado, egress observable y procedimiento de shutdown/cleanup.
- [ ] Ninguna de las opciones debe depender del perfil principal del usuario.

**Software y ubicación**

- [ ] Playwright/Chromium y fixture dentro de la VM/Sandbox, o browser remoto con API de sesión/página y `AbortSignal` equivalente documentado.
- [ ] Configuración de capabilities, downloads/uploads y lifecycle registrada sin convertirla en contrato productivo.
- [ ] El host solo orquesta y recoge resultados redacted.

**Credenciales y persistencia**

- [ ] Para remoto, endpoint y token de corta duración solo si el propietario del entorno los proporciona explícitamente.
- [ ] No guardar endpoint/token en Git, logs, documentación ni capturas.
- [ ] Revocar o expirar el token al terminar.

**Rollback**

- [ ] Cerrar sesiones/páginas y eliminar perfiles efímeros.
- [ ] Destruir VM/Sandbox o cerrar el servicio remoto según su procedimiento documentado.
- [ ] Confirmar que no quedan sockets, uploads, downloads ni artefactos.

**Evidencia obligatoria**

- [ ] Ubicación real del browser y límites de confianza.
- [ ] Lifecycle de sesión/página, cancelación y timeout.
- [ ] Egress de todos los canales, observabilidad y `internalHits`.
- [ ] Latencia, errores, cleanup y diferencias entre local y remoto.

**Clasificación**

- `PASS`: el runtime se ejecuta en el entorno declarado y las fronteras/canales se observan de forma reproducible.
- `FAIL`: el runtime o un canal supera la política declarada.
- `LIMITATION`: solo se demuestra disponibilidad o configuración, no aislamiento.
- `NOT EXECUTED`: falta endpoint, VM/Sandbox o lifecycle reproducible.
- `SIMULATED`: se compara arquitectura sin iniciar el runtime correspondiente.

### 4.5 Crash cleanup seguro

**Requisitos de hardware/Windows y permisos**

- [ ] Entorno desechable con supervisor o lifecycle de VM/Sandbox aprobado para producir un fallo controlado.
- [ ] Permiso explícito para el método de fallo; no usar terminación arbitraria en el host de trabajo.
- [ ] Método de recuperación y snapshot antes de iniciar.

**Software y ubicación**

- [ ] Browser/fixture dentro del entorno dedicado.
- [ ] Supervisor externo o mecanismo de lifecycle cuya semántica de crash esté documentada.
- [ ] Si solo existe `browser.close()` o shutdown cooperativo, eso es cleanup normal, no crash cleanup.

**Credenciales y persistencia**

- [ ] Solo datos ficticios y perfiles temporales.
- [ ] No usar credenciales reales para provocar o recuperar el fallo.
- [ ] No añadir APIs de proceso al producto ni al harness de producción.

**Rollback**

- [ ] Snapshot/imagen limpia y procedimiento de restauración probado antes de la prueba.
- [ ] Eliminar temporales, sockets, perfiles, discos y recursos del supervisor.
- [ ] Verificar que el host dedicado y el repositorio queden limpios.

**Evidencia obligatoria**

- [ ] Causa/método del fallo y por qué es seguro y reproducible.
- [ ] Recursos existentes antes del fallo.
- [ ] Recursos restantes después de timeout, shutdown y crash.
- [ ] Logs redacted y códigos de salida del supervisor sin secretos.

**Clasificación**

- `PASS`: el fallo controlado ocurre en el entorno dedicado y no deja recursos no autorizados, con evidencia del supervisor.
- `FAIL`: quedan procesos, sockets, perfiles, archivos o credenciales temporales sin limpiar.
- `LIMITATION`: solo se probó cleanup cooperativo o el método no permite observar todos los recursos.
- `NOT EXECUTED`: no existe método de crash seguro aprobado.
- `SIMULATED`: se describe un crash sin ejecutarlo.

### 4.6 Search real con credenciales temporales

**Requisitos de hardware/Windows y permisos**

- [ ] Máquina/sesión dedicada o runner aislado; no se requieren privilegios de administrador del host si la prueba usa solo HTTPS saliente controlado.
- [ ] Límites de coste, tiempo, consultas y rate limit aprobados antes de ejecutar.

**Software y ubicación**

- [ ] Harness Search existente y provider/candidato explícitamente elegido para esa ejecución.
- [ ] HTTPS/TLS del cliente verificado, timeout y cancelación activos.
- [ ] Puede ejecutarse en el host dedicado o dentro de VM/Sandbox; el aislamiento OS no debe inferirse por realizar una llamada HTTPS.

**Credenciales temporales necesarias**

- [ ] API key temporal, revocable y limitada al proveedor que se vaya a probar: Brave, Tavily o Exa.
- [ ] Para comparar varios candidatos, una credencial temporal independiente por proveedor.
- [ ] El usuario/propietario debe proporcionar o autorizar esas credenciales fuera del repositorio; no se inventan ni se imprimen.
- [ ] Límites de gasto/rate limit y ventana de expiración registrados sin guardar el secreto.

**Persistencia y rollback**

- [ ] Inyectar secretos solo como variables de entorno de la sesión experimental.
- [ ] No escribir `.env`, logs, fixtures, snapshots ni documentación con la clave.
- [ ] Revocar/rotar las claves y limpiar variables/artefactos al finalizar.

**Evidencia obligatoria**

- [ ] Corpus y número de consultas exactos, sin datos personales.
- [ ] Latencia p50/p95, errores, rate limits, tokens/coste si el proveedor los expone y cancelación/timeout.
- [ ] Resultados normalizados y procedencia sin almacenar credenciales.
- [ ] `relevant` solo como heurística de dominio esperado o término textual; no es accuracy ni calidad semántica definitiva.

**Clasificación**

- `PASS`: llamadas reales con credencial temporal válida, límites respetados y resultados/errores reproducibles.
- `FAIL`: el provider incumple el contrato, expone secretos, ignora cancelación/límites o devuelve resultados inválidos.
- `LIMITATION`: el proveedor responde, pero faltan métricas, corpus o controles para concluir calidad/coste.
- `NOT EXECUTED`: no se proporcionó credencial temporal o el endpoint no está disponible.
- `SIMULATED`: resultados mock o análisis documental sin llamada real.

## 5. Rollback general y cierre

- [ ] Capturar inventario de features, servicios, adaptadores, reglas, rutas, perfiles y temporales antes de iniciar.
- [ ] Ejecutar solo en la máquina/sesión dedicada y conservar snapshot o imagen limpia.
- [ ] Preferir destrucción de la VM/Sandbox completa al rollback manual de recursos.
- [ ] No restaurar cambios sobre el host de trabajo mediante scripts automáticos sin revisión explícita.
- [ ] Revocar credenciales temporales, eliminar certificados/claves y limpiar perfiles/temporales.
- [ ] Comparar inventario posterior con el inicial y registrar cualquier diferencia como `FAIL` o `LIMITATION`.
- [ ] Ejecutar regresión del repositorio sin modificar `src/`, manifests o lockfiles.

## 6. Gate de preparación

El entorno puede pasar a la ejecución de evidencia solo cuando todas estas afirmaciones sean verificables:

- [ ] La frontera de aislamiento y su propietario están identificados.
- [ ] La ruta del tráfico browser hacia el boundary inferior está demostrada.
- [ ] Existe rollback probado y no depende de improvisar durante un fallo.
- [ ] El fixture TLS, resolver, browser remoto/VM y supervisor de cleanup están disponibles según la prueba elegida.
- [ ] Las credenciales temporales, si aplican, tienen expiración y límites.
- [ ] Los artefactos de evidencia no contienen secretos ni datos personales.
- [ ] Cada caso tiene un criterio de `PASS`, `FAIL`, `LIMITATION`, `NOT EXECUTED` y `SIMULATED` definido antes de ejecutarse.

Si alguna casilla queda sin verificar, la prueba correspondiente permanece `NOT EXECUTED` o `LIMITATION`.

## 7. Impacto en ADR-012

Este documento no añade evidencia experimental ni cierra ADR-012. Mantiene abiertas HTTPS/TLS, DNS rebinding/pinning real, aislamiento OS/network/filesystem, browser remoto o dentro de VM/Sandbox, crash cleanup y Search real. Tampoco selecciona Hyper-V, Windows Sandbox, Firewall, proxy, gateway, browser o provider productivo.
