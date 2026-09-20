# Phase 8 — Browser DNS Rebinding Evidence Harness

## Estado y alcance

Este documento define un harness experimental para ejecutar en la Browser VM del laboratorio VirtualBox ya preparado. No implementa `BrowserProvider`, no modifica `src/`, no selecciona arquitectura productiva y no cierra ADR-012.

Base de la rama: `origin/main` en `99bf03721c5006e8dc4470de247470775ac43994`.

La evidencia DNS real del laboratorio ya demostró que `rebind.test` responde inicialmente `1.1.1.1` y después `10.20.0.1`, y que el boundary `nftables` bloquea el destino privado. Esta etapa añade la observación de navegación real de Chromium y su correlación posterior con los artefactos del Gateway. No convierte esa evidencia en DNS pinning productivo.

El harness no se ejecuta automáticamente desde el host de desarrollo. La ejecución válida debe ocurrir dentro de la Browser VM, con el DNS del sistema apuntando a `10.20.0.1` y el tráfico usando la Gateway como ruta de salida.

## 1. Topología requerida

```text
Browser VM / Windows 11 Pro 25H2
10.20.0.10/24
DNS: 10.20.0.1
Gateway: 10.20.0.1
        |
        | WA-LAB-INT
        v
Gateway VM / Ubuntu Server 24.04.5 LTS
enp0s8 = 10.20.0.1/24
enp0s3 = 10.0.2.15/24 vía VirtualBox NAT
        |
        v
VirtualBox NAT / Internet público
```

La Browser VM no debe tener un adaptador NAT directo que permita bypass de la Gateway. La política `nftables` de la Gateway sigue siendo la autoridad final del egress; Playwright, Chromium, el fixture de página y este harness solo observan.

## 2. Prerrequisitos fuera del harness

Estas acciones pertenecen a la preparación manual del laboratorio y no las realiza el script:

1. Confirmar que las dos VMs y la red `WA-LAB-INT` están encendidas según la topología aprobada.
2. Confirmar que el DNS experimental está escuchando en `10.20.0.1:53` y que su contador para `rebind.test` puede reiniciarse o identificarse.
3. Confirmar que la Browser VM usa `10.20.0.1` como DNS efectivo. La comprobación debe hacerse antes de la prueba sin consumir consultas de `rebind.test`; la evidencia final debe proceder del log del DNS del Gateway.
4. Confirmar que Secure DNS/DoH del navegador no desvía las consultas fuera de la Gateway. Si no puede demostrarse que Chromium usa el DNS del laboratorio, clasificar la ejecución como `NOT EXECUTED`.
5. Confirmar que la ruta por defecto de la Browser VM atraviesa `10.20.0.1` y que no existe una ruta alternativa directa a Internet.
6. Limpiar o aislar el contador DNS de la prueba. No ejecutar `nslookup rebind.test` entre el reset del contador y el harness, porque consume una respuesta de la secuencia.
7. Confirmar la política temporal `nftables` ya preparada y registrar el estado de sus contadores antes de iniciar.

No usar `--host-resolver-rules`, `/etc/hosts`, `hosts` de Windows, cambios en el router ni modificaciones del DNS global para simular el rebinding. El nombre debe resolverse realmente contra `10.20.0.1`.

## 3. Harness

Ruta:

```text
scripts/phase-08-browser-dns-rebinding-evidence/run.mjs
```

Utiliza el Playwright ya existente en la rama y no añade dependencias. El script:

- inicia un fixture HTTP de control solamente en `127.0.0.1` de la Browser VM;
- lanza Chromium con `chromiumSandbox=true`, sin `--no-sandbox`;
- no configura proxy Playwright ni reglas de resolución: el tráfico usa la red de la VM y la Gateway;
- abre dos procesos Chromium separados para reducir la confusión entre caché DNS, conexiones persistentes y la segunda consulta;
- carga primero el fixture de control y después navega a `http://rebind.test/`;
- registra timestamps, hostname, puerto, path, método, tipo de recurso, respuesta y errores de red, sin cuerpos, cookies, headers ni credenciales;
- cierra cada browser/contexto en `finally`;
- puede validar artefactos JSON exportados desde el DNS y `nftables` del Gateway;
- valida realmente `source`, hostname, secuencia, tipo, IP y timestamps ISO del DNS; un campo `status: PASS` preexistente no sirve como bypass;
- valida realmente la caída de `nftables`, los contadores diferenciales antes/después, `internalHits` y `observedAt`; ese `observedAt` es el momento de observación/colección del artefacto, no el timestamp exacto del socket;
- valida una referencia UTC explícita entre Gateway y Browser VM; sin ella la comparación cross-VM queda limitada y no puede producir `PASS` consolidado;
- correlaciona temporalmente DNS sequence 1 → primera request Chromium → DNS sequence 2 → segunda request Chromium → observación del drop inferior;
- emite un informe JSON por stdout y, opcionalmente, en una ruta indicada por el operador.

La relanzada de Chromium no demuestra por sí sola que se haya realizado una nueva consulta DNS. Solo permite observar el comportamiento sin reutilizar deliberadamente el mismo proceso. La prueba de que hubo dos resoluciones debe venir del log del DNS del Gateway.

### Ejecución

Desde la raíz del repositorio en la Browser VM:

```text
node scripts/phase-08-browser-dns-rebinding-evidence/run.mjs `
  --url http://rebind.test/ `
  --dns-evidence C:\Temp\phase-08-dns-evidence.json `
  --egress-evidence C:\Temp\phase-08-egress-evidence.json `
  --clock-evidence C:\Temp\phase-08-clock-reference.json `
  --report C:\Temp\phase-08-browser-dns-rebinding-report.json
```

La continuación de línea anterior corresponde a PowerShell. También puede ejecutarse en una sola línea:

```text
node scripts/phase-08-browser-dns-rebinding-evidence/run.mjs --url http://rebind.test/ --dns-evidence C:\Temp\phase-08-dns-evidence.json --egress-evidence C:\Temp\phase-08-egress-evidence.json --clock-evidence C:\Temp\phase-08-clock-reference.json --report C:\Temp\phase-08-browser-dns-rebinding-report.json
```

El harness no crea esos artefactos del Gateway ni la referencia de reloj. Deben ser exportados por el procedimiento del laboratorio, revisados por el operador y copiados a la Browser VM sin secretos. Si no se proporcionan, la navegación se puede observar, pero el resultado consolidado queda `NOT EXECUTED`; la referencia de reloj es obligatoria para `PASS`, aunque DNS y egress estén presentes.

Exit codes:

- `0`: correlación completa `PASS`.
- `1`: evidencia proporcionada o resultado observado contradice la política (`FAIL`).
- `2`: evidencia ausente, limitada o capacidad no ejecutada (`LIMITATION`/`NOT EXECUTED`).

## 4. Formato de evidencia del Gateway

El formato siguiente es un contrato de intercambio del experimento, no una API productiva. Los valores son ejemplos de estructura, no resultados de esta rama; deben reemplazarse por observaciones reales.

### DNS

`phase-08-dns-evidence.json` debe contener al menos:

```json
{
  "source": "gateway-dns",
  "hostname": "rebind.test",
  "answers": [
    { "sequence": 1, "type": "A", "address": "1.1.1.1", "observedAt": "<timestamp-ISO-real>" },
    { "sequence": 2, "type": "A", "address": "10.20.0.1", "observedAt": "<timestamp-ISO-real-posterior>" }
  ]
}
```

El harness exige que las dos respuestas A observadas sean exactamente `1.1.1.1` y `10.20.0.1`, en ese orden, con timestamps reales. Las consultas AAAA sin datos pueden incluirse, pero no sustituyen las respuestas A.

### Egress inferior

`phase-08-egress-evidence.json` debe contener al menos:

```json
{
  "source": "gateway-nftables",
  "sourceAddress": "10.20.0.10",
  "destinationAddress": "10.20.0.1",
  "action": "drop",
  "packetsBefore": 100,
  "packetsAfter": 112,
  "packetsDelta": 12,
  "bytesBefore": 7000,
  "bytesAfter": 7788,
  "bytesDelta": 788,
  "internalHits": 0,
  "observedAt": "<timestamp-ISO-real-posterior-a-la-segunda-request>"
}
```

Los números del bloque son únicamente la forma del contrato; deben sustituirse por observaciones reales. `packetsBefore` y `packetsAfter` deben capturarse alrededor de esta ejecución, y `packetsDelta` debe ser exactamente `packetsAfter - packetsBefore` y mayor que cero. Lo mismo aplica a `bytesDelta`. No se debe reutilizar un contador acumulado de una ejecución anterior como si fuera evidencia de esta prueba. La evidencia debe demostrar tráfico adicional durante la ventana experimental y no identificar por sí sola un socket TCP específico.

La evidencia de `nftables` demuestra el bloqueo en la frontera de red del laboratorio. `observedAt` indica cuándo se observó o recopiló el artefacto y no pretende ser el instante exacto del paquete ni del socket. La evidencia no expone necesariamente el socket interno de Chromium; la diferencia entre request browser, IP efectiva del paquete y socket debe permanecer explícita en el informe.

### Referencia de reloj entre VMs

El DNS y `nftables` se ejecutan en la Gateway Ubuntu, mientras que `request.timing()` se captura en la Browser VM Windows. Sus timestamps absolutos pertenecen a relojes distintos. Antes de cada prueba, el operador debe capturar una referencia UTC en ambas VMs y exportarla junto con el momento de observación:

```json
{
  "source": "lab-clock-reference",
  "gatewayUtc": "<timestamp-ISO-real>",
  "browserUtc": "<timestamp-ISO-real>",
  "observedAt": "<timestamp-ISO-real>",
  "maxOffsetMs": 0
}
```

El `0` es únicamente el tipo/forma del contrato y debe sustituirse por el entero medido por el operador; el harness no inventa ni calcula `maxOffsetMs`. Si no se proporciona una referencia suficiente, el resultado consolidado queda `LIMITATION` o `NOT EXECUTED`; no puede recibir `PASS` únicamente por comparar timestamps de ambas VMs.

## 5. Secuencia experimental

### A. Preparación

- [ ] Browser VM: `10.20.0.10/24`, Gateway `10.20.0.1`, DNS `10.20.0.1`.
- [ ] Sin NAT directo ni ruta alternativa desde Browser VM.
- [ ] Chromium/Playwright ya provisionados; no instalar desde el harness.
- [ ] Perfil principal y storage state no utilizados.
- [ ] Contador DNS y contadores `nftables` registrados/resetados por el operador.
- [ ] Referencia UTC capturada en Gateway y Browser VM, con `maxOffsetMs` medido y exportado.
- [ ] Artefactos de evidencia del Gateway identificados y sin secretos.

### B. Primer intento browser

El primer proceso Chromium navega al fixture de control y después a `rebind.test`. El DNS del laboratorio debe registrar la respuesta A pública `1.1.1.1`. El resultado de navegación puede ser una respuesta, un error de red o un timeout dependiendo del servicio público alcanzado; esa observación no se interpreta como prueba de éxito HTTP.

### C. Cambio DNS

El DNS experimental debe entregar la respuesta A privada `10.20.0.1` en la consulta siguiente. El segundo proceso Chromium navega al mismo hostname. El harness registra si Chromium emitió la request y si terminó con response, `requestfailed` o timeout.

### D. Boundary inferior

El procedimiento debe seguir este orden: (A) registrar el contador `nftables` antes de ejecutar el segundo Chromium; (B) ejecutar el segundo Chromium; (C) registrar el contador después; (D) exportar `before`, `after` y el delta calculado. El Gateway debe demostrar que el tráfico adicional hacia `10.20.0.1` fue bloqueado, con `packetsDelta > 0` e `internalHits=0`. La observación del browser se correlaciona por timestamps y referencia de reloj; no se asume que un error de Playwright por sí solo prueba el destino privado.

### E. Revisión de caché y conexiones

- [ ] El DNS registra dos consultas A para `rebind.test` en la secuencia esperada.
- [ ] Las consultas ocurren en el intervalo de los dos intentos browser.
- [ ] El informe conserva los timestamps de consultas y navegaciones.
- [ ] Si solo existe una consulta, o la segunda navegación no llega al DNS por caché/reutilización, el criterio de rebinding browser queda `LIMITATION` o `NOT EXECUTED`, no `PASS`.
- [ ] Si Chromium reutiliza una conexión pública y nunca intenta el destino privado, se registra como observación de comportamiento y limitación del experimento; no se inventa un fallo del boundary.

Para clasificar `PASS` consolidado, deben cumplirse simultáneamente estas ventanas temporales:

1. DNS sequence 1 (`1.1.1.1`) es anterior o igual al inicio y al fin del lookup de la primera request, con la tolerancia cross-VM aplicada.
2. La primera request target ocurre antes de DNS sequence 2 (`10.20.0.1`), con la tolerancia aplicada.
3. DNS sequence 2 ocurre después de que termina la primera request y antes de que inicie la segunda request, con la tolerancia aplicada.
4. DNS sequence 2 queda asociado a la ventana `domainLookupStart`/`domainLookupEnd` de la segunda request, ampliada por la tolerancia.
5. Existe una referencia de reloj suficiente entre Gateway y Browser VM.
6. El delta `nftables` es mayor que cero y su `observedAt` no es anterior al final del lookup del segundo request, con la tolerancia aplicada.
7. `internalHits=0`.
8. Existe al menos una request target en cada lanzamiento de Chromium.
9. Ninguna condición está clasificada como `FAIL`.

Dos lanzamientos de Chromium no garantizan dos consultas DNS. Si Chromium cachea DNS, reutiliza una conexión o no vuelve a resolver, el resultado es `LIMITATION` o `NOT EXECUTED`, nunca `PASS` consolidado.

El evento `page.on('request')` solo registra que el navegador emitió una solicitud; no demuestra cuándo ocurrió el DNS. El harness conserva `request.timing()` y usa `startTime` como tiempo absoluto en milisegundos desde la época; los demás campos de timing son offsets relativos a `startTime`, que se convierten a timestamps ISO absolutos para comparar las ventanas `domainLookupStart`/`domainLookupEnd`. También conserva `responseEnd` para demostrar que la primera request terminó antes de DNS sequence 2. Si el navegador devuelve `-1` o no expone una ventana de lookup o un fin de request utilizable, el resultado es `LIMITATION`/`NOT EXECUTED`, no `PASS`.

`maxOffsetMs` es una tolerancia proporcionada por el operador, no calculada por el harness. Se aplica únicamente a comparaciones entre timestamps de Gateway (DNS y `nftables`) y timestamps de Browser VM: DNS1 frente al inicio/fin del lookup 1, request 1 frente a DNS2, fin de request 1 frente a DNS2, DNS2 frente a request 2, DNS2 frente a la ventana del lookup 2 y `egressObservedAt` frente al fin del lookup 2. Las relaciones internas del mismo artefacto browser, como `domainLookupStart <= domainLookupEnd` y `requestAt <= responseEnd`, no reciben tolerancia. Una evidencia que permanece fuera de la ventana incluso tras aplicar `maxOffsetMs` es `FAIL`; no se ajusta ni inventa el valor.

En particular, DNS1 es válido únicamente si `firstLookup.start - maxOffsetMs <= firstDnsMs <= firstLookup.end + maxOffsetMs`; no se usa el inicio del lookup como límite superior. DNS2 usa la misma ventana simétrica respecto al lookup 2. Para las relaciones de orden, request 1 debe preceder a DNS2, DNS2 debe seguir al fin de request 1 y preceder a request 2, y `egressObservedAt` debe seguir al fin del lookup 2, siempre con la tolerancia simétrica indicada.

## 6. Matriz de resultados

| Caso | `PASS` | `FAIL` | `LIMITATION` | `NOT EXECUTED` |
|---|---|---|---|---|
| Primera resolución | El Gateway registra `rebind.test` → `1.1.1.1` y el browser emite la request | La respuesta real no coincide o el tráfico contradice la topología | El DNS se observa pero no puede correlacionarse con el browser | DNS de laboratorio no disponible |
| Segunda resolución | El Gateway registra la segunda A → `10.20.0.1` y el segundo browser intento existe | Respuesta DNS inesperada o intento a destino no autorizado permitido | Chromium cachea/reutiliza y no hay segunda resolución demostrable | No se ejecutó el segundo intento |
| Navegación real | Chromium emitió la navegación con timestamps y resultado/error registrado | El harness no puede iniciar o el destino viola la política | Hay request, pero no se puede distinguir conexión efectiva | Browser/fixture no disponible |
| Bloqueo inferior | `nftables` registra drop al destino privado, `internalHits=0` y timestamps compatibles | El paquete llega al destino privado o no se bloquea | Solo se observa timeout browser sin evidencia inferior suficiente | Gateway/artefacto no disponible |
| IP efectiva/socket | El boundary observa destino/puerto/conexión y se correlaciona con la segunda resolución | El destino efectivo contradice la política o conecta internamente | Playwright no expone socket; solo hay evidencia parcial de paquetes | No hubo conexión observable |
| Resultado consolidado | Browser + secuencia DNS ordenada + clock reference + delta positivo de egress están correlacionados con tolerancia explícita | Alguna evidencia contradice el bloqueo o la línea temporal | Falta correlación completa, reloj suficiente o Chromium no vuelve a resolver | Faltan artefactos o el laboratorio no está disponible |

Un `PASS` consolidado demuestra únicamente un rebinding real controlado y bloqueado por el boundary del laboratorio para esta ejecución. No demuestra DNS pinning, protección de un `BrowserProvider` futuro, HTTPS/TLS, Service Worker, WebSocket ni seguridad productiva.

DNS rebinding real tampoco equivale automáticamente a DNS pinning: demuestra que el resolver del laboratorio entregó respuestas distintas y que el boundary bloqueó el destino privado observado; no demuestra que Chromium o un provider valide y fije la IP justo antes del socket.

## 7. Limitaciones explícitas

- Playwright no expone directamente la IP DNS ni el socket TCP elegido por Chromium.
- La evidencia de IP efectiva y bloqueo debe provenir del Gateway, no de una inferencia a partir de `page.goto()`.
- El `observedAt` de `nftables` es el tiempo de observación/colección del artefacto. No debe presentarse como el timestamp exacto del socket o del paquete.
- El informe conserva `firstRequestAt`, `firstRequestEnd` y `secondRequestAt` para hacer auditable el orden request 1 → DNS2 → request 2.
- Dos lanzamientos de Chromium reducen la reutilización deliberada de conexión, pero no son una garantía de que el browser consulte DNS dos veces.
- La secuencia de DNS del laboratorio debe correlacionarse por timestamps; una respuesta `nslookup` aislada no demuestra qué resolución usó Chromium.
- La prueba usa HTTP controlado y no cubre HTTPS/TLS.
- No cubre browser remoto, crash cleanup, Search providers, aislamiento OS-level adicional ni integración productiva.
- La Gateway `nftables` es la autoridad de seguridad de esta prueba; Playwright route/interception no se usa como boundary.
- El destino privado utilizado es `10.20.0.1`, la propia Gateway del laboratorio. No representa todos los rangos privados/reservados.
- Un `PASS` de este harness no cambia ADR-012 a decisión final.

## 8. Pruebas locales del clasificador

Las pruebas deterministas no ejecutan Chromium ni acceden al laboratorio:

```text
node scripts/phase-08-browser-dns-rebinding-evidence/classifier.test.mjs
```

Cubren:

- correlación temporal correcta (`PASS`);
- DNS invertido (`FAIL`);
- segunda navegación sin segunda request demostrable (`LIMITATION`);
- `internalHits > 0` (`FAIL`);
- artefacto preclasificado como `PASS` sin campos reales (`FAIL`);
- artefactos ausentes (`NOT EXECUTED`);
- delta de paquetes no positivo o inconsistente (`FAIL`);
- delta de bytes inconsistente (`FAIL`);
- referencia de reloj ausente (`LIMITATION`);
- referencia de reloj inválida (`FAIL`);
- DNS2 antes de terminar la primera request (`FAIL`);
- segunda request iniciada antes de DNS2 (`FAIL`);
- tolerancia `maxOffsetMs` insuficiente para la línea temporal (`FAIL`);
- timing DNS no disponible en el segundo request (`LIMITATION`);
- dos requests sin una segunda ventana de lookup demostrable (`LIMITATION`);
- segunda respuesta DNS fuera de la ventana de lookup del segundo request (`FAIL`);
- observación de egress anterior a la ventana relevante del segundo request (`FAIL`).

Estas pruebas no constituyen evidencia de DNS rebinding ni de seguridad de red; solo protegen la clasificación del informe.

## 9. Seguridad y limpieza

- No usar perfil principal, cookies, storage state ni credenciales reales.
- No imprimir cuerpos, headers, tokens, cookies ni query strings innecesarios.
- No usar `--host-resolver-rules`, hosts file, `/etc/hosts`, shell, `child_process`, `spawn`, `exec` ni PowerShell desde el harness.
- No modificar VirtualBox, rutas, DNS global, Firewall o trust store desde el script.
- Cerrar browser, contextos y fixture en `finally`.
- Eliminar los artefactos temporales del Browser VM tras conservar el reporte redacted.
- Restaurar los contadores/políticas temporales del laboratorio por el procedimiento de la Gateway; el harness no administra nftables.

## 10. Impacto en ADR-012

El harness prepara evidencia de navegación real sobre el rebinding ya demostrado en el laboratorio. Solo puede aportar evidencia `PASS` acotada de `DNS real → intento browser → delta de tráfico bloqueado` si además existe una referencia UTC suficiente entre las VMs, el delta de `nftables` es positivo y posterior al segundo lookup, e `internalHits=0`. Si falta el reloj, Chromium cachea DNS o no intenta la segunda conexión, el resultado queda `LIMITATION`/`NOT EXECUTED` según la evidencia disponible.

En ningún caso se debe escribir que el experimento demuestra DNS pinning productivo, una política SSRF completa, un `BrowserProvider` o el cierre de ADR-012.
