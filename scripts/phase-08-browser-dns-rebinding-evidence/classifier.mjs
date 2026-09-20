export const DEFAULTS = Object.freeze({
  hostname: 'rebind.test',
  publicIp: '1.1.1.1',
  privateIp: '10.20.0.1',
});

function isIsoTimestamp(value) {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function statusForInvalidEvidence(evidence, reason) {
  if (evidence && typeof evidence === 'object' && evidence._readError) {
    return { status: 'FAIL', reason: evidence._readError };
  }
  return { status: 'FAIL', reason };
}

export function validateDnsEvidence(evidence) {
  if (evidence == null) return { status: 'NOT EXECUTED', reason: 'DNS_EVIDENCE_NOT_PROVIDED' };
  const answers = Array.isArray(evidence.answers) ? evidence.answers : [];
  const first = answers.find((answer) => answer?.sequence === 1 && answer?.type === 'A');
  const second = answers.find((answer) => answer?.sequence === 2 && answer?.type === 'A');
  const valid = evidence.source === 'gateway-dns'
    && evidence.hostname === DEFAULTS.hostname
    && first?.address === DEFAULTS.publicIp
    && second?.address === DEFAULTS.privateIp
    && isIsoTimestamp(first?.observedAt)
    && isIsoTimestamp(second?.observedAt)
    && Date.parse(first.observedAt) < Date.parse(second.observedAt);
  if (!valid) return statusForInvalidEvidence(evidence, 'DNS_SEQUENCE_OR_TIMESTAMPS_INVALID');
  return {
    status: 'PASS',
    source: evidence.source,
    hostname: evidence.hostname,
    firstDnsAt: first.observedAt,
    secondDnsAt: second.observedAt,
    answers: answers.slice(0, 4),
    reason: 'REAL_DNS_SEQUENCE_MATCHED',
  };
}

export function validateEgressEvidence(evidence) {
  if (evidence == null) return { status: 'NOT EXECUTED', reason: 'EGRESS_EVIDENCE_NOT_PROVIDED' };
  const valid = evidence.source === 'gateway-nftables'
    && evidence.sourceAddress === '10.20.0.10'
    && evidence.destinationAddress === DEFAULTS.privateIp
    && evidence.action === 'drop'
    && Number.isSafeInteger(evidence.packetsBefore)
    && evidence.packetsBefore >= 0
    && Number.isSafeInteger(evidence.packetsAfter)
    && evidence.packetsAfter >= evidence.packetsBefore
    && Number.isSafeInteger(evidence.packetsDelta)
    && evidence.packetsDelta === evidence.packetsAfter - evidence.packetsBefore
    && evidence.packetsDelta > 0
    && Number.isSafeInteger(evidence.bytesBefore)
    && evidence.bytesBefore >= 0
    && Number.isSafeInteger(evidence.bytesAfter)
    && evidence.bytesAfter >= evidence.bytesBefore
    && Number.isSafeInteger(evidence.bytesDelta)
    && evidence.bytesDelta === evidence.bytesAfter - evidence.bytesBefore
    && evidence.internalHits === 0
    && isIsoTimestamp(evidence.observedAt);
  if (!valid) return statusForInvalidEvidence(evidence, 'EGRESS_DROP_OR_TIMESTAMP_INVALID');
  return {
    status: 'PASS',
    source: evidence.source,
    sourceAddress: evidence.sourceAddress,
    destinationAddress: evidence.destinationAddress,
    action: evidence.action,
    packetsBefore: evidence.packetsBefore,
    packetsAfter: evidence.packetsAfter,
    packetsDelta: evidence.packetsDelta,
    bytesBefore: evidence.bytesBefore,
    bytesAfter: evidence.bytesAfter,
    bytesDelta: evidence.bytesDelta,
    internalHits: evidence.internalHits,
    egressObservedAt: evidence.observedAt,
    reason: 'LOWER_BOUNDARY_DROP_DELTA_MATCHED',
  };
}

export function validateClockReference(evidence) {
  if (evidence == null) return { status: 'LIMITATION', reason: 'CLOCK_REFERENCE_NOT_PROVIDED' };
  const valid = evidence.source === 'lab-clock-reference'
    && isIsoTimestamp(evidence.gatewayUtc)
    && isIsoTimestamp(evidence.browserUtc)
    && isIsoTimestamp(evidence.observedAt)
    && Number.isSafeInteger(evidence.maxOffsetMs)
    && evidence.maxOffsetMs >= 0;
  if (!valid) return statusForInvalidEvidence(evidence, 'CLOCK_REFERENCE_INVALID');
  return {
    status: 'PASS',
    source: evidence.source,
    gatewayUtc: evidence.gatewayUtc,
    browserUtc: evidence.browserUtc,
    observedAt: evidence.observedAt,
    maxOffsetMs: evidence.maxOffsetMs,
    reason: 'CROSS_VM_CLOCK_REFERENCE_CAPTURED',
  };
}

function firstTargetRequest(attempt) {
  return attempt?.requests?.find((request) => request?.hostname === DEFAULTS.hostname) ?? null;
}

function absoluteLookupWindow(request) {
  const absolute = request?.timing?.absolute;
  if (!absolute || typeof absolute !== 'object') return null;
  if (typeof absolute.domainLookupStart !== 'string' || typeof absolute.domainLookupEnd !== 'string') return null;
  const start = Date.parse(absolute.domainLookupStart);
  const end = Date.parse(absolute.domainLookupEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return null;
  return { start, end };
}

function correlationDetails(dnsEvidence, egressEvidence, clockEvidence, firstRequest, secondRequest) {
  const clock = clockEvidence ?? {};
  return {
    firstDnsAt: dnsEvidence.firstDnsAt ?? null,
    firstDomainLookupStart: firstRequest?.timing?.absolute?.domainLookupStart ?? null,
    firstDomainLookupEnd: firstRequest?.timing?.absolute?.domainLookupEnd ?? null,
    secondDnsAt: dnsEvidence.secondDnsAt ?? null,
    secondDomainLookupStart: secondRequest?.timing?.absolute?.domainLookupStart ?? null,
    secondDomainLookupEnd: secondRequest?.timing?.absolute?.domainLookupEnd ?? null,
    firstRequestAt: firstRequest?.requestAt ?? null,
    secondRequestAt: secondRequest?.requestAt ?? null,
    egressObservedAt: egressEvidence.egressObservedAt ?? null,
    clockGatewayUtc: clock.gatewayUtc ?? null,
    clockBrowserUtc: clock.browserUtc ?? null,
    clockObservedAt: clock.observedAt ?? null,
    clockMaxOffsetMs: clock.maxOffsetMs ?? null,
  };
}

export function correlateBrowserDnsEgress(attempts, dnsEvidence, egressEvidence, clockEvidence) {
  const clock = clockEvidence ?? { status: 'LIMITATION' };
  if (!Array.isArray(attempts) || attempts.length < 2) {
    return { status: 'NOT EXECUTED', reason: 'TWO_BROWSER_ATTEMPTS_REQUIRED' };
  }
  if (dnsEvidence.status === 'NOT EXECUTED' || egressEvidence.status === 'NOT EXECUTED') {
    return { status: 'NOT EXECUTED', reason: 'LOWER_BOUNDARY_ARTIFACT_MISSING' };
  }
  if (dnsEvidence.status === 'FAIL' || egressEvidence.status === 'FAIL') {
    return { status: 'FAIL', reason: 'LOWER_BOUNDARY_ARTIFACT_INVALID' };
  }
  if (clock.status === 'FAIL') {
    return { status: 'FAIL', reason: 'CLOCK_REFERENCE_INVALID' };
  }
  if (clock.status === 'NOT EXECUTED' || clock.status === 'LIMITATION') {
    return { status: clock.status, reason: 'CROSS_VM_CLOCK_REFERENCE_INSUFFICIENT' };
  }

  const firstRequest = firstTargetRequest(attempts[0]);
  const secondRequest = firstTargetRequest(attempts[1]);
  if (!firstRequest || !secondRequest) {
    return {
      status: 'LIMITATION',
      ...correlationDetails(dnsEvidence, egressEvidence, clockEvidence, firstRequest, secondRequest),
      reason: 'BROWSER_DID_NOT_EXPOSE_TWO_TARGET_REQUESTS',
    };
  }

  const firstLookup = absoluteLookupWindow(firstRequest);
  const secondLookup = absoluteLookupWindow(secondRequest);
  if (!firstLookup || !secondLookup) {
    return {
      status: 'LIMITATION',
      ...correlationDetails(dnsEvidence, egressEvidence, clockEvidence, firstRequest, secondRequest),
      reason: 'BROWSER_DNS_LOOKUP_TIMING_UNAVAILABLE',
    };
  }

  const firstDnsMs = Date.parse(dnsEvidence.firstDnsAt);
  const secondDnsMs = Date.parse(dnsEvidence.secondDnsAt);
  const egressMs = Date.parse(egressEvidence.egressObservedAt);
  const timestampsValid = [firstDnsMs, secondDnsMs, egressMs].every(Number.isFinite);
  if (!timestampsValid) {
    return {
      status: 'FAIL',
      ...correlationDetails(dnsEvidence, egressEvidence, clockEvidence, firstRequest, secondRequest),
      reason: 'BROWSER_OR_EGRESS_TIMESTAMP_INVALID',
    };
  }
  if (firstDnsMs < firstLookup.start || firstDnsMs > firstLookup.end) {
    return {
      status: 'FAIL',
      ...correlationDetails(dnsEvidence, egressEvidence, clockEvidence, firstRequest, secondRequest),
      reason: 'FIRST_DNS_RESPONSE_OUTSIDE_BROWSER_LOOKUP_WINDOW',
    };
  }
  if (secondDnsMs < secondLookup.start || secondDnsMs > secondLookup.end) {
    return {
      status: 'FAIL',
      ...correlationDetails(dnsEvidence, egressEvidence, clockEvidence, firstRequest, secondRequest),
      reason: 'SECOND_DNS_RESPONSE_OUTSIDE_BROWSER_LOOKUP_WINDOW',
    };
  }
  if (egressMs < secondLookup.end) {
    return {
      status: 'FAIL',
      ...correlationDetails(dnsEvidence, egressEvidence, clockEvidence, firstRequest, secondRequest),
      reason: 'EGRESS_ARTIFACT_PRECEDES_SECOND_BROWSER_LOOKUP_END',
    };
  }
  return {
    status: 'PASS',
    ...correlationDetails(dnsEvidence, egressEvidence, clockEvidence, firstRequest, secondRequest),
    reason: 'DNS_BROWSER_LOOKUP_EGRESS_TIMELINE_MATCHED',
  };
}

export function classifyOverall(attempts, dnsEvidence, egressEvidence, correlation) {
  if (dnsEvidence.status === 'FAIL' || egressEvidence.status === 'FAIL' || correlation.status === 'FAIL') return 'FAIL';
  if (dnsEvidence.status === 'NOT EXECUTED' || egressEvidence.status === 'NOT EXECUTED' || correlation.status === 'NOT EXECUTED') return 'NOT EXECUTED';
  if (correlation.status === 'LIMITATION') return 'LIMITATION';
  const twoAttempts = Array.isArray(attempts)
    && attempts.length >= 2
    && attempts.every((attempt) => Boolean(firstTargetRequest(attempt)));
  return twoAttempts && dnsEvidence.status === 'PASS' && egressEvidence.status === 'PASS' && correlation.status === 'PASS'
    ? 'PASS'
    : 'LIMITATION';
}
