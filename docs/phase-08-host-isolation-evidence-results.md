# Phase 8 — Browser/host isolation evidence results

## Estado y alcance

Esta subetapa ejecutó un harness experimental para observar los límites del contexto browser local, el almacenamiento, el acceso `file://` desde una página y el cleanup ordenado. No implementa `BrowserProvider`, `WebFetchProvider`, `WebSearchProvider` ni aislamiento productivo del host.

Base de la rama: `origin/main` en `06e305d2d15b94d9a1eff6c6f9d81c95add1976f`.

El harness ejecutado fue `scripts/phase-08-host-isolation-evidence/run.mjs`. Resultado exacto: `10` checks, `7 PASS`, `0 FAIL`, `2 LIMITATION` y `1 NOT EXECUTED`.

## Entorno

- Node.js: `v22.18.0`.
- Playwright: `1.63.0`, `devDependency` experimental ya existente.
- Browser: Chromium `153.0.8010.12` provisionado fuera del repositorio.
- Lanzamiento: `headless: true`, `chromiumSandbox: true`.
- `--no-sandbox`: no utilizado.
- `ignoreHTTPSErrors`: no utilizado.
- Perfil principal: no utilizado.
- `storageState`: no suministrado.
- TLS y trust store: fuera de alcance y sin cambios.

## Directorios temporales

El harness creó y eliminó durante la ejecución:

```text
C:\Users\SILIUS\AppData\Local\Temp\waifu-phase-08-host-isolation-X88ixt
├── workspace
└── outside-workspace
```

Se creó un marcador ficticio únicamente en `outside-workspace/fictional-marker.txt`. La ruta `workspace` representa el directorio permitido del fixture; `outside-workspace` es un directorio hermano dentro del mismo árbol temporal para comprobar una solicitud fuera de ese límite. El árbol completo fue eliminado y la comprobación posterior confirmó que ya no existía.

Chromium se inició con `chromium.launch()` y contextos `browser.newContext()`, sin `launchPersistentContext()` ni `userDataDir`. Por ello no se solicitó un perfil persistente. Playwright no expone mediante este contrato la ruta interna exacta de cualquier almacenamiento temporal administrado por el browser; no se inventa una ruta ni se presenta como aislamiento OS-level.

## Casos ejecutados

| Caso | Resultado | Evidencia |
|---|---|---|
| A. Perfil efímero limpio | `PASS` | Un primer contexto almacenó solo datos ficticios; un segundo contexto nuevo observó cookies y `localStorage` vacíos. |
| B. Filesystem desde la página | `LIMITATION` | Una página HTTP intentó `fetch(file://...)` hacia el marcador fuera de `workspace` y el browser lo rechazó (`accessible=false`). Esto demuestra una restricción browser-origin, no una frontera del SO. |
| C. Ausencia de storage heredado | `PASS` | `storageState()` del segundo contexto tuvo `cookies=[]` y `origins=[]`; no se heredó el marcador ficticio. |
| D. Cleanup normal | `PASS` | Se cerraron fixture/browser/contextos y se eliminó el árbol temporal; la ruta dejó de existir. |
| E. Timeout cleanup | `PASS` | La navegación al endpoint lento excedió `25 ms`, fue cancelada por timeout y después se cerró el contexto. |
| F. Shutdown cleanup | `PASS` | Un contexto de shutdown se cerró explícitamente y el browser terminó ordenadamente. |
| G. Crash cleanup | `NOT EXECUTED` / `LIMITATION` | No existe una reproducción segura sin `child_process`, `spawn`, `exec`, shell o terminación arbitraria de procesos. |

Checks adicionales:

- `PASS`: no se suministró storage state persistente.
- `PASS`: `chromiumSandbox=true` fue solicitado sin `--no-sandbox`.
- `LIMITATION`: la efectividad OS-level del sandbox no queda demostrada por la configuración de lanzamiento.

## Filesystem y frontera del host

El intento controlado desde el contexto HTTP de leer el archivo ficticio mediante `fetch(file://...)` fue inaccesible. Esta es evidencia real de la restricción del origen/browser para ese acceso; no prueba que el proceso browser carezca de permisos OS-level sobre el filesystem ni que un sandbox de Windows sea efectivo contra cualquier escape.

El harness no ejecutó APIs privilegiadas de automatización para abrir el archivo, no usó el perfil principal y no intentó una fuga fuera del árbol temporal. En consecuencia, la propiedad fuerte “el browser no puede acceder arbitrariamente al filesystem del host” permanece `LIMITATION` y requiere un experimento de aislamiento del SO específico para poder afirmarse.

## Credenciales y storage

No se utilizaron credenciales reales. El primer contexto escribió únicamente `fictional-token=not-a-credential` en `localStorage` y `fictional-cookie=fixture-only`; el segundo contexto no los recibió. No se guardó ningún `storageState` ni se cargó un perfil principal.

Esto demuestra aislamiento entre contextos efímeros de esta ejecución, no una garantía sobre cookies, tokens o perfiles externos que un futuro provider pudiera cargar explícitamente.

## Sandbox y límites OS-level

El lanzamiento solicitó `chromiumSandbox=true` y no incluyó `--no-sandbox`. Ese hecho se registra como `PASS` de configuración del harness. La efectividad real del sandbox, su cobertura de filesystem, sus límites en Windows y su resistencia ante escape no se pueden inferir solo de esa opción; quedan `LIMITATION`.

No se modificó la seguridad de Windows, el trust store ni el perfil del usuario.

## Cleanup y crash

El cleanup normal, el cleanup posterior a timeout y el shutdown ordenado fueron ejecutados con resultados `PASS` dentro del alcance del harness. El fixture HTTP, contextos, browser y árbol temporal se cerraron/eliminaron en `finally`.

Crash cleanup queda `NOT EXECUTED`. No se simuló un crash mediante APIs de procesos, shell, PowerShell, `taskkill`, terminación arbitraria ni mecanismos equivalentes. Cleanup normal, timeout y shutdown no se presentan como evidencia de cleanup ante crash.

## Evidencia real frente a limitaciones

Evidencia real obtenida:

- contextos efímeros sin storage heredado;
- ausencia de `storageState` y perfil persistente en el harness;
- rechazo browser-level de la lectura `file://` desde una página HTTP;
- solicitud de sandbox sin flag de desactivación;
- timeout observado y cierre posterior del contexto;
- shutdown ordenado;
- eliminación verificada del árbol temporal.

No demostrado:

- aislamiento OS-level del filesystem;
- efectividad OS-level del sandbox de Chromium en Windows;
- aislamiento de red del host;
- crash cleanup;
- cleanup de un proceso realmente terminado de forma inesperada;
- seguridad de credenciales o perfiles que un provider futuro cargue explícitamente.

## Impacto sobre ADR-012

ADR-012 permanece provisional y en estado `decision-gate`. Esta evidencia mejora la caracterización del browser local, pero no selecciona Playwright como dependencia productiva, no demuestra aislamiento OS-level, no cierra crash cleanup y no decide entre browser local, remoto, proxy, gateway o aislamiento de red.
