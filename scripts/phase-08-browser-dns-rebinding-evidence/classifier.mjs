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
    && Number.isSafeInteger(evidence.packets)
    && evidence.packets > 0
    && evidence.internalHits === 0
    && isIsoTimestamp(evidence.observedAt);
  if (!valid) return statusForInvalidEvidence(evidence, 'EGRESS_DROP_OR_TIMESTAMP_INVALID');
  return {
    status: 'PASS',
    source: evidence.source,
    sourceAddress: evidence.sourceAddress,
    destinationAddress: evidence.destinationAddress,
    action: evidence.action,
    packets: evidence.packets,
    bytes: evidence.bytes ?? null,
    internalHits: evidence.internalHits,
    egressObservedAt: evidence.observedAt,
    reason: 'LOWER_BOUNDARY_DROP_MATCHED',
  };
}

function firstTargetRequest(attempt) {
  return attempt?.requests?.find((request) => request?.hostname === DEFAULTS.hostname) ?? null;
}

export function correlateBrowserDnsEgress(attempts, dnsEvidence, egressEvidence) {
  if (!Array.isArray(attempts) || attempts.length < 2) {
    return { status: 'NOT EXECUTED', reason: 'TWO_BROWSER_ATTEMPTS_REQUIRED' };
  }
  if (dnsEvidence.status === 'NOT EXECUTED' || egressEvidence.status === 'NOT EXECUTED') {
    return { status: 'NOT EXECUTED', reason: 'LOWER_BOUNDARY_ARTIFACT_MISSING' };
  }
  if (dnsEvidence.status === 'FAIL' || egressEvidence.status === 'FAIL') {
    return { status: 'FAIL', reason: 'LOWER_BOUNDARY_ARTIFACT_INVALID' };
  }

  const firstRequest = firstTargetRequest(attempts[0]);
  const secondRequest = firstTargetRequest(attempts[1]);
  if (!firstRequest || !secondRequest) {
    return {
      status: 'LIMITATION',
      firstDnsAt: dnsEvidence.firstDnsAt,
      secondDnsAt: dnsEvidence.secondDnsAt,
      firstBrowserRequestAt: firstRequest?.at ?? null,
      secondBrowserRequestAt: secondRequest?.at ?? null,
      egressObservedAt: egressEvidence.egressObservedAt,
      reason: 'BROWSER_DID_NOT_EXPOSE_TWO_TARGET_REQUESTS',
    };
  }

  const firstDnsMs = Date.parse(dnsEvidence.firstDnsAt);
  const secondDnsMs = Date.parse(dnsEvidence.secondDnsAt);
  const firstRequestMs = Date.parse(firstRequest.at);
  const secondRequestMs = Date.parse(secondRequest.at);
  const egressMs = Date.parse(egressEvidence.egressObservedAt);
  const timestampsValid = [firstRequestMs, secondRequestMs, egressMs].every(Number.isFinite);
  if (!timestampsValid) {
    return { status: 'FAIL', reason: 'BROWSER_OR_EGRESS_TIMESTAMP_INVALID' };
  }
  if (firstRequestMs <= firstDnsMs || firstRequestMs >= secondDnsMs) {
    return {
      status: 'LIMITATION',
      firstDnsAt: dnsEvidence.firstDnsAt,
      secondDnsAt: dnsEvidence.secondDnsAt,
      firstBrowserRequestAt: firstRequest.at,
      secondBrowserRequestAt: secondRequest.at,
      egressObservedAt: egressEvidence.egressObservedAt,
      reason: 'FIRST_BROWSER_REQUEST_OUTSIDE_DNS_WINDOW',
    };
  }
  if (secondRequestMs <= secondDnsMs) {
    return {
      status: 'LIMITATION',
      firstDnsAt: dnsEvidence.firstDnsAt,
      secondDnsAt: dnsEvidence.secondDnsAt,
      firstBrowserRequestAt: firstRequest.at,
      secondBrowserRequestAt: secondRequest.at,
      egressObservedAt: egressEvidence.egressObservedAt,
      reason: 'SECOND_BROWSER_REQUEST_NOT_AFTER_SECOND_DNS_ANSWER',
    };
  }
  if (egressMs < secondRequestMs) {
    return {
      status: 'LIMITATION',
      firstDnsAt: dnsEvidence.firstDnsAt,
      secondDnsAt: dnsEvidence.secondDnsAt,
      firstBrowserRequestAt: firstRequest.at,
      secondBrowserRequestAt: secondRequest.at,
      egressObservedAt: egressEvidence.egressObservedAt,
      reason: 'EGRESS_ARTIFACT_PRECEDES_SECOND_BROWSER_REQUEST',
    };
  }
  return {
    status: 'PASS',
    firstDnsAt: dnsEvidence.firstDnsAt,
    secondDnsAt: dnsEvidence.secondDnsAt,
    firstBrowserRequestAt: firstRequest.at,
    secondBrowserRequestAt: secondRequest.at,
    egressObservedAt: egressEvidence.egressObservedAt,
    reason: 'DNS_BROWSER_EGRESS_TIMELINE_MATCHED',
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
