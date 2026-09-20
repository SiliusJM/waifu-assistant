import assert from 'node:assert/strict';
import {
  classifyOverall,
  correlateBrowserDnsEgress,
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
  packets: 12,
  bytes: 788,
  internalHits: 0,
  observedAt: '2026-09-20T10:00:04.000Z',
};

const attempts = [
  { requests: [{ hostname: 'rebind.test', at: '2026-09-20T10:00:01.000Z' }] },
  { requests: [{ hostname: 'rebind.test', at: '2026-09-20T10:00:03.000Z' }] },
];

function validatedFixtures() {
  return {
    dns: validateDnsEvidence(dnsAnswers),
    egress: validateEgressEvidence(egressDrop),
  };
}

function test(name, callback) {
  callback();
  console.log(`PASS ${name}`);
}

test('correlates valid DNS, browser and egress timestamps', () => {
  const { dns, egress } = validatedFixtures();
  const correlation = correlateBrowserDnsEgress(attempts, dns, egress);
  assert.equal(correlation.status, 'PASS');
  assert.equal(classifyOverall(attempts, dns, egress, correlation), 'PASS');
});

test('rejects inverted DNS answers', () => {
  const inverted = structuredClone(dnsAnswers);
  [inverted.answers[0].address, inverted.answers[1].address] = [inverted.answers[1].address, inverted.answers[0].address];
  assert.equal(validateDnsEvidence(inverted).status, 'FAIL');
});

test('classifies a second browser navigation without a demonstrated second request as limitation', () => {
  const { dns, egress } = validatedFixtures();
  const incompleteAttempts = [attempts[0], { requests: [] }];
  const correlation = correlateBrowserDnsEgress(incompleteAttempts, dns, egress);
  assert.equal(correlation.status, 'LIMITATION');
  assert.equal(classifyOverall(incompleteAttempts, dns, egress, correlation), 'LIMITATION');
});

test('rejects lower-boundary evidence with internal hits', () => {
  const invalidEgress = { ...egressDrop, internalHits: 1 };
  const { dns } = validatedFixtures();
  const egress = validateEgressEvidence(invalidEgress);
  assert.equal(egress.status, 'FAIL');
  const correlation = correlateBrowserDnsEgress(attempts, dns, egress);
  assert.equal(classifyOverall(attempts, dns, egress, correlation), 'FAIL');
});

test('rejects preclassified evidence without real fields', () => {
  assert.equal(validateDnsEvidence({ status: 'PASS' }).status, 'FAIL');
  assert.equal(validateEgressEvidence({ status: 'PASS' }).status, 'FAIL');
});

test('classifies missing lower-boundary evidence as not executed', () => {
  const dns = validateDnsEvidence(null);
  const egress = validateEgressEvidence(null);
  const correlation = correlateBrowserDnsEgress(attempts, dns, egress);
  assert.equal(dns.status, 'NOT EXECUTED');
  assert.equal(egress.status, 'NOT EXECUTED');
  assert.equal(correlation.status, 'NOT EXECUTED');
  assert.equal(classifyOverall(attempts, dns, egress, correlation), 'NOT EXECUTED');
});
