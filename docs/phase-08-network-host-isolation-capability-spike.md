# Phase 8 — Network/Host Isolation Capability Spike

## 1. Objetivo

Este spike evalúa qué mecanismos de aislamiento de red y host están disponibles en el Windows actual y cuáles podrían servir para una futura prueba OS-level reproducible de egress, filesystem, DNS/socket, browser y cleanup.

No se habilitaron features, no se crearon VMs, no se modificaron reglas de Firewall, no se cambiaron políticas globales y no se produjo evidencia de seguridad OS-level. El proxy fixture existente no se interpreta como aislamiento del host.

Base de la rama: `origin/main` en `41c65539464ddb5e91117e2dc3217ec0c59e92c7`.

## 2. Entorno

### Sistema y permisos

- Producto observado: Windows 10 Pro.
- Versión/build observado: `2009`, build `26200`, arquitectura `64 bits`.
- Identidad: `SILIUS\SILIUS`.
- Grupo administrativo: no.
- Token elevado: no.
- No se solicitó elevación y no se intentó modificar el sistema.

### Browser experimental

- Playwright: `1.63.0`.
- Chromium: `153.0.8010.12`.
- Ejecutable localizado fuera del repositorio en el caché de Playwright.
- Inicio: `PASS` con `chromiumSandbox=true`.
- Perfil principal: no utilizado.
- Contexto persistente: no utilizado.
- `ignoreHTTPSErrors`: no utilizado.

La disponibilidad del runtime browser solo demuestra que Chromium puede iniciar en esta sesión. No demuestra sandbox efectivo, aislamiento de red, aislamiento de filesystem ni cleanup ante crash.

## 3. Mecanismos evaluados

### 3.1 Windows Sandbox

**Disponibilidad observada:** no confirmada. `WindowsSandbox.exe` no está presente en `System32`. La consulta de la feature opcional `Containers-DisposableClientVM` requirió elevación y no se pudo obtener su estado desde la sesión actual.

**Requisitos y persistencia:** verificar la feature con una sesión administrativa y la configuración de virtualización correspondiente. Habilitar una feature opcional podría requerir cambios persistentes y reinicio; no se hizo.

**Red y filesystem:** Windows Sandbox sería conceptualmente adecuado para una prueba desechable de filesystem y red, pero ninguna de esas propiedades fue ejecutada en este entorno. No se afirma que esté habilitado ni que sus defaults sean suficientes para el contrato de egress.

**Browser y fixture:** no se inició Chromium dentro de Sandbox y no se ejecutó ningún fixture allí.

**Cleanup:** no evaluado. La disponibilidad de la herramienta no demuestra limpieza de archivos, red o procesos tras cierre o error.

**Riesgo y viabilidad futura:** requiere confirmar disponibilidad y controles de red en un entorno administrativo. Podría ser reproducible para una prueba futura si se usa como recurso temporal y se documenta la configuración, pero no es candidato operativo confirmado en esta máquina.

### 3.2 Hyper-V

**Disponibilidad observada:** hay señales de infraestructura instalada: los cmdlets `Get-VM` y `Get-VMSwitch` están disponibles, `vmms`, `vmcompute` y `hns` están en ejecución, y existe el adaptador `vEthernet (Default Switch)` descrito como `Hyper-V Virtual Ethernet Adapter`.

**Límite de permisos:** las consultas de solo lectura `Get-VM` y `Get-VMSwitch` fallaron con “no dispone del permiso necesario”. Por tanto, no se pudo confirmar el inventario de VMs/switches ni administrar una VM con la identidad actual.

**Requisitos y persistencia:** crear o configurar una VM/switch requiere permisos administrativos y recursos de virtualización. Habilitar Hyper-V si no estuviera habilitado podría requerir feature persistente y reinicio; no se realizó esa operación.

**Red:** el adaptador Default Switch demuestra presencia de una interfaz virtual, no una frontera de egress controlada. No se midieron rutas, NAT, bloqueo interno ni conexiones de una VM.

**Filesystem:** una VM separada podría aportar una frontera de filesystem más fuerte que un contexto browser, pero no se creó ni se validó una VM. No se afirma aislamiento.

**Browser y fixture:** Chromium/Playwright funcionan en Windows host, pero no se ejecutaron dentro de Hyper-V.

**Observabilidad y cleanup:** no se observó ninguna conexión real desde una VM ni se comprobó cleanup de VM, disco, switch o sockets.

**Riesgo, complejidad y latencia:** ofrece una frontera potencialmente reproducible, pero añade administración, imágenes, red virtual, tiempo de arranque y cleanup. La compatibilidad con Windows y la obtención de IP/socket real deben medirse en un entorno elevado y dedicado.

**Viabilidad futura:** candidato potencial para el siguiente spike real, sujeto a una máquina/sesión administrativa dedicada. No es una selección arquitectónica.

### 3.3 VM temporal

**Disponibilidad observada:** no se creó ninguna VM temporal. La existencia de cmdlets/servicios Hyper-V no equivale a disponibilidad operativa para esta sesión.

**Requisitos:** requiere un backend de virtualización, imagen reproducible, permisos, almacenamiento temporal y una política de red explícita. Puede requerir cambios persistentes si hay que habilitar componentes.

**Red/filesystem/browser:** no ejecutados. No hay evidencia de egress, DNS/socket, filesystem, Chromium, fixture ni cleanup.

**Viabilidad futura:** es un modelo de experimento, no un mecanismo confirmado. Podría encapsular browser y fixture, capturar conexiones en el boundary inferior y eliminar la VM al terminar, pero requiere un entorno administrativo reproducible.

### 3.4 Windows Firewall con reglas temporales

**Disponibilidad observada:** los servicios `MpsSvc` y `BFE` están en ejecución; los tres perfiles reportados están habilitados. No se enumeraron ni modificaron reglas.

**Requisitos y persistencia:** crear reglas requiere permisos elevados y cambia una política del host, aunque la regla pueda tener duración temporal. No se creó ninguna regla, no se cambió la política y no se comprobó rollback.

**Red:** podría aportar un control de egress por host o interfaz, pero una regla temporal no constituye por sí sola una prueba de aislamiento de filesystem ni garantiza que la regla cubra todos los caminos browser/VM.

**Filesystem y browser:** no aporta aislamiento de filesystem; Chromium no fue ejecutado bajo una regla nueva.

**Observabilidad y cleanup:** no se observaron conexiones mediante una regla experimental. El cleanup de reglas no fue probado porque no se creó ninguna.

**Riesgos y viabilidad futura:** es host-wide y un error puede cortar la conectividad del equipo. Solo debería estudiarse en una máquina desechable o con un procedimiento administrativo reversible, snapshot/rollback y verificación de no impacto. No es apropiado modificarlo en este checkpoint.

### 3.5 Interfaces y virtual switches

**Disponibilidad observada:** se observó `vEthernet (Default Switch)` en estado `Up` y un adaptador Hyper-V virtual. La consulta directa de switches fue rechazada por permisos.

**Interpretación:** una interfaz virtual existente no demuestra un switch aislado, una política de egress ni un camino controlado hacia un fixture. No se cambiaron bindings, rutas, DNS, NAT ni switches.

**Viabilidad futura:** podría servir como parte de una VM temporal, pero solo después de confirmar el switch desde una sesión administrativa y diseñar una red aislada explícita. No es evidencia OS-level actual.

### 3.6 WSL2 como mecanismo adicional observado

`wsl.exe` está disponible y `wsl --status` reportó versión predeterminada `2`, pero `wsl -l -q` no mostró ninguna distribución instalada.

No se instaló una distribución, no se ejecutó Chromium en WSL2 y no se midió egress, filesystem, DNS/socket ni cleanup. WSL2 no se considera automáticamente un aislamiento suficiente: su integración con el host, filesystem montado y networking requieren un experimento específico. Queda como capacidad observada, no como candidato seleccionado.

## 4. Evidencia real

Las comprobaciones de solo lectura demostraron únicamente:

- Windows 10 Pro build `26200`, arquitectura de 64 bits.
- La sesión actual no tiene privilegios administrativos observables.
- Los cmdlets Hyper-V están instalados/disponibles, pero su uso administrativo/consulta fue rechazado por permisos.
- Servicios Hyper-V/HNS y Firewall relevantes están en ejecución.
- Existe un adaptador virtual Hyper-V `vEthernet (Default Switch)`.
- `WindowsSandbox.exe` no está presente en la ruta consultada.
- El estado de las features opcionales de Windows Sandbox, Hyper-V, Virtual Machine Platform y WSL no pudo consultarse por falta de elevación.
- `wsl.exe` existe, reporta versión 2 y no hay distribución instalada.
- Playwright/Chromium puede iniciar fuera de cualquier aislamiento OS-level.

No se demostró:

- una VM o Sandbox ejecutándose;
- una red aislada;
- un bloqueo de egress por Firewall;
- un filesystem aislado del host;
- una conexión DNS/socket desde un entorno aislado;
- Chromium dentro de VM/Sandbox/WSL;
- cleanup de recursos aislados después de cierre o fallo.

## 5. Limitaciones

### No disponible o no confirmado

- Windows Sandbox no está confirmado: ejecutable ausente y feature no consultable sin elevación.
- VM temporal no está confirmada como utilizable por la sesión actual.
- No se confirmó el inventario de Hyper-V/switches por error de permisos.
- WSL2 no tiene distribución instalada.

### No permitido por seguridad en este checkpoint

- Habilitar features opcionales.
- Crear o eliminar VMs/switches.
- Añadir o quitar reglas de Firewall.
- Cambiar rutas, NAT, DNS, bindings o políticas globales.
- Instalar certificados, trust stores, browsers adicionales o imágenes.
- Usar terminación arbitraria de procesos para probar crash cleanup.

### Requiere permisos

- Consultar de forma completa features Hyper-V/Sandbox.
- Administrar VMs y switches.
- Crear reglas temporales de Firewall.
- Preparar un entorno con aislamiento y rollback verificable.

### Requiere reinicio o instalación persistente

- Cualquier habilitación de features de Windows que no estén activas.
- Instalar una distribución WSL2 o una imagen de VM.
- Instalar componentes de virtualización ausentes.

No se ejecutó ninguna de estas acciones.

## 6. Candidato de entorno experimental

Sin seleccionarlo como arquitectura productiva, el candidato más concreto para una siguiente prueba sería una VM Hyper-V temporal en una máquina o sesión administrativa dedicada, con:

1. imagen reproducible y directorio/disco temporal;
2. Chromium/Playwright y fixture egress dentro del entorno aislado;
3. red virtual explícitamente controlada, con captura de hostname, DNS, IP validada, IP efectiva y socket;
4. acceso al filesystem limitado al workspace temporal del experimento;
5. sin perfil principal, credenciales reales ni trust store del host;
6. captura de observabilidad y `internalHits` desde un boundary inferior;
7. cierre ordenado, timeout y eliminación de VM, disco, switches y temporales;
8. un procedimiento separado para crash cleanup, sin inventarlo en esta máquina.

Windows Sandbox podría evaluarse como alternativa si una sesión administrativa confirma la feature y permite una configuración reproducible de red y cleanup. Windows Firewall temporal podría complementar la prueba, pero no debe ser el único aislamiento y no debe tocarse en el host de trabajo.

## 7. Impacto en ADR-012

ADR-012 permanece provisional y en estado `decision-gate`. Este spike añade conocimiento de capacidad del entorno: hay señales de Hyper-V y una interfaz virtual existente, pero la sesión no tiene permisos para administrar o confirmar completamente la infraestructura; Windows Sandbox no está confirmado; WSL2 no tiene distribución.

La disponibilidad de servicios, cmdlets o adaptadores no se convierte en evidencia de aislamiento OS-level. No se selecciona Hyper-V, Windows Sandbox, WSL2, Firewall, browser local/remoto ni una arquitectura de egress. La implementación de `WebSearchProvider`, `WebFetchProvider` y `BrowserProvider` sigue bloqueada hasta obtener evidencia reproducible en un entorno aislado.
