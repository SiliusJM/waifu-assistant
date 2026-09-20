import assert from 'node:assert/strict';
import {
  classifyOverall,
  correlateBrowserDnsEgress,
  validateClockReference,
  validateDnsEvidence,
  validateEgressEvidence,
} from './classifier.mjs';

const dnsAnswers = {
  source: 'gateway-dns',
  hostname: 'rebind.test',
  answers: [
    { sequence: 1, type: 'A', address: '1.1.1.1', observedAt: '2026-09-20T10:00:00.000Z' },
    { sequence: 2, type: 'A', address: '10.20.0.1', observedAt: '2026-09-20T10:00:02.000Z' },
  ],
};

const egressDrop = {
  source: 'gateway-nftables',
  sourceAddress: '10.20.0.10',
  destinationAddress: '10.20.0.1',
  action: 'drop',
  packetsBefore: 100,
  packetsAfter: 112,
  packetsDelta: 12,
  bytesBefore: 7_000,
  bytesAfter: 7_788,
  bytesDelta: 788,
  internalHits: 0,
  observedAt: '2026-09-20T10:00:04.000Z',
};

const clockReference = {
  source: 'lab-clock-reference',
  gatewayUtc: '2026-09-20T09:59:58.000Z',
  browserUtc: '2026-09-20T09:59:59.000Z',
  observedAt: '2026-09-20T09:59:59.500Z',
  maxOffsetMs: 1_000,
};

const attempts = [
  {
    requests: [{
      hostname: 'rebind.test',
      requestAt: '2026-09-20T10:00:01.000Z',
      timing: {
        absolute: {
          domainLookupStart: '2026-09-20T09:59:59.500Z',
          domainLookupEnd: '2026-09-20T10:00:00.500Z',
          responseEnd: '2026-09-20T10:00:01.500Z',
        },
      },
    }],
  },
  {
    requests: [{
      hostname: 'rebind.test',
      requestAt: '2026-09-20T10:00:03.000Z',
      timing: {
        absolute: {
          domainLookupStart: '2026-09-20T10:00:01.500Z',
          domainLookupEnd: '2026-09-20T10:00:02.500Z',
          responseEnd: '2026-09-20T10:00:03.500Z',
        },
      },
    }],
  },
];

function validatedFixtures() {
  return {
    dns: validateDnsEvidence(dnsAnswers),
    egress: validateEgressEvidence(egressDrop),
    clock: validateClockReference(clockReference),
  };
}

function test(name, callback) {
  callback();
  console.log(`PASS ${name}`);
}

test('classifies the strictly ordered DNS, browser and egress timeline as pass', () => {
  const { dns, egress, clock } = validatedFixtures();
  const correlation = correlateBrowserDnsEgress(attempts, dns, egress, clock);
  assert.equal(correlation.status, 'PASS');
  assert.equal(classifyOverall(attempts, dns, egress, correlation), 'PASS');
});

test('accepts DNS1 perfectly inside lookup1 with zero tolerance', () => {
  const strictClock = validateClockReference({ ...clockReference, maxOffsetMs: 0 });
  const exactDns = structuredClone(dnsAnswers);
  exactDns.answers[0].observedAt = '2026-09-20T10:00:00.000Z';
  const dns = validateDnsEvidence(exactDns);
  const { egress } = validatedFixtures();
  const correlation = correlateBrowserDnsEgress(attempts, dns, egress, strictClock);
  assert.equal(correlation.status, 'PASS');
});

test('accepts DNS1 outside lookup1 but within maxOffsetMs', () => {
  const shiftedAttempts = structuredClone(attempts);
  shiftedAttempts[0].requests[0].timing.absolute = {
    domainLookupStart: '2026-09-20T10:00:00.750Z',
    domainLookupEnd: '2026-09-20T10:00:01.250Z',
    responseEnd: '2026-09-20T10:00:01.500Z',
  };
  const { dns, egress, clock } = validatedFixtures();
  const correlation = correlateBrowserDnsEgress(shiftedAttempts, dns, egress, clock);
  assert.equal(correlation.status, 'PASS');
});

test('accepts DNS1 exactly at both lookup1 tolerance edges', () => {
  const edgeValues = [
    '2026-09-20T09:59:59.500Z',
    '2026-09-20T10:00:00.500Z',
  ];
  const strictClock = validateClockReference({ ...clockReference, maxOffsetMs: 0 });
  const { egress } = validatedFixtures();
  for (const observedAt of edgeValues) {
    const edgeDns = structuredClone(dnsAnswers);
    edgeDns.answers[0].observedAt = observedAt;
    const dns = validateDnsEvidence(edgeDns);
    const correlation = correlateBrowserDnsEgress(attempts, dns, egress, strictClock);
    assert.equal(correlation.status, 'PASS');
  }
});

test('rejects DNS1 before lookup1 beyond tolerance', () => {
  const shiftedAttempts = structuredClone(attempts);
  shiftedAttempts[0].requests[0].timing.absolute.domainLookupStart = '2026-09-20T10:00:02.000Z';
  shiftedAttempts[0].requests[0].timing.absolute.domainLookupEnd = '2026-09-20T10:00:02.500Z';
  const { dns, egress, clock } = validatedFixtures();
  const correlation = correlateBrowserDnsEgress(shiftedAttempts, dns, egress, clock);
  assert.equal(correlation.status, 'FAIL');
});

test('rejects DNS1 after lookup1 beyond tolerance', () => {
  const lateDns = structuredClone(dnsAnswers);
  lateDns.answers[0].observedAt = '2026-09-20T10:00:02.000Z';
  const dns = validateDnsEvidence(lateDns);
  const { egress, clock } = validatedFixtures();
  const correlation = correlateBrowserDnsEgress(attempts, dns, egress, clock);
  assert.equal(correlation.status, 'FAIL');
});

test('rejects inverted DNS answers', () => {
  const inverted = structuredClone(dnsAnswers);
  [inverted.answers[0].address, inverted.answers[1].address] = [inverted.answers[1].address, inverted.answers[0].address];
  assert.equal(validateDnsEvidence(inverted).status, 'FAIL');
});

test('classifies a second browser navigation without a demonstrated second request as limitation', () => {
  const { dns, egress, clock } = validatedFixtures();
  const incompleteAttempts = [attempts[0], { requests: [] }];
  const correlation = correlateBrowserDnsEgress(incompleteAttempts, dns, egress, clock);
  assert.equal(correlation.status, 'LIMITATION');
  assert.equal(classifyOverall(incompleteAttempts, dns, egress, correlation), 'LIMITATION');
});

test('classifies missing browser DNS timing as limitation', () => {
  const { dns, egress, clock } = validatedFixtures();
  const missingTimingAttempts = structuredClone(attempts);
  missingTimingAttempts[1].requests[0].timing = {
    startTime: 1_000,
    domainLookupStart: -1,
    domainLookupEnd: -1,
    absolute: { domainLookupStart: null, domainLookupEnd: null },
  };
  const correlation = correlateBrowserDnsEgress(missingTimingAttempts, dns, egress, clock);
  assert.equal(correlation.status, 'LIMITATION');
});

test('classifies two requests without a demonstrated second lookup as limitation', () => {
  const { dns, egress, clock } = validatedFixtures();
  const noSecondLookupAttempts = structuredClone(attempts);
  noSecondLookupAttempts[1].requests[0].timing.absolute = {
    domainLookupStart: null,
    domainLookupEnd: null,
  };
  const correlation = correlateBrowserDnsEgress(noSecondLookupAttempts, dns, egress, clock);
  assert.equal(correlation.status, 'LIMITATION');
});

test('rejects DNS sequence two outside the second browser lookup window', () => {
  const { dns, egress, clock } = validatedFixtures();
  const outsideLookupAttempts = structuredClone(attempts);
  outsideLookupAttempts[1].requests[0].timing.absolute = {
    domainLookupStart: '2026-09-20T10:00:03.500Z',
    domainLookupEnd: '2026-09-20T10:00:04.500Z',
  };
  const correlation = correlateBrowserDnsEgress(outsideLookupAttempts, dns, egress, clock);
  assert.equal(correlation.status, 'FAIL');
});

test('accepts DNS2 perfectly inside lookup2 with zero tolerance', () => {
  const strictClock = validateClockReference({ ...clockReference, maxOffsetMs: 0 });
  const { dns, egress } = validatedFixtures();
  const correlation = correlateBrowserDnsEgress(attempts, dns, egress, strictClock);
  assert.equal(correlation.status, 'PASS');
});

test('accepts DNS2 outside lookup2 but within maxOffsetMs', () => {
  const shiftedAttempts = structuredClone(attempts);
  shiftedAttempts[1].requests[0].timing.absolute = {
    domainLookupStart: '2026-09-20T10:00:02.500Z',
    domainLookupEnd: '2026-09-20T10:00:03.000Z',
    responseEnd: '2026-09-20T10:00:03.500Z',
  };
  const { dns, egress, clock } = validatedFixtures();
  const correlation = correlateBrowserDnsEgress(shiftedAttempts, dns, egress, clock);
  assert.equal(correlation.status, 'PASS');
});

test('accepts DNS2 exactly at both lookup2 tolerance edges', () => {
  const edgeWindows = [
    ['2026-09-20T10:00:02.000Z', '2026-09-20T10:00:02.500Z'],
    ['2026-09-20T10:00:01.500Z', '2026-09-20T10:00:02.000Z'],
  ];
  const strictClock = validateClockReference({ ...clockReference, maxOffsetMs: 0 });
  const { dns, egress } = validatedFixtures();
  for (const [domainLookupStart, domainLookupEnd] of edgeWindows) {
    const edgeAttempts = structuredClone(attempts);
    edgeAttempts[1].requests[0].timing.absolute.domainLookupStart = domainLookupStart;
    edgeAttempts[1].requests[0].timing.absolute.domainLookupEnd = domainLookupEnd;
    const correlation = correlateBrowserDnsEgress(edgeAttempts, dns, egress, strictClock);
    assert.equal(correlation.status, 'PASS');
  }
});

test('rejects DNS2 after lookup2 beyond tolerance', () => {
  const shiftedAttempts = structuredClone(attempts);
  shiftedAttempts[1].requests[0].timing.absolute = {
    domainLookupStart: '2026-09-20T10:00:00.500Z',
    domainLookupEnd: '2026-09-20T10:00:00.900Z',
    responseEnd: '2026-09-20T10:00:03.500Z',
  };
  const { dns, egress, clock } = validatedFixtures();
  const correlation = correlateBrowserDnsEgress(shiftedAttempts, dns, egress, clock);
  assert.equal(correlation.status, 'FAIL');
});

test('rejects DNS sequence two before the first request finishes', () => {
  const { egress, clock } = validatedFixtures();
  const earlyDns = structuredClone(dnsAnswers);
  earlyDns.answers[1].observedAt = '2026-09-20T10:00:00.000Z';
  const dns = validateDnsEvidence(earlyDns);
  const correlation = correlateBrowserDnsEgress(attempts, dns, egress, clock);
  assert.equal(correlation.status, 'FAIL');
});

test('rejects a second target request started before DNS sequence two', () => {
  const { dns, egress, clock } = validatedFixtures();
  const earlySecondRequest = structuredClone(attempts);
  earlySecondRequest[1].requests[0].requestAt = '2026-09-20T10:00:00.000Z';
  const correlation = correlateBrowserDnsEgress(earlySecondRequest, dns, egress, clock);
  assert.equal(correlation.status, 'FAIL');
});

test('rejects egress observation before the second browser lookup', () => {
  const { dns, clock } = validatedFixtures();
  const earlyEgress = validateEgressEvidence({ ...egressDrop, observedAt: '2026-09-20T10:00:00.000Z' });
  const correlation = correlateBrowserDnsEgress(attempts, dns, earlyEgress, clock);
  assert.equal(correlation.status, 'FAIL');
});

test('accepts egress at the lower edge of maxOffsetMs', () => {
  const { dns, clock } = validatedFixtures();
  const egress = validateEgressEvidence({ ...egressDrop, observedAt: '2026-09-20T10:00:01.500Z' });
  const correlation = correlateBrowserDnsEgress(attempts, dns, egress, clock);
  assert.equal(correlation.status, 'PASS');
});

test('accepts a timeline only when maxOffsetMs covers the cross-VM offset', () => {
  const shiftedAttempts = structuredClone(attempts);
  shiftedAttempts[0].requests[0].timing.absolute = {
    domainLookupStart: '2026-09-20T10:00:00.750Z',
    domainLookupEnd: '2026-09-20T10:00:01.250Z',
    responseEnd: '2026-09-20T10:00:01.500Z',
  };
  const { dns, egress } = validatedFixtures();
  const strictClock = validateClockReference({ ...clockReference, maxOffsetMs: 0 });
  const strictCorrelation = correlateBrowserDnsEgress(shiftedAttempts, dns, egress, strictClock);
  assert.equal(strictCorrelation.status, 'FAIL');
  const tolerantClock = validateClockReference({ ...clockReference, maxOffsetMs: 1_000 });
  const tolerantCorrelation = correlateBrowserDnsEgress(shiftedAttempts, dns, egress, tolerantClock);
  assert.equal(tolerantCorrelation.status, 'PASS');
});

test('rejects lower-boundary evidence with internal hits', () => {
  const invalidEgress = { ...egressDrop, internalHits: 1 };
  const { dns, clock } = validatedFixtures();
  const egress = validateEgressEvidence(invalidEgress);
  assert.equal(egress.status, 'FAIL');
  const correlation = correlateBrowserDnsEgress(attempts, dns, egress, clock);
  assert.equal(classifyOverall(attempts, dns, egress, correlation), 'FAIL');
});

test('rejects preclassified evidence without real fields', () => {
  assert.equal(validateDnsEvidence({ status: 'PASS' }).status, 'FAIL');
  assert.equal(validateEgressEvidence({ status: 'PASS' }).status, 'FAIL');
});

test('rejects a non-positive packet delta', () => {
  assert.equal(validateEgressEvidence({ ...egressDrop, packetsDelta: 0 }).status, 'FAIL');
});

test('rejects an inconsistent packet or byte delta', () => {
  assert.equal(validateEgressEvidence({ ...egressDrop, packetsDelta: 11 }).status, 'FAIL');
  assert.equal(validateEgressEvidence({ ...egressDrop, bytesDelta: 787 }).status, 'FAIL');
});

test('classifies missing clock reference as limitation', () => {
  const { dns, egress } = validatedFixtures();
  const correlation = correlateBrowserDnsEgress(attempts, dns, egress, validateClockReference(null));
  assert.equal(correlation.status, 'LIMITATION');
  assert.equal(classifyOverall(attempts, dns, egress, correlation), 'LIMITATION');
});

test('rejects invalid clock reference', () => {
  assert.equal(validateClockReference({ ...clockReference, maxOffsetMs: -1 }).status, 'FAIL');
});

test('classifies missing lower-boundary evidence as not executed', () => {
  const dns = validateDnsEvidence(null);
  const egress = validateEgressEvidence(null);
  const clock = validateClockReference(null);
  const correlation = correlateBrowserDnsEgress(attempts, dns, egress, clock);
  assert.equal(dns.status, 'NOT EXECUTED');
  assert.equal(egress.status, 'NOT EXECUTED');
  assert.equal(correlation.status, 'NOT EXECUTED');
  assert.equal(classifyOverall(attempts, dns, egress, correlation), 'NOT EXECUTED');
});
