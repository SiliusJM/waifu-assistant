# Phase 8 — Real Browser DNS Rebinding Execution Evidence — 2026-09-21

## Status

- Execution date: 2026-09-21
- Experimental environment: VirtualBox lab
- Browser VM: Windows 11 Pro 25H2
- Browser VM address: `10.20.0.10/24`
- Gateway VM: Ubuntu Server 24.04.5 LTS
- Gateway laboratory address: `10.20.0.1/24` on `WA-LAB-INT`
- Target hostname: `rebind.test`
- Consolidated result of this execution: `LIMITATION`
- ADR-012: remains provisional / `decision-gate`
- No productive `BrowserProvider` implementation was added.
- No production egress architecture was selected by this evidence.
- No PR or merge is created by this documentation change.

This document records the real laboratory execution performed on 2026-09-21. It intentionally preserves the limitation instead of converting partial evidence into a `PASS`.

## 1. Laboratory state used for the execution

The approved topology was:

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
enp0s3 = 10.0.2.15/24 via VirtualBox NAT
        |
        v
Internet
```

The Browser VM was using the Gateway for the laboratory DNS and network path. The temporary Gateway `nftables` policy was active, including the input drop rule used to observe traffic from the Browser VM to the Gateway.

The experimental DNS service was running from:

```text
/opt/wa-dns-lab.py
```

For `rebind.test`, the service alternates A answers deterministically:

- sequence 1 -> `1.1.1.1`
- sequence 2 -> `10.20.0.1`

The DNS service logs each query with an ISO timestamp, client address, hostname, answer and sequence number.

## 2. Cross-VM clock reference used by the run

A fresh clock reference was captured earlier in the same laboratory session and was already present in the Browser VM at; it was not captured immediately before the browser harness run:

```text
C:\Temp\phase-08-clock-reference.json
```

Observed contents:

```json
{
  "source": "lab-clock-reference",
  "gatewayUtc": "2026-09-21T19:49:23.613Z",
  "browserUtc": "2026-09-21T19:49:23.661Z",
  "observedAt": "2026-09-21T19:49:23.989Z",
  "maxOffsetMs": 457
}
```

This reference was accepted by the harness as:

```text
clockEvidence.status = PASS
reason = CROSS_VM_CLOCK_REFERENCE_CAPTURED
maxOffsetMs = 457
```

The previous invalid one-hour-offset reference was not reused.

## 3. Runtime provisioned in the Browser VM

Before the run, the clean Browser VM was provisioned with:

- Node.js `v24.19.0`
- Git
- repository `SiliusJM/waifu-assistant`
- `npm ci`: 100 packages added, 0 vulnerabilities
- Playwright Chromium installed:
  - Chromium `153.0.8010.12`
  - Playwright package/runtime `1.63.0` according to the project configuration/runtime used by the harness
- The harness was executed from the cloned repository without modifying `src/`.

## 4. Browser harness execution

The real Browser VM command was:

```powershell
& "$env:ProgramFiles\nodejs\node.exe" scripts\phase-08-browser-dns-rebinding-evidence\run.mjs --url http://rebind.test/ --clock-evidence C:\Temp\phase-08-clock-reference.json --report C:\Temp\phase-08-browser-dns-rebinding-report.json
```

The harness reported:

```text
status = NOT EXECUTED
browser.launches = 2
processRelaunchBetweenAttempts = true
chromiumSandboxRequested = true
hostResolverRulesUsed = false
hostsFileUsed = false
```

The `NOT EXECUTED` classification from this invocation is not evidence that Chromium failed to run. It was caused by the absence of the Gateway DNS and egress JSON artifacts in the harness inputs at invocation time. The browser-side observations were nevertheless produced and are recorded below.

## 5. Chromium attempt 1 — initial public resolution

Chromium emitted a real request for:

```text
http://rebind.test/
```

Observed request:

```text
requestAt = 2026-09-21T20:37:44.983Z
hostname = rebind.test
port = 80
path = /
method = GET
resourceType = document
responseStatus = 409
navigationError = null
targetRequestObserved = true
```

The timing exposed by `request.timing()` was:

```text
domainLookupStart = 2026-09-21T20:37:47.711Z
domainLookupEnd   = 2026-09-21T20:37:47.718Z
connectStart      = 2026-09-21T20:37:47.718Z
connectEnd        = 2026-09-21T20:37:47.732Z
requestStart      = 2026-09-21T20:37:47.732Z
responseStart     = 2026-09-21T20:37:47.757Z
responseEnd       = 2026-09-21T20:37:47.759Z
```

This gives a usable first lookup window and first request end.

## 6. Chromium attempt 2 — post-rebind resolution

A separate Chromium process was launched for the second attempt.

Observed:

```text
requestAt = 2026-09-21T20:37:48.118Z
hostname = rebind.test
port = 80
path = /
method = GET
resourceType = document
targetRequestObserved = true
navigationError = net::ERR_ABORTED
responseStatus = null
```

The second request did not expose usable `domainLookupStart` / `domainLookupEnd` values through Playwright:

```text
domainLookupStart = -1
domainLookupEnd   = -1
connectStart      = -1
connectEnd        = -1
requestStart      = -1
responseStart     = -1
responseEnd       = -1
```

Therefore the required second Chromium lookup window could not be correlated with the second DNS answer. This is a genuine limitation of this execution, not a missing claim to be filled by inference.

## 7. Real Gateway DNS evidence

The DNS log was cleared immediately before the run and contained six lines afterward. The two relevant `rebind.test` records were:

```text
2026-09-21T20:37:47.785949Z 10.20.0.10 rebind.test. A -> 1.1.1.1 (sequence=1)
2026-09-21T20:37:48.202613Z 10.20.0.10 rebind.test. A -> 10.20.0.1 (sequence=2)
```

Other log entries were ordinary upstream queries generated during the same run and are not used as rebinding evidence.

This proves that the laboratory DNS service actually delivered the intended DNS sequence:

```text
DNS sequence 1 -> 1.1.1.1
DNS sequence 2 -> 10.20.0.1
```

It does not, by itself, prove that Chromium's second lookup used sequence 2 because the second Playwright lookup window was unavailable.

## 8. Gateway boundary evidence

Immediately before the browser execution, the relevant `nftables` input drop counter was:

```text
packets = 5
bytes   = 260
```

Immediately after the browser execution, the same drop rule showed:

```text
packets = 25
bytes   = 1612
```

Observed deltas:

```text
packetsDelta = 20
bytesDelta   = 1352
```

The delta calculation is exact:

```text
25 - 5 = 20
1612 - 260 = 1352
```

This is real lower-boundary evidence that additional traffic from the Browser VM reached the Gateway input drop during the execution.

Important limitation: the post-run `nftables` snapshot was captured after the browser command completed, but no exact ISO timestamp for that snapshot was persisted in a formal `phase-08-egress-evidence.json` artifact. Therefore the timing relation `egressObservedAt` -> second browser lookup cannot be independently validated from a formal artifact in this run.

Also, `internalHits=0` was not captured as a separate application-level internal fixture counter in this real-network run. It must not be invented.

## 9. Timeline observed from the raw evidence

Relevant browser/DNS timestamps:

```text
Browser first request observed:
  2026-09-21T20:37:44.983Z

Browser first lookup:
  2026-09-21T20:37:47.711Z -> 2026-09-21T20:37:47.718Z

Browser first request end:
  2026-09-21T20:37:47.759Z

DNS sequence 1:
  2026-09-21T20:37:47.785949Z

Browser second request observed:
  2026-09-21T20:37:48.118Z

DNS sequence 2:
  2026-09-21T20:37:48.202613Z
```

With `maxOffsetMs = 457`, the first DNS event is close enough to the first Chromium lookup window for the cross-VM correlation tolerance used by the classifier. The second DNS event also occurs after the first request end and after the second request event, but the second request has no usable lookup window. Therefore the full consolidation gate cannot be satisfied.

## 10. Consolidated classification

| Evidence item | Status | Reason |
|---|---|---|
| Fresh cross-VM clock reference | PASS | `maxOffsetMs=457` and valid ISO timestamps |
| Real DNS sequence 1 | PASS | `rebind.test -> 1.1.1.1` observed on Gateway |
| Real DNS sequence 2 | PASS | `rebind.test -> 10.20.0.1` observed on Gateway |
| Chromium process 1 | PASS / observed | Real Chromium request with usable lookup timing |
| Chromium process 2 | LIMITATION | Request observed, but lookup timing unavailable |
| Gateway drop counter increased | PASS / observed | +20 packets and +1352 bytes |
| Formal egress artifact | NOT EXECUTED | Not exported as the required JSON artifact |
| Full cross-VM browser/DNS/egress correlation | LIMITATION | Missing second lookup window and formal egress observedAt |
| Consolidated harness result for this run | LIMITATION | Evidence exists, but required timing/artifact conditions for PASS were not all satisfied |

## 11. What this execution demonstrates

This execution upgrades the laboratory evidence from a browser-unexecuted state to a real browser observation:

```text
real Gateway DNS
    ->
real Chromium request
    ->
real DNS answer change
    ->
real second Chromium request attempt
    ->
real Gateway packet counter increase at the input drop
```

It does not demonstrate DNS pinning by a production `BrowserProvider`, and it does not demonstrate that Chromium itself exposed a second DNS lookup that can be proven against sequence 2.

## 12. Explicit limitations retained

The following are deliberately preserved:

- Consolidated result is `LIMITATION`, not `PASS`.
- The second Chromium lookup timing is unavailable.
- The browser harness was initially invoked without DNS/egress evidence JSON inputs, so its emitted report classified the consolidation as `NOT EXECUTED`.
- The Gateway egress evidence was observed through before/after `nftables` counters but was not exported as a formal artifact with an exact `observedAt` timestamp.
- `internalHits=0` was not independently captured for this real-network run.
- No inference is made from `ERR_ABORTED` alone about the exact destination IP or socket.
- No claim is made that the current run proves DNS pinning or a production BrowserProvider.
- ADR-012 remains provisional and open.

## 13. Recommended next experiment

The next attempt should preserve this successful laboratory setup and focus narrowly on obtaining a usable second Chromium DNS lookup window and formal Gateway artifacts.

Required improvements for a future run:

1. Reset DNS evidence and `nftables` counters.
2. Capture a formal DNS JSON artifact from the Gateway log:
   - `source=gateway-dns`
   - `hostname=rebind.test`
   - sequence 1 = `1.1.1.1`
   - sequence 2 = `10.20.0.1`
   - exact ISO timestamps.
3. Capture a formal egress JSON artifact around the second browser attempt with exact before/after counters and a real `observedAt` timestamp.
4. Re-run Chromium only after these artifacts are ready.
5. Preserve the second request's `request.timing()`. If `domainLookupStart/domainLookupEnd` remain unavailable, retain `LIMITATION`.
6. If a future run satisfies all classifier conditions, run the consolidation harness with all three evidence inputs and preserve the exact resulting status.

No production BrowserProvider or architecture selection should be made from this execution alone.

## 14. Repository/code integrity

This execution did not modify:

- `src/`
- `package.json`
- lockfiles
- productive BrowserProvider code
- ADR-012 decision state

The purpose of this document is evidence capture only.
