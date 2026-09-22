import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const adapterPath = fileURLToPath(import.meta.url);
const allowedGatewayKinds = new Set(['counters-before', 'dns-formal', 'egress-formal']);
const allowedCommands = new Map([
  ['clock', { source: 'host', kind: 'clock-reference' }],
  ['fixture', { source: 'fixture', kind: 'internal-hits' }],
  ['rollback', { source: 'host', kind: 'rollback' }],
  ['isolation', { source: 'browser', kind: 'fixture-isolation' }],
]);

function printHelp() {
  console.log(`Phase 8 readiness artifact adapter

Commands:
  clock       Adapt host clock-reference evidence.
  gateway     Adapt gateway counters-before, dns-formal or egress-formal evidence.
  fixture     Adapt independent fixture internal-hits evidence.
  rollback    Adapt externally produced rollback/snapshot evidence.
  isolation   Adapt Browser to Fixture isolation evidence.

Options:
  --bundle <dir>       Prepared bundle directory.
  --evidence <path>    Relative evidence JSON path inside the expected source directory.
  --kind <name>        Required for gateway: counters-before, dns-formal or egress-formal.

The adapter reads evidence only. It never starts a VM, browser, fixture, shell or process.
SHA-256 binds generated markers to files but does not authenticate their producer.`);
}

function parseArgs(argv) {
  const [command = 'help', ...rest] = argv;
  const values = {};
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === '--help') return { command: 'help', values: {} };
    if (!argument.startsWith('--')) throw new Error(`Unexpected argument: ${argument}`);
    const name = argument.slice(2);
    const value = rest[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${name}`);
    values[name] = value;
    index += 1;
  }
  return { command, values };
}

function requiredOption(values, name) {
  const value = values[name];
  if (!value || value.trim() === '') throw new Error(`Missing required option --${name}`);
  return value;
}

function toPosixPath(value) {
  return value.split(sep).join('/');
}

function isWithin(child, parent) {
  const candidate = resolve(child);
  const root = resolve(parent);
  const childRelative = relative(root, candidate);
  return childRelative === '' || (!childRelative.startsWith(`..${sep}`) && childRelative !== '..');
}

function assertNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} must be a non-empty string`);
}

function assertIso(value, label) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error(`${label} must be an ISO timestamp`);
}

function assertSafeInteger(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${label} is invalid`);
}

function nowIso() {
  return new Date().toISOString();
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function findCurrentManifest(bundleRoot) {
  const names = await readdir(bundleRoot);
  const matches = names.filter((name) => name.endsWith('.manifest.current.json'));
  if (matches.length !== 1) throw new Error('bundle must contain exactly one current manifest');
  return join(bundleRoot, matches[0]);
}

async function loadBundle(bundleOption) {
  const bundleRoot = resolve(bundleOption);
  const manifestPath = await findCurrentManifest(bundleRoot);
  const manifest = await readJson(manifestPath);
  assertNonEmptyString(manifest.runId, 'manifest.runId');
  if (!manifest.policy || !Number.isSafeInteger(manifest.policy.maxClockAgeMs) || manifest.policy.maxClockAgeMs <= 0) {
    throw new Error('manifest.policy.maxClockAgeMs is invalid');
  }
  return { bundleRoot, manifest };
}

function resolveExpectedCommand(command, kind) {
  if (command === 'gateway') {
    if (!allowedGatewayKinds.has(kind)) throw new Error(`Unsupported gateway kind: ${kind}`);
    return { source: 'gateway', kind };
  }
  const expected = allowedCommands.get(command);
  if (!expected) throw new Error(`Unsupported adapter command: ${command}`);
  if (kind && kind !== expected.kind) throw new Error(`${command} does not accept kind ${kind}`);
  return expected;
}

function canonicalArtifactPath(runId, source, kind) {
  return `${source}/input/${runId}.${source}.${kind}.json`;
}

function markerPath(runId, source, kind) {
  return `${source}/preflight/${runId}.${source}.${kind}-ready.json`;
}

function safeBundlePath(bundleRoot, rawPath, expectedSource, label, forbiddenPaths = []) {
  assertNonEmptyString(rawPath, `${label}.path`);
  if (isAbsolute(rawPath)) throw new Error(`${label}.path must be relative to the bundle`);
  const absolutePath = resolve(bundleRoot, rawPath);
  const sourceRoot = resolve(bundleRoot, expectedSource);
  if (!isWithin(absolutePath, bundleRoot) || !isWithin(absolutePath, sourceRoot)) {
    throw new Error(`${label}.path is outside the expected source directory`);
  }
  for (const forbiddenPath of forbiddenPaths) {
    if (absolutePath === resolve(bundleRoot, forbiddenPath)) throw new Error(`${label}.path points to a forbidden file`);
  }
  return { absolutePath, relativePath: toPosixPath(relative(bundleRoot, absolutePath)) };
}

function validateFreshness(observedAt, manifest, label) {
  assertIso(observedAt, `${label}.observedAt`);
  const ageMs = Date.now() - Date.parse(observedAt);
  if (ageMs < 0 || ageMs > manifest.policy.maxClockAgeMs) throw new Error(`${label}.observedAt is outside the freshness window`);
  return { status: 'PASS', observedAt, ageMs, maxAgeMs: manifest.policy.maxClockAgeMs };
}

function validateOutputContract(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} is invalid`);
  for (const field of fields) assertNonEmptyString(value[field], `${label}.${field}`);
}

function validateContract(source, kind, data) {
  const output = { ...data };
  if (kind === 'clock-reference') {
    assertIso(output.gatewayUtc, 'clock-reference.gatewayUtc');
    assertIso(output.browserUtc, 'clock-reference.browserUtc');
    assertSafeInteger(output.maxOffsetMs, 'clock-reference.maxOffsetMs');
    return output;
  }
  if (kind === 'counters-before') {
    if (output.captured !== true) throw new Error('counters-before.captured must be true');
    assertSafeInteger(output.packetsBefore, 'counters-before.packetsBefore');
    assertSafeInteger(output.bytesBefore, 'counters-before.bytesBefore');
    assertNonEmptyString(output.counter, 'counters-before.counter');
    return output;
  }
  if (kind === 'dns-formal') {
    if (output.formal !== true || output.canExportSequence !== true) throw new Error('dns-formal capability is incomplete');
    assertNonEmptyString(output.dnsSource, 'dns-formal.dnsSource');
    validateOutputContract(output.outputContract, ['sequence', 'observedAt', 'address'], 'dns-formal.outputContract');
    if (!Array.isArray(output.sequence) || output.sequence.length === 0) throw new Error('dns-formal.sequence is missing');
    output.sequence.forEach((item, index) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`dns-formal.sequence[${index}] is invalid`);
      assertSafeInteger(item.sequence, `dns-formal.sequence[${index}].sequence`, 1);
      assertIso(item.observedAt, `dns-formal.sequence[${index}].observedAt`);
    });
    return output;
  }
  if (kind === 'egress-formal') {
    if (output.differential !== true) throw new Error('egress-formal.differential must be true');
    assertNonEmptyString(output.counterSource, 'egress-formal.counterSource');
    assertNonEmptyString(output.destination, 'egress-formal.destination');
    assertIso(output.beforeObservedAt, 'egress-formal.beforeObservedAt');
    assertIso(output.afterObservedAt, 'egress-formal.afterObservedAt');
    if (Date.parse(output.afterObservedAt) < Date.parse(output.beforeObservedAt)) throw new Error('egress-formal counter timestamps are inconsistent');
    validateOutputContract(output.outputContract, ['before', 'after', 'delta'], 'egress-formal.outputContract');
    for (const field of ['packetsBefore', 'packetsAfter', 'packetsDelta', 'bytesBefore', 'bytesAfter', 'bytesDelta']) assertSafeInteger(output[field], `egress-formal.${field}`);
    if (output.packetsAfter < output.packetsBefore || output.packetsDelta !== output.packetsAfter - output.packetsBefore || output.packetsDelta <= 0) {
      throw new Error('egress-formal packet delta is inconsistent');
    }
    if (output.bytesAfter < output.bytesBefore || output.bytesDelta !== output.bytesAfter - output.bytesBefore) {
      throw new Error('egress-formal byte delta is inconsistent');
    }
    return output;
  }
  if (kind === 'internal-hits') {
    if (output.independent !== true) throw new Error('internal-hits.independent must be true');
    assertNonEmptyString(output.measurementMethod, 'internal-hits.measurementMethod');
    const result = output.result ?? (Number.isSafeInteger(output.internalHits) ? { internalHits: output.internalHits } : null);
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('internal-hits.result is missing');
    assertSafeInteger(result.internalHits, 'internal-hits.result.internalHits');
    return { ...output, result };
  }
  if (kind === 'rollback') {
    assertNonEmptyString(output.snapshotId, 'rollback.snapshotId');
    assertNonEmptyString(output.provider, 'rollback.provider');
    assertNonEmptyString(output.scope, 'rollback.scope');
    assertIso(output.createdAt, 'rollback.createdAt');
    assertNonEmptyString(output.reversibilityEvidence, 'rollback.reversibilityEvidence');
    return output;
  }
  if (kind === 'fixture-isolation') {
    assertNonEmptyString(output.topology, 'fixture-isolation.topology');
    assertNonEmptyString(output.verificationMethod, 'fixture-isolation.verificationMethod');
    if (output.browserToFixtureDirectRoute !== false) throw new Error('fixture-isolation direct route must be false');
    return output;
  }
  throw new Error(`Unsupported contract: ${source}/${kind}`);
}

function validateExternalEvidence(input, manifest, source, kind) {
  if (input.schemaVersion !== 1) throw new Error('evidence.schemaVersion must be 1');
  if (input.runId !== manifest.runId) throw new Error('evidence.runId mismatch');
  if (input.source !== source) throw new Error('evidence.source mismatch');
  if (input.kind !== kind) throw new Error('evidence.kind mismatch');
  if (input.status !== 'PASS') throw new Error('evidence.status must be PASS');
  assertNonEmptyString(input.producer, 'evidence.producer');
  const freshness = validateFreshness(input.observedAt, manifest, 'evidence');
  if (!input.data || typeof input.data !== 'object' || Array.isArray(input.data)) throw new Error('evidence.data is missing');
  const data = validateContract(source, kind, input.data);
  return { ...data, schemaVersion: 1, runId: manifest.runId, source, kind, status: 'PASS', observedAt: input.observedAt, producer: input.producer, freshness };
}

async function verifyMarkerReference(bundleRoot, manifest, markerRelativePath, source, kind) {
  const markerFile = resolve(bundleRoot, markerRelativePath);
  const marker = await readJson(markerFile);
  if (marker.schemaVersion !== 1 || marker.runId !== manifest.runId || marker.ready !== true) throw new Error('generated marker envelope is invalid');
  if (marker.source !== source || marker.kind !== kind || marker.observedAt === undefined) throw new Error('generated marker identity is invalid');
  if (!marker.artifact || typeof marker.artifact !== 'object') throw new Error('generated marker artifact reference is missing');
  assertNonEmptyString(marker.artifact.id, 'generated marker artifact.id');
  const artifactRef = safeBundlePath(bundleRoot, marker.artifact.path, source, 'generated marker artifact', [markerRelativePath]);
  if (!/^[a-f0-9]{64}$/i.test(marker.artifact.sha256 ?? '')) throw new Error('generated marker artifact.sha256 is invalid');
  if (!(await exists(artifactRef.absolutePath))) throw new Error('generated artifact is missing');
  const actualSha256 = await sha256(artifactRef.absolutePath);
  if (actualSha256 !== marker.artifact.sha256.toLowerCase()) throw new Error('generated artifact SHA-256 mismatch');
  const artifact = await readJson(artifactRef.absolutePath);
  if (artifact.schemaVersion !== 1 || artifact.runId !== manifest.runId || artifact.source !== source || artifact.kind !== kind || artifact.status !== 'PASS') {
    throw new Error('generated artifact envelope is invalid');
  }
  if (artifact.observedAt !== marker.observedAt) throw new Error('generated marker/artifact observedAt mismatch');
  const freshness = validateFreshness(artifact.observedAt, manifest, 'generated artifact');
  validateContract(source, kind, artifact);
  return {
    marker: toPosixPath(markerRelativePath),
    artifactPath: artifactRef.relativePath,
    artifactSha256: actualSha256,
    artifactStatus: artifact.status,
    freshness,
  };
}

async function invalidateGeneratedOutput(bundleRoot, runId, source, kind) {
  await rm(resolve(bundleRoot, canonicalArtifactPath(runId, source, kind)), { force: true });
  await rm(resolve(bundleRoot, markerPath(runId, source, kind)), { force: true });
}

export async function verifyGeneratedArtifact(options) {
  const { bundleRoot, manifest } = await loadBundle(options.bundleRoot);
  return verifyMarkerReference(bundleRoot, manifest, markerPath(manifest.runId, options.source, options.kind), options.source, options.kind);
}

export async function adaptEvidence({ bundleRoot: bundleOption, source, kind, evidencePath }) {
  let bundleRoot;
  let manifest;
  try {
    ({ bundleRoot, manifest } = await loadBundle(bundleOption));
    const expected = resolveExpectedCommand(source === 'gateway' ? 'gateway' : ({
      'clock-reference': 'clock',
      'internal-hits': 'fixture',
      rollback: 'rollback',
      'fixture-isolation': 'isolation',
    }[kind]), kind);
    if (expected.source !== source || expected.kind !== kind) throw new Error('source/kind combination is invalid');
    const outputRelativePath = canonicalArtifactPath(manifest.runId, source, kind);
    const outputMarkerPath = markerPath(manifest.runId, source, kind);
    const evidenceRef = safeBundlePath(bundleRoot, evidencePath, source, 'evidence', [outputRelativePath, outputMarkerPath]);
    if (!(await exists(evidenceRef.absolutePath))) throw new Error('external evidence file is missing');
    const evidence = await readJson(evidenceRef.absolutePath);
    const artifact = validateExternalEvidence(evidence, manifest, source, kind);
    await writeJson(resolve(bundleRoot, outputRelativePath), artifact);
    const artifactSha256 = await sha256(resolve(bundleRoot, outputRelativePath));
    const marker = {
      schemaVersion: 1,
      runId: manifest.runId,
      ready: true,
      source,
      kind,
      observedAt: artifact.observedAt,
      artifact: {
        id: `${manifest.runId}-${source}-${kind}`,
        path: outputRelativePath,
        sha256: artifactSha256,
      },
    };
    await writeJson(resolve(bundleRoot, outputMarkerPath), marker);
    const verification = await verifyMarkerReference(bundleRoot, manifest, outputMarkerPath, source, kind);
    return { status: 'READY', runId: manifest.runId, source, kind, ...verification };
  } catch (error) {
    if (bundleRoot && manifest && source && kind) await invalidateGeneratedOutput(bundleRoot, manifest.runId, source, kind).catch(() => undefined);
    return { status: 'BLOCKED', source, kind, reason: error.message };
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.command === 'help') {
    printHelp();
    return { status: 'HELP' };
  }
  const expected = resolveExpectedCommand(options.command, options.values.kind);
  const result = await adaptEvidence({
    bundleRoot: requiredOption(options.values, 'bundle'),
    evidencePath: requiredOption(options.values, 'evidence'),
    source: expected.source,
    kind: expected.kind,
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.status === 'BLOCKED') process.exitCode = 2;
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === adapterPath) {
  try {
    await main();
  } catch (error) {
    console.error(`phase-08-readiness-adapter: ${error.message}`);
    process.exitCode = 1;
  }
}
