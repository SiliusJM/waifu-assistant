# Phase 8 — HTTPS/TLS evidence results

## Estado

Esta subetapa evaluó si el entorno actual permite obtener evidencia TLS reproducible sin debilitar la validación del navegador, modificar Windows ni introducir una dependencia productiva. El resultado es una limitación del fixture, no un resultado positivo o negativo del boundary productivo.

Base de la rama: `origin/main` en `6c8157eee773866542cadd00c4d98c326973fc25`.

## Entorno

- Node.js: `v22.18.0`.
- Playwright instalado: `1.63.0`, únicamente como `devDependency` experimental ya existente.
- Chromium local: Playwright localiza `chrome.exe` fuera del repositorio en `C:\Users\SILIUS\AppData\Local\ms-playwright\chromium-1243\chrome-win64\chrome.exe`.
- Inicio de Chromium: `PASS` con un contexto efímero y cleanup normal.
- Perfil principal: no utilizado.
- `ignoreHTTPSErrors`: no utilizado.
- Trust store de Windows: no modificado.
- APIs de procesos, shell y OpenSSL: no utilizadas.

## Viabilidad del certificado

Se revisaron las dependencias y los artefactos existentes del proyecto. No existe una librería de emisión X.509 ni un certificado/llave de fixture. Node.js puede servir TLS cuando recibe material `key` y `cert`/`pfx`, y `node:crypto` puede generar claves y leer material X.509, pero no proporciona por sí solo un emisor X.509 público para crear de forma reproducible un certificado de servidor confiable para Chromium.

Por tanto, no se generó certificado, clave privada ni artefacto temporal. No se añadió una `devDependency`, no se modificaron `package.json` ni lockfiles y no se introdujo un bypass de confianza. La causa de la limitación es la ausencia de un mecanismo de emisión y confianza efímero compatible con Chromium dentro de las restricciones aprobadas.

## Casos

| Caso | Estado | IP validada | IP efectiva | Socket observado | Estado TLS | internalHits | Observación |
|---|---|---|---|---|---|---:|---|
| HTTPS público → HTTPS público/controlado | `NOT EXECUTED` / `LIMITATION` | — | — | — | No hubo handshake | — | No existe certificado efímero confiable para el fixture. |
| HTTPS → HTTP | `NOT EXECUTED` / `LIMITATION` | — | — | — | No hubo navegación HTTPS | — | Sin origen HTTPS no puede evaluarse de forma válida el downgrade. |
| HTTPS → destino interno | `NOT EXECUTED` / `LIMITATION` | — | — | — | No hubo handshake | — | No se afirma bloqueo TLS ni `internalHits=0` para este caso. |
| CONNECT/WebSocket sobre TLS | `NOT EXECUTED` / `LIMITATION` | — | — | — | No hubo handshake | — | El fixture TLS necesario no está disponible. |

No se observaron sockets ni `internalHits` nuevos en esta subetapa porque ningún fixture HTTPS fue iniciado. La evidencia real de DNS/socket local de la etapa anterior permanece separada y no se convierte en evidencia TLS.

## Seguridad y cleanup

- No se usó `ignoreHTTPSErrors` ni ningún mecanismo equivalente.
- No se modificó el almacén de confianza del sistema.
- No se usó el perfil principal del navegador.
- No se almacenaron credenciales ni secretos.
- No se creó material TLS temporal; por ello no quedaron certificados, claves, servidores ni sockets que limpiar.
- El navegador de disponibilidad experimental se inició en contexto efímero y se cerró correctamente; esto no demuestra crash cleanup del boundary TLS.

## Evidencia real frente a simulación

Esta subetapa no produce un `PASS` TLS. La disponibilidad de Chromium y el cleanup normal del contexto son evidencia real de runtime, pero no de HTTPS, certificados, redirects TLS, egress TLS ni WebSocket TLS. La simulación previa de DNS rebinding/socket pinning continúa siendo `SIMULATED`/`NOT EXECUTED`; no se presenta como pinning real.

## Limitaciones y siguiente evidencia necesaria

Para cerrar estos casos se necesita un fixture controlado que pueda emitir un certificado efímero confiable para el hostname usado por Chromium sin modificar permanentemente el sistema, desactivar validación TLS, invocar APIs de procesos o guardar claves en el repositorio. Cuando exista ese mecanismo aprobado, deberán repetirse individualmente los cuatro casos y observar hostname solicitado, IP validada, IP efectiva, socket, estado TLS, redirects, subrecursos, WebSocket e `internalHits`.

## Impacto sobre ADR-012

ADR-012 permanece provisional y en estado `decision-gate`. HTTPS público→HTTPS, HTTPS→HTTP, HTTPS→interno y CONNECT/WebSocket sobre TLS siguen `NOT EXECUTED`; no se selecciona una arquitectura productiva ni se cierra el gate.
