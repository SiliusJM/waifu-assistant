import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const toolPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(toolPath), '..', '..');
const currentManifestName = (runId) => `${runId}.manifest.current.json`;
const initialManifestName = (runId) => `${runId}.manifest.initial.json`;
const finalManifestName = (runId) => `${runId}.manifest.final.json`;

const sourceFiles = Object.freeze([
  'scripts/phase-08-lab-bundle/run.mjs',
  'scripts/phase-08-browser-dns-rebinding-evidence/run.mjs',
  'scripts/phase-08-browser-dns-rebinding-evidence/classifier.mjs',
  'scripts/phase-08-egress-boundary-spike/run.mjs',
  'scripts/phase-08-gate-evidence/run.mjs',
  'scripts/phase-08-controlled-tests/run.mjs',
  'scripts/phase-08-controlled-tests/search-corpus.json',
]);

const lifecycleOrder = Object.freeze([
  'PREPARED',
  'PREFLIGHT_READY',
  'EXECUTE',
  'COLLECT',
  'VALIDATE',
  'CLEANUP',
  'FINAL-MANIFEST',
]);

const allowedStatuses = new Set(['PASS', 'FAIL', 'LIMITATION', 'NOT EXECUTED', 'SIMULATED']);
const secretKeyPattern = /(?:api[-_]?key|authorization|cookie|credential|password|private[-_]?key|secret|token)/i;

function printHelp() {
  console.log(`Phase 8 experimental lab bundle tooling

Commands:
  prepare       Create an integrity-checked run bundle and initial manifest.
  preflight     Validate readiness declarations without executing VMs.
  advance       Advance lifecycle: execute, collect, validate, cleanup, final-manifest.
  self-test     Run deterministic marker/artifact validation tests in a temporary directory.

Prepare options:
  --output-root <dir>       Existing or new directory outside the repository.
  --browser-version <text>  Browser VM/runtime version label.
  --gateway-version <text>  Gateway VM/runtime version label.
  --fixture-version <text>  Fixture VM/runtime version label.
  --config <file>           Optional non-secret JSON laboratory configuration.
  --max-clock-age-ms <n>    Freshness guard for the preflight clock declaration.

Other options:
  --bundle <dir>            Run bundle directory for preflight/advance.
  --state <name>            Target lifecycle state for advance.
  --help

This tool performs filesystem/hash/manifest work only. It does not launch VMs,
processes, shells, browsers, resolvers, firewalls or network fixtures.`);
}

function parseArgs(argv) {
  const [command = 'help', ...rest] = argv;
  const options = { command, values: {} };
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === '--help') return { command: 'help', values: {} };
    if (!argument.startsWith('--')) throw new Error(`Unexpected argument: ${argument}`);
    const name = argument.slice(2);
    const value = rest[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${name}`);
    options.values[name] = value;
    index += 1;
  }
  return options;
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

function assertOutsideRepository(path, label) {
  if (isWithin(path, repositoryRoot)) {
    throw new Error(`${label} must be outside the repository: ${path}`);
  }
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
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function readGitRevision() {
  const gitEntry = join(repositoryRoot, '.git');
  const gitStat = await stat(gitEntry);
  let gitDirectory = gitEntry;
  if (gitStat.isFile()) {
    const pointer = await readFile(gitEntry, 'utf8');
    const match = pointer.match(/^gitdir:\s*(.+)\s*$/m);
    if (!match) throw new Error('Unable to resolve the repository git directory');
    gitDirectory = resolve(repositoryRoot, match[1]);
  }

  const head = (await readFile(join(gitDirectory, 'HEAD'), 'utf8')).trim();
  if (!head.startsWith('ref: ')) return head;
  const reference = head.slice(5);
  const referencePath = join(gitDirectory, reference);
  if (await exists(referencePath)) return (await readFile(referencePath, 'utf8')).trim();
  const packedRefs = await readFile(join(gitDirectory, 'packed-refs'), 'utf8');
  const line = packedRefs.split(/\r?\n/).find((item) => item.endsWith(` ${reference}`));
  if (!line) throw new Error(`Unable to resolve git revision for ${reference}`);
  return line.split(' ')[0];
}

function assertNoSecrets(value, location = 'config') {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecrets(item, `${location}[${index}]`));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (secretKeyPattern.test(key)) throw new Error(`Secret-like configuration key is forbidden: ${location}.${key}`);
    assertNoSecrets(child, `${location}.${key}`);
  }
}

function nowIso() {
  return new Date().toISOString();
}

function createRunId() {
  const stamp = new Date().toISOString().replace(/[.:]/g, '').replace(/Z$/, 'Z');
  return `phase08-${stamp}-${randomUUID()}`;
}

function artifactName(runId, source, kind, extension = 'json') {
  return `${source}/evidence/${runId}.${source}.${kind}.${extension}`;
}

function preflightName(runId, source, kind) {
  return `${source}/preflight/${runId}.${source}.${kind}-ready.json`;
}

function buildLayout(runId) {
  const sources = ['host', 'browser', 'gateway', 'fixture'];
  const directories = {};
  for (const source of sources) {
    directories[source] = {
      root: `${source}/`,
      input: `${source}/input/`,
      preflight: `${source}/preflight/`,
      evidence: `${source}/evidence/`,
      logs: `${source}/logs/`,
      tmp: `${source}/tmp/`,
    };
  }

  return {
    directories,
    readiness: {
      clockReference: preflightName(runId, 'host', 'clock-reference'),
      countersBefore: preflightName(runId, 'gateway', 'counters-before'),
      dnsFormal: preflightName(runId, 'gateway', 'dns-formal'),
      egressFormal: preflightName(runId, 'gateway', 'egress-formal'),
      internalHits: preflightName(runId, 'fixture', 'internal-hits'),
      rollback: preflightName(runId, 'host', 'rollback'),
      browserFixtureIsolation: preflightName(runId, 'browser', 'fixture-isolation'),
    },
    evidence: {
      clockReference: artifactName(runId, 'host', 'clock-reference'),
      dnsFormal: artifactName(runId, 'gateway', 'dns-formal'),
      egressFormal: artifactName(runId, 'gateway', 'egress-formal'),
      internalHits: artifactName(runId, 'fixture', 'internal-hits'),
      browserNetlog: artifactName(runId, 'browser', 'netlog-summary'),
      cleanupInventory: artifactName(runId, 'host', 'cleanup-inventory'),
    },
  };
}

async function createDirectories(bundleRoot, layout) {
  await mkdir(bundleRoot, { recursive: true });
  for (const source of Object.values(layout.directories)) {
    for (const path of Object.values(source)) await mkdir(join(bundleRoot, path), { recursive: true });
  }
  await mkdir(join(bundleRoot, 'sources'), { recursive: true });
}

async function copyAndHashSources(bundleRoot) {
  const hashes = {};
  for (const source of sourceFiles) {
    const sourcePath = join(repositoryRoot, source);
    const destination = join(bundleRoot, 'sources', source);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(sourcePath, destination);
    const sourceHash = await sha256(sourcePath);
    const copiedHash = await sha256(destination);
    if (sourceHash !== copiedHash) throw new Error(`Source copy hash mismatch: ${source}`);
    hashes[source] = sourceHash;
  }
  return hashes;
}

async function loadSafeConfig(path) {
  if (!path) return { topology: 'browser-gateway-fixture-v1', directBrowserFixtureRoute: false };
  const config = await readJson(resolve(path));
  assertNoSecrets(config);
  return config;
}

async function writeCurrentManifest(bundleRoot, manifest) {
  await writeJson(join(bundleRoot, currentManifestName(manifest.runId)), manifest);
}

async function loadBundle(bundleOption) {
  const bundleRoot = resolve(requiredOption(bundleOption, 'bundle'));
  const manifestName = await findManifestName(bundleRoot, '.manifest.current.json');
  if (!manifestName) throw new Error(`No current manifest found in bundle: ${bundleRoot}`);
  return { bundleRoot, manifest: await readJson(join(bundleRoot, manifestName)) };
}

async function findManifestName(bundleRoot, suffix) {
  const { readdir } = await import('node:fs/promises');
  const names = await readdir(bundleRoot);
  return names.find((name) => name.endsWith(suffix));
}

function lifecycleEvent(state) {
  return { state, at: nowIso() };
}

function updateLifecycle(manifest, state) {
  manifest.lifecycle.push(lifecycleEvent(state));
  manifest.state = state;
  manifest.updatedAt = nowIso();
}

function relativeArtifactPath(bundleRoot, relativePath) {
  return join(bundleRoot, relativePath);
}

async function prepare(values) {
  const outputRoot = resolve(requiredOption(values, 'output-root'));
  assertOutsideRepository(outputRoot, 'Output root');
  const versions = {
    browser: requiredOption(values, 'browser-version'),
    gateway: requiredOption(values, 'gateway-version'),
    fixture: requiredOption(values, 'fixture-version'),
  };
  const maxClockAgeMs = Number(values['max-clock-age-ms'] ?? 120_000);
  if (!Number.isSafeInteger(maxClockAgeMs) || maxClockAgeMs <= 0) throw new Error('max-clock-age-ms must be a positive safe integer');

  const runId = createRunId();
  const bundleRoot = join(outputRoot, runId);
  const layout = buildLayout(runId);
  const config = await loadSafeConfig(values.config);
  await createDirectories(bundleRoot, layout);
  const scriptHashes = await copyAndHashSources(bundleRoot);
  const manifest = {
    schemaVersion: 1,
    runId,
    state: 'PREPARED',
    createdAt: nowIso(),
    updatedAt: nowIso(),
    repositoryRevision: await readGitRevision(),
    sourceRoot: 'sources/',
    scriptHashes,
    versions,
    config,
    policy: {
      maxClockAgeMs,
      directBrowserFixtureRouteRequired: false,
      rawNetlogDefault: 'DELETE_AFTER_FILTERING',
      noSecrets: true,
    },
    layout,
    manifests: {
      initial: initialManifestName(runId),
      current: currentManifestName(runId),
      final: finalManifestName(runId),
    },
    lifecycle: [lifecycleEvent('PREPARED')],
    preflight: { status: 'PENDING', checks: [], missing: [] },
    validation: { status: 'PENDING', checks: [], missing: [] },
    cleanup: { status: 'PENDING', checks: [], missing: [] },
    notes: [
      'Experimental preparation bundle only; no VM, process, shell or browser was executed by this tool.',
      'Readiness marker files are declarations from the dedicated laboratory, not evidence produced by this preparation command.',
      'The classifier and production source are copied for reference only and are never modified by this tool.',
      'Source copies are integrity-checked; lifecycle manifests remain intentionally mutable and are not filesystem read-only.',
      'Readiness artifact SHA-256 values provide integrity and run correlation, not cryptographic authenticity of the producing operator or lab.',
      'Cleanup verification is inventory-based; missing, limited or failed cleanup inventory blocks finalization.',
    ],
  };
  await writeJson(join(bundleRoot, initialManifestName(runId)), manifest);
  await writeCurrentManifest(bundleRoot, manifest);
  console.log(JSON.stringify({ status: 'PREPARED', runId, bundle: bundleRoot, manifest: manifest.manifests.current }, null, 2));
}

function assertRunId(value, manifest, label) {
  if (value !== manifest.runId) throw new Error(`${label} runId mismatch`);
}

function assertReadyMarker(marker, manifest, source, kind) {
  if (!marker || marker.ready !== true) throw new Error(`${source}/${kind} is not marked ready`);
  assertRunId(marker.runId, manifest, `${source}/${kind}`);
}

function assertNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} must be a non-empty string`);
}

function assertIso(value, label) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error(`${label} must be an ISO timestamp`);
}

function validateFreshness(observedAt, manifest, label) {
  assertIso(observedAt, `${label}.observedAt`);
  const ageMs = Date.now() - Date.parse(observedAt);
  if (ageMs < 0 || ageMs > manifest.policy.maxClockAgeMs) throw new Error(`${label}.observedAt is outside the configured freshness window`);
  return { status: 'PASS', observedAt, ageMs, maxAgeMs: manifest.policy.maxClockAgeMs };
}

function validateOutputContract(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} is invalid`);
  for (const field of fields) assertNonEmptyString(value[field], `${label}.${field}`);
}

function validateArtifactContract(artifact, source, kind) {
  if (kind === 'clock-reference') {
    assertNonEmptyString(artifact.producer, 'clock-reference.producer');
    assertIso(artifact.gatewayUtc, 'clock-reference.gatewayUtc');
    assertIso(artifact.browserUtc, 'clock-reference.browserUtc');
    if (!Number.isSafeInteger(artifact.maxOffsetMs) || artifact.maxOffsetMs < 0) throw new Error('clock-reference.maxOffsetMs is invalid');
    return { contract: 'clock-reference', producer: artifact.producer };
  }
  if (kind === 'counters-before') {
    if (!Number.isSafeInteger(artifact.packetsBefore) || artifact.packetsBefore < 0) throw new Error('counters-before.packetsBefore is invalid');
    if (!Number.isSafeInteger(artifact.bytesBefore) || artifact.bytesBefore < 0) throw new Error('counters-before.bytesBefore is invalid');
    assertNonEmptyString(artifact.counter, 'counters-before.counter');
    return { contract: 'counters-before', counter: artifact.counter };
  }
  if (kind === 'dns-formal') {
    if (artifact.formal !== true || artifact.canExportSequence !== true) throw new Error('dns-formal capability is invalid');
    assertNonEmptyString(artifact.dnsSource, 'dns-formal.dnsSource');
    validateOutputContract(artifact.outputContract, ['sequence', 'observedAt', 'address'], 'dns-formal.outputContract');
    return { contract: 'dns-formal', dnsSource: artifact.dnsSource };
  }
  if (kind === 'egress-formal') {
    if (artifact.differential !== true) throw new Error('egress-formal.differential is not true');
    assertNonEmptyString(artifact.counterSource, 'egress-formal.counterSource');
    assertNonEmptyString(artifact.destination, 'egress-formal.destination');
    validateOutputContract(artifact.outputContract, ['before', 'after', 'delta'], 'egress-formal.outputContract');
    return { contract: 'egress-formal', counterSource: artifact.counterSource };
  }
  if (kind === 'internal-hits') {
    if (artifact.independent !== true) throw new Error('internal-hits.independent is not true');
    assertNonEmptyString(artifact.measurementMethod, 'internal-hits.measurementMethod');
    if (!artifact.result || typeof artifact.result !== 'object' || Array.isArray(artifact.result)) throw new Error('internal-hits.result is invalid');
    if (!Number.isSafeInteger(artifact.result.internalHits) || artifact.result.internalHits < 0) throw new Error('internal-hits.result.internalHits is invalid');
    return { contract: 'internal-hits', measurementMethod: artifact.measurementMethod };
  }
  if (kind === 'rollback') {
    assertNonEmptyString(artifact.snapshotId, 'rollback.snapshotId');
    assertNonEmptyString(artifact.provider, 'rollback.provider');
    assertNonEmptyString(artifact.scope, 'rollback.scope');
    assertIso(artifact.createdAt, 'rollback.createdAt');
    assertNonEmptyString(artifact.reversibilityEvidence, 'rollback.reversibilityEvidence');
    return { contract: 'rollback', snapshotId: artifact.snapshotId };
  }
  if (kind === 'fixture-isolation') {
    assertNonEmptyString(artifact.topology, 'fixture-isolation.topology');
    assertNonEmptyString(artifact.verificationMethod, 'fixture-isolation.verificationMethod');
    if (artifact.browserToFixtureDirectRoute !== false) throw new Error('fixture-isolation direct route is not false');
    return { contract: 'fixture-isolation', topology: artifact.topology };
  }
  throw new Error(`Unsupported readiness artifact kind: ${source}/${kind}`);
}

async function validateArtifactBackedMarker(bundleRoot, manifest, markerRelativePath, source, kind) {
  const marker = await readJson(relativeArtifactPath(bundleRoot, markerRelativePath));
  assertReadyMarker(marker, manifest, source, kind);
  if (marker.source !== source) throw new Error(`${source}/${kind}.source mismatch`);
  if (marker.kind !== kind) throw new Error(`${source}/${kind}.kind mismatch`);
  assertIso(marker.observedAt, `${source}/${kind}.observedAt`);
  if (!marker.artifact || typeof marker.artifact !== 'object' || Array.isArray(marker.artifact)) throw new Error(`${source}/${kind}.artifact is invalid`);
  assertNonEmptyString(marker.artifact.id, `${source}/${kind}.artifact.id`);
  assertNonEmptyString(marker.artifact.path, `${source}/${kind}.artifact.path`);
  if (!/^[a-f0-9]{64}$/i.test(marker.artifact.sha256 ?? '')) throw new Error(`${source}/${kind}.artifact.sha256 is invalid`);
  if (isAbsolute(marker.artifact.path)) throw new Error(`${source}/${kind}.artifact.path must be relative`);

  const artifactPath = resolve(bundleRoot, marker.artifact.path);
  const sourceRoot = resolve(bundleRoot, source);
  const markerPath = resolve(bundleRoot, markerRelativePath);
  if (!isWithin(artifactPath, bundleRoot) || !isWithin(artifactPath, sourceRoot)) throw new Error(`${source}/${kind}.artifact.path is outside the expected source directory`);
  if (artifactPath === markerPath) throw new Error(`${source}/${kind}.artifact.path points to its own marker`);
  if (!(await exists(artifactPath))) throw new Error(`${source}/${kind}.artifact.path does not exist`);
  const [realBundleRoot, realSourceRoot, realArtifactPath, realMarkerPath] = await Promise.all([
    realpath(bundleRoot),
    realpath(sourceRoot),
    realpath(artifactPath),
    realpath(markerPath),
  ]);
  if (!isWithin(realArtifactPath, realBundleRoot) || !isWithin(realArtifactPath, realSourceRoot)) throw new Error(`${source}/${kind}.artifact.path resolves outside the expected source directory`);
  if (realArtifactPath === realMarkerPath) throw new Error(`${source}/${kind}.artifact.path resolves to its own marker`);

  const actualSha256 = await sha256(artifactPath);
  if (actualSha256 !== marker.artifact.sha256.toLowerCase()) throw new Error(`${source}/${kind}.artifact.sha256 mismatch`);
  const artifact = await readJson(artifactPath);
  if (artifact.schemaVersion !== 1) throw new Error(`${source}/${kind} artifact schemaVersion is invalid`);
  assertRunId(artifact.runId, manifest, `${source}/${kind} artifact`);
  if (artifact.source !== source) throw new Error(`${source}/${kind} artifact.source mismatch`);
  if (artifact.kind !== kind) throw new Error(`${source}/${kind} artifact.kind mismatch`);
  if (artifact.status !== 'PASS') throw new Error(`${source}/${kind} artifact.status must be PASS`);
  assertIso(artifact.observedAt, `${source}/${kind} artifact.observedAt`);
  if (marker.runId !== artifact.runId) throw new Error(`${source}/${kind} marker/artifact runId mismatch`);
  if (marker.source !== artifact.source) throw new Error(`${source}/${kind} marker/artifact source mismatch`);
  if (marker.kind !== artifact.kind) throw new Error(`${source}/${kind} marker/artifact kind mismatch`);
  if (marker.observedAt !== artifact.observedAt) throw new Error(`${source}/${kind} marker/artifact observedAt mismatch`);

  const freshness = validateFreshness(artifact.observedAt, manifest, `${source}/${kind} artifact`);
  const contract = validateArtifactContract(artifact, source, kind);
  return {
    marker: toPosixPath(markerRelativePath),
    artifactPath: toPosixPath(relative(bundleRoot, artifactPath)),
    artifactSha256: actualSha256,
    artifactStatus: artifact.status,
    freshness,
    validations: contract,
  };
}

async function runPreflight(bundleRoot, manifest) {
  const checks = [];
  const missing = [];
  const check = async (name, action) => {
    try {
      const details = await action();
      checks.push({ name, status: 'PASS', ...(details ?? {}) });
    } catch (error) {
      checks.push({ name, status: 'FAIL', reason: error.message });
      missing.push(name);
    }
  };

  for (const [source, hash] of Object.entries(manifest.scriptHashes)) {
    await check(`source hash ${source}`, async () => {
      const copied = await sha256(join(bundleRoot, 'sources', source));
      if (copied !== hash) throw new Error('copied source hash mismatch');
    });
  }
  const readiness = manifest.layout.readiness;
  const markerEntries = [
    ['fresh clocks', readiness.clockReference, 'host', 'clock-reference'],
    ['egress counters before', readiness.countersBefore, 'gateway', 'counters-before'],
    ['formal DNS capability', readiness.dnsFormal, 'gateway', 'dns-formal'],
    ['formal egress capability', readiness.egressFormal, 'gateway', 'egress-formal'],
    ['independent internalHits fixture', readiness.internalHits, 'fixture', 'internal-hits'],
    ['rollback snapshot', readiness.rollback, 'host', 'rollback'],
    ['Browser to Fixture isolation', readiness.browserFixtureIsolation, 'browser', 'fixture-isolation'],
  ];

  for (const [name, relativePath, source, kind] of markerEntries) {
    await check(name, async () => {
      const path = relativeArtifactPath(bundleRoot, relativePath);
      if (!(await exists(path))) throw new Error(`missing ${relativePath}`);
      return validateArtifactBackedMarker(bundleRoot, manifest, relativePath, source, kind);
    });
  }

  await check('non-secret configuration', () => assertNoSecrets(manifest.config));
  await check('no direct Browser to Fixture route', () => {
    if (manifest.config.directBrowserFixtureRoute !== false) throw new Error('config permits a direct Browser to Fixture route');
  });

  const status = missing.length === 0 ? 'READY' : 'BLOCKED';
  manifest.preflight = { status, checkedAt: nowIso(), checks, missing };
  manifest.updatedAt = nowIso();
  await writeCurrentManifest(bundleRoot, manifest);
  console.log(JSON.stringify({ status, runId: manifest.runId, missing, checks }, null, 2));
  return status === 'READY';
}

async function validateEvidenceFile(bundleRoot, manifest, relativePath, name) {
  const path = relativeArtifactPath(bundleRoot, relativePath);
  if (!(await exists(path))) throw new Error(`missing ${name}: ${relativePath}`);
  const evidence = await readJson(path);
  assertRunId(evidence.runId, manifest, name);
  if (!allowedStatuses.has(evidence.status)) throw new Error(`${name} has an invalid status`);
  return evidence;
}

async function validateCollectedEvidence(bundleRoot, manifest) {
  const checks = [];
  const missing = [];
  const evidence = manifest.layout.evidence;
  for (const [name, path] of Object.entries(evidence)) {
    if (name === 'cleanupInventory') continue;
    try {
      const item = await validateEvidenceFile(bundleRoot, manifest, path, name);
      checks.push({ name, status: 'PASS', evidenceStatus: item.status });
    } catch (error) {
      checks.push({ name, status: 'FAIL', reason: error.message });
      missing.push(name);
    }
  }
  const status = missing.length === 0 ? 'READY' : 'BLOCKED';
  manifest.validation = { status, checkedAt: nowIso(), checks, missing };
  manifest.updatedAt = nowIso();
  await writeCurrentManifest(bundleRoot, manifest);
  console.log(JSON.stringify({ status, runId: manifest.runId, missing, checks }, null, 2));
  return status === 'READY';
}

async function verifyCleanup(bundleRoot, manifest) {
  const path = relativeArtifactPath(bundleRoot, manifest.layout.evidence.cleanupInventory);
  const checks = [];
  const missing = [];
  try {
    const inventory = await validateEvidenceFile(bundleRoot, manifest, manifest.layout.evidence.cleanupInventory, 'cleanupInventory');
    if (inventory.status !== 'PASS') throw new Error(`cleanup inventory status is ${inventory.status}`);
    if (!Array.isArray(inventory.deletionFailures) || inventory.deletionFailures.length !== 0) {
      throw new Error('deletionFailures is not an empty array');
    }
    for (const field of ['remainingProcesses', 'remainingRules', 'remainingInterfaces', 'remainingProfiles', 'remainingTemporaries', 'unexplainedResources']) {
      if (!Array.isArray(inventory[field]) || inventory[field].length !== 0) throw new Error(`${field} is not empty`);
    }
    if (inventory.temporaryDirectoriesRemoved !== true) throw new Error('temporaryDirectoriesRemoved is not true');
    checks.push({ name: 'cleanup inventory', status: 'PASS' });
  } catch (error) {
    checks.push({ name: 'cleanup inventory', status: 'FAIL', reason: error.message });
    missing.push('cleanupInventory');
  }
  const status = missing.length === 0 ? 'READY' : 'BLOCKED';
  manifest.cleanup = { status, checkedAt: nowIso(), checks, missing };
  manifest.updatedAt = nowIso();
  await writeCurrentManifest(bundleRoot, manifest);
  console.log(JSON.stringify({ status, runId: manifest.runId, missing, checks, path }, null, 2));
  return status === 'READY';
}

async function revalidateBeforeExecute(bundleRoot, manifest) {
  return runPreflight(bundleRoot, manifest);
}

async function advance(values) {
  const { bundleRoot, manifest } = await loadBundle(values);
  const target = requiredOption(values, 'state').toUpperCase().replaceAll('_', '-');
  if (!lifecycleOrder.includes(target)) throw new Error(`Unsupported lifecycle state: ${target}`);
  const currentIndex = lifecycleOrder.indexOf(manifest.state);
  const targetIndex = lifecycleOrder.indexOf(target);
  if (targetIndex !== currentIndex + 1) throw new Error(`Invalid lifecycle transition ${manifest.state} -> ${target}`);

  if (target === 'PREFLIGHT_READY' && manifest.preflight.status !== 'READY') {
    throw new Error('PREFLIGHT_READY requires a successful preflight');
  }
  if (target === 'EXECUTE') {
    if (manifest.preflight.status !== 'READY') throw new Error('Execution is blocked until preflight is READY');
    const ready = await revalidateBeforeExecute(bundleRoot, manifest);
    if (!ready) {
      process.exitCode = 2;
      return;
    }
  }
  if (target === 'VALIDATE' && !(await validateCollectedEvidence(bundleRoot, manifest))) {
    updateLifecycle(manifest, target);
    await writeCurrentManifest(bundleRoot, manifest);
    process.exitCode = 2;
    return;
  }
  if (target === 'CLEANUP' && !(await verifyCleanup(bundleRoot, manifest))) {
    process.exitCode = 2;
    return;
  }

  updateLifecycle(manifest, target);
  await writeCurrentManifest(bundleRoot, manifest);
  if (target === 'FINAL-MANIFEST') await writeJson(join(bundleRoot, finalManifestName(manifest.runId)), manifest);
  console.log(JSON.stringify({ status: target, runId: manifest.runId, bundle: bundleRoot }, null, 2));
}

async function preflight(values) {
  const { bundleRoot, manifest } = await loadBundle(values);
  if (manifest.state !== 'PREPARED') throw new Error(`Preflight is only valid from PREPARED, not ${manifest.state}`);
  const ready = await runPreflight(bundleRoot, manifest);
  if (!ready) {
    process.exitCode = 2;
    return;
  }
  updateLifecycle(manifest, 'PREFLIGHT_READY');
  await writeCurrentManifest(bundleRoot, manifest);
}

function selfTestArtifact(runId, source, kind, observedAt) {
  const artifact = {
    schemaVersion: 1,
    runId,
    source,
    kind,
    status: 'PASS',
    observedAt,
    producer: 'phase-08-lab-bundle-self-test',
  };
  if (kind === 'clock-reference') Object.assign(artifact, { gatewayUtc: observedAt, browserUtc: observedAt, maxOffsetMs: 1 });
  if (kind === 'counters-before') Object.assign(artifact, { packetsBefore: 1, bytesBefore: 2, counter: 'self-test-counter' });
  if (kind === 'dns-formal') Object.assign(artifact, {
    formal: true,
    canExportSequence: true,
    dnsSource: 'self-test-dns',
    outputContract: { sequence: 'sequence', observedAt: 'observedAt', address: 'address' },
  });
  if (kind === 'egress-formal') Object.assign(artifact, {
    differential: true,
    counterSource: 'self-test-counter',
    destination: 'self-test-destination',
    outputContract: { before: 'before', after: 'after', delta: 'delta' },
  });
  if (kind === 'internal-hits') Object.assign(artifact, {
    independent: true,
    measurementMethod: 'self-test-fixture-counter',
    result: { internalHits: 0 },
  });
  if (kind === 'rollback') Object.assign(artifact, {
    snapshotId: `${runId}-snapshot`,
    provider: 'self-test-snapshot-provider',
    scope: 'self-test-bundle',
    createdAt: observedAt,
    reversibilityEvidence: 'self-test-reversibility-record',
  });
  if (kind === 'fixture-isolation') Object.assign(artifact, {
    topology: 'self-test-topology',
    verificationMethod: 'self-test-route-record',
    browserToFixtureDirectRoute: false,
  });
  return artifact;
}

async function createSelfTestBundle(bundleRoot) {
  const runId = 'phase08-self-test-run';
  const layout = buildLayout(runId);
  const observedAt = new Date().toISOString();
  const manifest = {
    schemaVersion: 1,
    runId,
    state: 'PREPARED',
    createdAt: observedAt,
    updatedAt: observedAt,
    scriptHashes: {},
    config: { topology: 'self-test-topology', directBrowserFixtureRoute: false },
    policy: { maxClockAgeMs: 120_000 },
    layout,
    preflight: { status: 'PENDING', checks: [], missing: [] },
    validation: { status: 'PENDING', checks: [], missing: [] },
    cleanup: { status: 'PENDING', checks: [], missing: [] },
    lifecycle: [{ state: 'PREPARED', at: observedAt }],
  };
  await createDirectories(bundleRoot, layout);
  for (const [name, markerRelativePath, source, kind] of [
    ['clockReference', layout.readiness.clockReference, 'host', 'clock-reference'],
    ['countersBefore', layout.readiness.countersBefore, 'gateway', 'counters-before'],
    ['dnsFormal', layout.readiness.dnsFormal, 'gateway', 'dns-formal'],
    ['egressFormal', layout.readiness.egressFormal, 'gateway', 'egress-formal'],
    ['internalHits', layout.readiness.internalHits, 'fixture', 'internal-hits'],
    ['rollback', layout.readiness.rollback, 'host', 'rollback'],
    ['browserFixtureIsolation', layout.readiness.browserFixtureIsolation, 'browser', 'fixture-isolation'],
  ]) {
    const artifactRelativePath = `${source}/input/${runId}.${source}.${kind}.json`;
    const artifact = selfTestArtifact(runId, source, kind, observedAt);
    await writeJson(join(bundleRoot, artifactRelativePath), artifact);
    const marker = {
      schemaVersion: 1,
      runId,
      ready: true,
      source,
      kind,
      observedAt,
      artifact: {
        id: `${runId}-${source}-${kind}`,
        path: artifactRelativePath,
        sha256: await sha256(join(bundleRoot, artifactRelativePath)),
      },
    };
    await writeJson(join(bundleRoot, markerRelativePath), marker);
    manifest.layout.readiness[name] = markerRelativePath;
  }
  await writeCurrentManifest(bundleRoot, manifest);
  return { runId, manifest };
}

async function mutateSelfTestArtifact(bundleRoot, manifest, source, kind, mutate, updateMarkerHash = true) {
  const markerRelativePath = manifest.layout.readiness[{
    'clock-reference': 'clockReference',
    'counters-before': 'countersBefore',
    'dns-formal': 'dnsFormal',
    'egress-formal': 'egressFormal',
    'internal-hits': 'internalHits',
    rollback: 'rollback',
    'fixture-isolation': 'browserFixtureIsolation',
  }[kind]];
  const markerPath = join(bundleRoot, markerRelativePath);
  const marker = await readJson(markerPath);
  const artifactPath = join(bundleRoot, marker.artifact.path);
  const artifact = await readJson(artifactPath);
  await mutate(artifact, marker);
  await writeJson(artifactPath, artifact);
  if (updateMarkerHash) marker.artifact.sha256 = await sha256(artifactPath);
  await writeJson(markerPath, marker);
}

async function runSelfTestCase(parent, name, mutate, expectedReady) {
  const bundleRoot = join(parent, name);
  const { manifest } = await createSelfTestBundle(bundleRoot);
  if (mutate) await mutate(bundleRoot, manifest);
  const ready = await runPreflight(bundleRoot, manifest);
  assert.equal(ready, expectedReady, `${name} readiness mismatch`);
  if (ready) {
    updateLifecycle(manifest, 'PREFLIGHT_READY');
    await writeCurrentManifest(bundleRoot, manifest);
    assert.equal(manifest.state, 'PREFLIGHT_READY');
  }
  return { name, status: expectedReady ? 'PASS' : 'BLOCKED' };
}

async function runExecuteRevalidationCase(parent, name, mutate, expectedReady, expectedMissing) {
  const bundleRoot = join(parent, name);
  const { manifest } = await createSelfTestBundle(bundleRoot);
  assert.equal(await runPreflight(bundleRoot, manifest), true, `${name} initial preflight should pass`);
  updateLifecycle(manifest, 'PREFLIGHT_READY');
  await writeCurrentManifest(bundleRoot, manifest);
  if (mutate) await mutate(bundleRoot, manifest);

  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  await advance({ bundle: bundleRoot, state: 'execute' });
  const exitCode = process.exitCode ?? 0;
  process.exitCode = previousExitCode;

  const current = await readJson(join(bundleRoot, currentManifestName(manifest.runId)));
  assert.equal(exitCode, expectedReady ? 0 : 2, `${name} exit code mismatch`);
  assert.equal(current.state, expectedReady ? 'EXECUTE' : 'PREFLIGHT_READY', `${name} lifecycle state mismatch`);
  assert.equal(current.lifecycle.some((event) => event.state === 'EXECUTE'), expectedReady, `${name} must not skip or enter EXECUTE incorrectly`);
  if (expectedReady) {
    assert.equal(current.preflight.status, 'READY');
  } else {
    assert.equal(current.preflight.status, 'BLOCKED');
    assert.ok(current.preflight.missing.includes(expectedMissing), `${name} should identify ${expectedMissing}`);
  }
  return { name, status: expectedReady ? 'EXECUTE_ALLOWED' : 'EXECUTE_BLOCKED', exitCode };
}

async function selfTest() {
  const root = await mkdtemp(join(tmpdir(), 'phase08-lab-bundle-self-test-'));
  const results = [];
  try {
    results.push(await runSelfTestCase(root, 'valid', null, true));
    results.push(await runSelfTestCase(root, 'hash-mismatch', async (bundleRoot, manifest) => {
      await mutateSelfTestArtifact(bundleRoot, manifest, 'gateway', 'dns-formal', async (_artifact, marker) => {
        marker.artifact.sha256 = '0'.repeat(64);
      }, false);
    }, false));
    results.push(await runSelfTestCase(root, 'path-outside-bundle', async (bundleRoot, manifest) => {
      await mutateSelfTestArtifact(bundleRoot, manifest, 'host', 'clock-reference', async (_artifact, marker) => {
        marker.artifact.path = '../outside.json';
      }, false);
    }, false));
    results.push(await runSelfTestCase(root, 'artifact-absent', async (bundleRoot, manifest) => {
      await mutateSelfTestArtifact(bundleRoot, manifest, 'gateway', 'egress-formal', async (_artifact, marker) => {
        marker.artifact.path = 'gateway/input/missing.json';
      }, false);
    }, false));
    results.push(await runSelfTestCase(root, 'run-id-mismatch', async (bundleRoot, manifest) => {
      await mutateSelfTestArtifact(bundleRoot, manifest, 'fixture', 'internal-hits', async (artifact) => {
        artifact.runId = 'other-run';
      });
    }, false));
    results.push(await runSelfTestCase(root, 'stale-artifact', async (bundleRoot, manifest) => {
      await mutateSelfTestArtifact(bundleRoot, manifest, 'host', 'clock-reference', async (artifact) => {
        const stale = new Date(Date.now() - 121_000).toISOString();
        artifact.observedAt = stale;
        artifact.gatewayUtc = stale;
        artifact.browserUtc = stale;
      });
      const markerPath = join(bundleRoot, manifest.layout.readiness.clockReference);
      const marker = await readJson(markerPath);
      marker.observedAt = (await readJson(join(bundleRoot, marker.artifact.path))).observedAt;
      await writeJson(markerPath, marker);
    }, false));
    results.push(await runSelfTestCase(root, 'schema-invalid', async (bundleRoot, manifest) => {
      await mutateSelfTestArtifact(bundleRoot, manifest, 'browser', 'fixture-isolation', async (artifact) => {
        artifact.schemaVersion = 2;
      });
    }, false));
    results.push(await runSelfTestCase(root, 'marker-self-reference', async (bundleRoot, manifest) => {
      await mutateSelfTestArtifact(bundleRoot, manifest, 'host', 'rollback', async (_artifact, marker) => {
        marker.artifact.path = manifest.layout.readiness.rollback;
      }, false);
    }, false));
    results.push(await runExecuteRevalidationCase(root, 'execute-intact', null, true));
    results.push(await runExecuteRevalidationCase(root, 'execute-artifact-modified', async (bundleRoot, manifest) => {
      await mutateSelfTestArtifact(bundleRoot, manifest, 'gateway', 'dns-formal', async (artifact) => {
        artifact.changedAfterPreflight = true;
      }, false);
    }, false, 'formal DNS capability'));
    results.push(await runExecuteRevalidationCase(root, 'execute-marker-modified', async (bundleRoot, manifest) => {
      const markerPath = join(bundleRoot, manifest.layout.readiness.dnsFormal);
      const marker = await readJson(markerPath);
      marker.ready = false;
      await writeJson(markerPath, marker);
    }, false, 'formal DNS capability'));
    results.push(await runExecuteRevalidationCase(root, 'execute-artifact-deleted', async (bundleRoot, manifest) => {
      const marker = await readJson(join(bundleRoot, manifest.layout.readiness.egressFormal));
      await rm(join(bundleRoot, marker.artifact.path), { force: true });
    }, false, 'formal egress capability'));
    results.push(await runExecuteRevalidationCase(root, 'execute-stale-artifact', async (bundleRoot, manifest) => {
      const markerPath = join(bundleRoot, manifest.layout.readiness.clockReference);
      const marker = await readJson(markerPath);
      const artifactPath = join(bundleRoot, marker.artifact.path);
      const artifact = await readJson(artifactPath);
      const stale = new Date(Date.now() - 121_000).toISOString();
      artifact.observedAt = stale;
      artifact.gatewayUtc = stale;
      artifact.browserUtc = stale;
      await writeJson(artifactPath, artifact);
      marker.observedAt = stale;
      marker.artifact.sha256 = await sha256(artifactPath);
      await writeJson(markerPath, marker);
    }, false, 'fresh clocks'));
    console.log(JSON.stringify({ status: 'PASS', cases: results }, null, 2));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === 'help') {
    printHelp();
    return;
  }
  if (options.command === 'prepare') await prepare(options.values);
  else if (options.command === 'preflight') await preflight(options.values);
  else if (options.command === 'advance') await advance(options.values);
  else if (options.command === 'self-test') await selfTest();
  else throw new Error(`Unknown command: ${options.command}`);
}

try {
  await main();
} catch (error) {
  console.error(`phase-08-lab-bundle: ${error.message}`);
  process.exitCode = 1;
}
