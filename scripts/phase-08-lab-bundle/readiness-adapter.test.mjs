import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { adaptEvidence, verifyGeneratedArtifact } from './readiness-adapter.mjs';

const runId = 'phase08-readiness-test-run';
const maxClockAgeMs = 120_000;

function currentTime() {
  return new Date().toISOString();
}

function manifestFor() {
  return {
    schemaVersion: 1,
    runId,
    state: 'PREPARED',
    policy: { maxClockAgeMs },
    layout: { directories: { host: {}, browser: {}, gateway: {}, fixture: {} } },
  };
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function withBundle(callback) {
  const root = await mkdtemp(join(tmpdir(), 'phase08-readiness-adapter-test-'));
  try {
    const manifest = manifestFor();
    await writeJson(join(root, `${runId}.manifest.current.json`), manifest);
    return await callback(root, manifest);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function evidenceEnvelope(source, kind, data, overrides = {}) {
  return {
    schemaVersion: 1,
    runId,
    source,
    kind,
    status: 'PASS',
    observedAt: currentTime(),
    producer: 'controlled-test-producer',
    data,
    ...overrides,
  };
}

function dataFor(kind, observedAt = currentTime()) {
  if (kind === 'clock-reference') return { gatewayUtc: observedAt, browserUtc: observedAt, maxOffsetMs: 50 };
  if (kind === 'counters-before') return { captured: true, packetsBefore: 10, bytesBefore: 100, counter: 'nftables-wa-lab' };
  if (kind === 'dns-formal') return {
    formal: true,
    canExportSequence: true,
    dnsSource: 'gateway-dns-log',
    outputContract: { sequence: 'sequence', observedAt: 'observedAt', address: 'address' },
    sequence: [{ sequence: 1, observedAt, address: '1.1.1.1' }],
  };
  if (kind === 'egress-formal') return {
    differential: true,
    counterSource: 'nftables-wa-lab',
    destination: '10.20.0.1:80',
    beforeObservedAt: new Date(Date.parse(observedAt) - 1_000).toISOString(),
    afterObservedAt: observedAt,
    outputContract: { before: 'packetsBefore/bytesBefore', after: 'packetsAfter/bytesAfter', delta: 'packetsDelta/bytesDelta' },
    packetsBefore: 10,
    packetsAfter: 15,
    packetsDelta: 5,
    bytesBefore: 100,
    bytesAfter: 500,
    bytesDelta: 400,
  };
  if (kind === 'internal-hits') return { independent: true, measurementMethod: 'fixture-request-counter', result: { internalHits: 0 } };
  if (kind === 'rollback') return {
    snapshotId: 'snapshot-1',
    provider: 'dedicated-lab-provider',
    scope: 'phase08-lab-vm-set',
    createdAt: observedAt,
    reversibilityEvidence: 'snapshot-manifest-sha256',
  };
  if (kind === 'fixture-isolation') return {
    topology: 'browser-gateway-fixture-v1',
    browserToFixtureDirectRoute: false,
    verificationMethod: 'route-table-and-gateway-observation',
  };
  throw new Error(`unknown test kind ${kind}`);
}

const cases = [
  ['clock', 'host', 'clock-reference'],
  ['gateway', 'gateway', 'counters-before'],
  ['gateway', 'gateway', 'dns-formal'],
  ['gateway', 'gateway', 'egress-formal'],
  ['fixture', 'fixture', 'internal-hits'],
  ['rollback', 'host', 'rollback'],
  ['isolation', 'browser', 'fixture-isolation'],
];

async function writeEvidence(root, source, kind, evidence, name = `${source}-external.json`) {
  const path = join(root, source, 'input', name);
  await writeJson(path, evidence);
  return name;
}

test('valid evidence creates canonical artifacts and verifiable markers for every adapter', async () => {
  await withBundle(async (root) => {
    for (const [command, source, kind] of cases) {
      const evidencePath = await writeEvidence(root, source, kind, evidenceEnvelope(source, kind, dataFor(kind)));
      const result = await adaptEvidence({ bundleRoot: root, source, kind, evidencePath: `${source}/input/${evidencePath}` });
      assert.equal(result.status, 'READY', `${command}/${kind} should be ready`);
      const verification = await verifyGeneratedArtifact({ bundleRoot: root, source, kind });
      assert.equal(verification.artifactStatus, 'PASS');
      const artifact = JSON.parse(await readFile(join(root, verification.artifactPath), 'utf8'));
      assert.equal(artifact.runId, runId);
      assert.equal(artifact.source, source);
      assert.equal(artifact.kind, kind);
    }
  });
});

test('runId, source and kind mismatches are blocked', async () => {
  await withBundle(async (root) => {
    const runIdEvidence = evidenceEnvelope('host', 'clock-reference', dataFor('clock-reference'), { runId: 'other-run' });
    const sourceEvidence = evidenceEnvelope('browser', 'clock-reference', dataFor('clock-reference'));
    const kindEvidence = evidenceEnvelope('host', 'rollback', dataFor('clock-reference'));
    for (const evidence of [runIdEvidence, sourceEvidence, kindEvidence]) {
      const evidencePath = await writeEvidence(root, 'host', 'external', evidence, 'mismatch.json');
      const result = await adaptEvidence({ bundleRoot: root, source: 'host', kind: 'clock-reference', evidencePath: `host/input/${evidencePath}` });
      assert.equal(result.status, 'BLOCKED');
    }
  });
});

test('hash mismatch, missing artifact and external path are blocked', async () => {
  await withBundle(async (root) => {
    const evidencePath = await writeEvidence(root, 'host', 'clock-reference', evidenceEnvelope('host', 'clock-reference', dataFor('clock-reference')));
    const ready = await adaptEvidence({ bundleRoot: root, source: 'host', kind: 'clock-reference', evidencePath: `host/input/${evidencePath}` });
    assert.equal(ready.status, 'READY');
    const artifactPath = join(root, ready.artifactPath);
    await writeFile(artifactPath, 'tampered\n', 'utf8');
    await assert.rejects(() => verifyGeneratedArtifact({ bundleRoot: root, source: 'host', kind: 'clock-reference' }), /SHA-256 mismatch/);
    await rm(artifactPath, { force: true });
    await assert.rejects(() => verifyGeneratedArtifact({ bundleRoot: root, source: 'host', kind: 'clock-reference' }), /missing/);
    const external = await adaptEvidence({ bundleRoot: root, source: 'host', kind: 'clock-reference', evidencePath: '../outside.json' });
    assert.equal(external.status, 'BLOCKED');
  });
});

test('stale evidence, inconsistent delta and missing internalHits are blocked', async () => {
  await withBundle(async (root) => {
    const stale = new Date(Date.now() - maxClockAgeMs - 1_000).toISOString();
    const staleEvidence = evidenceEnvelope('host', 'clock-reference', dataFor('clock-reference', stale), { observedAt: stale });
    const stalePath = await writeEvidence(root, 'host', 'clock-reference', staleEvidence, 'stale.json');
    assert.equal((await adaptEvidence({ bundleRoot: root, source: 'host', kind: 'clock-reference', evidencePath: `host/input/${stalePath}` })).status, 'BLOCKED');

    const delta = dataFor('egress-formal');
    delta.packetsDelta = 1;
    const deltaPath = await writeEvidence(root, 'gateway', 'egress-formal', evidenceEnvelope('gateway', 'egress-formal', delta), 'delta.json');
    assert.equal((await adaptEvidence({ bundleRoot: root, source: 'gateway', kind: 'egress-formal', evidencePath: `gateway/input/${deltaPath}` })).status, 'BLOCKED');

    const missingHits = dataFor('internal-hits');
    delete missingHits.result;
    const hitsPath = await writeEvidence(root, 'fixture', 'internal-hits', evidenceEnvelope('fixture', 'internal-hits', missingHits), 'hits.json');
    assert.equal((await adaptEvidence({ bundleRoot: root, source: 'fixture', kind: 'internal-hits', evidencePath: `fixture/input/${hitsPath}` })).status, 'BLOCKED');
  });
});

test('rollback without reversibility evidence and direct isolation route are blocked', async () => {
  await withBundle(async (root) => {
    const rollback = dataFor('rollback');
    delete rollback.reversibilityEvidence;
    const rollbackPath = await writeEvidence(root, 'host', 'rollback', evidenceEnvelope('host', 'rollback', rollback), 'rollback.json');
    assert.equal((await adaptEvidence({ bundleRoot: root, source: 'host', kind: 'rollback', evidencePath: `host/input/${rollbackPath}` })).status, 'BLOCKED');

    const isolation = dataFor('fixture-isolation');
    isolation.browserToFixtureDirectRoute = true;
    const isolationPath = await writeEvidence(root, 'browser', 'fixture-isolation', evidenceEnvelope('browser', 'fixture-isolation', isolation), 'isolation.json');
    assert.equal((await adaptEvidence({ bundleRoot: root, source: 'browser', kind: 'fixture-isolation', evidencePath: `browser/input/${isolationPath}` })).status, 'BLOCKED');
  });
});

test('marker self-reference is rejected by generated artifact verification', async () => {
  await withBundle(async (root) => {
    const evidencePath = await writeEvidence(root, 'host', 'clock-reference', evidenceEnvelope('host', 'clock-reference', dataFor('clock-reference')));
    const result = await adaptEvidence({ bundleRoot: root, source: 'host', kind: 'clock-reference', evidencePath: `host/input/${evidencePath}` });
    assert.equal(result.status, 'READY');
    const markerPath = join(root, result.marker);
    const marker = JSON.parse(await readFile(markerPath, 'utf8'));
    marker.artifact.path = result.marker;
    await writeJson(markerPath, marker);
    await assert.rejects(() => verifyGeneratedArtifact({ bundleRoot: root, source: 'host', kind: 'clock-reference' }), /forbidden file/);
  });
});
