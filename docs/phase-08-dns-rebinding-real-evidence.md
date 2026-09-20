# Phase 8 — DNS Rebinding Real Evidence

## Estado

- Rama: `phase/08-dns-rebinding-real-evidence`
- Base: `main` en `26a85a158d22ffd24b853195c13178c23b5a1234`
- Fecha de ejecución: 2026-09-20
- Objetivo: sustituir la evidencia histórica `SIMULATED` de DNS rebinding por un experimento real y reproducible dentro de un laboratorio VirtualBox.
- ADR-012 permanece provisional / `decision-gate`.
- No se implementa todavía ningún `BrowserProvider`, provider de egress productivo ni pinning productivo.

## Topología experimental

```
Browser VM
Windows 11 Pro 25H2
10.20.0.10/24
      |
      | WA-LAB-INT
      v
Gateway VM
Ubuntu Server 24.04.5 LTS
enp0s8 = 10.20.0.1/24
enp0s3 = 10.0.2.15/24 (VirtualBox NAT)
      |
      v
Internet
```

La Browser VM no tiene adaptador NAT propio durante esta prueba. La salida pública atraviesa la Gateway.

## Egress boundary previo

Antes de ejecutar la prueba DNS se había establecido un boundary temporal con:

- `enp0s8 -> enp0s3`: salida de `10.20.0.0/24` permitida.
- respuestas `established,related` de `enp0s3 -> enp0s8` permitidas.
- política `forward`: `drop`.
- destinos IPv4 privados/reservados bloqueados mediante un conjunto `blocked_ipv4`.
- NAT `masquerade` de `10.20.0.0/24` hacia `enp0s3`.
- tráfico de la Browser hacia la propia Gateway por `enp0s8` bloqueado en `input`, excepto DNS UDP/TCP 53 para el laboratorio.

La evidencia previa mostró que la Browser podía acceder a Internet público y que los destinos privados/administrativos quedaban bloqueados.

## DNS experimental

Se ejecutó un servidor DNS controlado en la Gateway:

- escucha en `10.20.0.1:53`;
- dominio de prueba: `rebind.test`;
- consultas A alternadas de forma determinista:
  - secuencia impar -> `1.1.1.1`;
  - secuencia par -> `10.20.0.1`;
- consultas AAAA para `rebind.test`: sin datos;
- otros nombres: reenviados al upstream `1.1.1.1:53`.

El servidor registró las consultas recibidas desde `10.20.0.10` y la respuesta entregada.

## Evidencia ejecutada

### 1. Primera resolución

Desde la Browser VM:

```
nslookup rebind.test 10.20.0.1
```

Resultado observado:

```
Name:    rebind.test
Address: 1.1.1.1
```

Clasificación: `PASS`.

### 2. Segunda resolución

Se repitió:

```
nslookup rebind.test 10.20.0.1
```

Resultado observado:

```
Name:    rebind.test
Address: 10.20.0.1
```

El servidor DNS registró explícitamente:

```
rebind.test. A -> 1.1.1.1 (sequence=1)
rebind.test. A -> 10.20.0.1 (sequence=2)
```

Clasificación: `PASS`.

Esto constituye DNS rebinding controlado real dentro del laboratorio: el nombre cambia efectivamente de una dirección pública a una dirección privada en consultas DNS reales.

### 3. Intento de conexión al destino privado

Desde la Browser VM:

```
Test-NetConnection 10.20.0.1 -Port 22
```

Resultado:

```
TcpTestSucceeded : False
```

El intento fue alcanzado por el boundary de la Gateway y rechazado.

Clasificación: `PASS` para el bloqueo del destino privado.

### 4. Evidencia en la frontera inferior

La Gateway mostró:

```
chain input {
    ...
    iifname "enp0s8" counter packets 12 bytes 788 drop
}
```

Esto demuestra que el tráfico de la Browser llegó a la Gateway y fue descartado en la cadena `input`.

No se trata únicamente de un `timeout` interpretado desde Windows: existe evidencia observable en el boundary inferior.

Clasificación: `PASS`.

## Evidencia de conectividad pública

Como control de que el boundary no bloquea todo el tráfico:

- `Test-NetConnection 1.1.1.1 -Port 443`: `True`.
- `ping 1.1.1.1`: 4/4 respuestas.
- contadores `forward` observados después de la prueba pública:
  - salida Browser -> Internet: 23 paquetes / 1176 bytes;
  - retorno Internet -> Browser: 20 paquetes / 1149 bytes.

Clasificación: `PASS` para conectividad pública controlada.

## Clasificación consolidada

| Caso | Resultado |
|---|---|
| Resolución `rebind.test` -> `1.1.1.1` | `PASS` |
| Resolución posterior `rebind.test` -> `10.20.0.1` | `PASS` |
| Cambio real de respuesta DNS | `PASS` |
| Intento de socket `10.20.0.1:22` | `PASS` bloqueado |
| Evidencia del bloqueo en `nftables` | `PASS` |
| Internet público a través de Gateway | `PASS` |
| DNS pinning del BrowserProvider | `NOT EXECUTED` |
| DNS rebinding público/productivo | `NOT EXECUTED` |
| Validación IP efectiva justo antes del socket dentro de BrowserProvider | `NOT EXECUTED` |

## Límites

Esta prueba demuestra un rebinding DNS real y controlado dentro del laboratorio VirtualBox, pero no demuestra todavía:

1. que Playwright/Chromium o un futuro `BrowserProvider` revalide la IP efectiva justo antes de abrir el socket;
2. que el runtime productivo detecte y bloquee el cambio DNS por sí mismo;
3. DNS rebinding en Internet público;
4. pinning productivo;
5. comportamiento HTTPS/TLS frente al cambio de destino;
6. Service Worker/Fetch/XHR/WebSocket bajo este dominio de rebinding.

El destino privado utilizado para la prueba es la propia Gateway (`10.20.0.1`). Esto es una prueba controlada de la propiedad de bloqueo, no una representación de todos los rangos privados posibles.

## Repetibilidad

La prueba se ejecutó con VMs dedicadas y redes VirtualBox separadas:

- Browser: `10.20.0.10/24`
- Gateway: `10.20.0.1/24` en `WA-LAB-INT`
- Gateway Internet: `10.0.2.15/24` vía NAT de VirtualBox

El DNS experimental mantiene un contador de secuencia, por lo que consultas sucesivas al mismo nombre producen alternancia determinista entre la IP pública y la IP privada.

## Siguiente paso

La siguiente etapa debe integrar esta clase de DNS rebinding con un cliente de navegador real dentro del entorno aislado, manteniendo el boundary de egress inferior y observando:

```
DNS -> IP validada -> navegación -> IP efectiva -> socket -> decisión del boundary
```

La implementación productiva y el cierre de ADR-012 permanecen fuera de alcance hasta completar esa evidencia.
