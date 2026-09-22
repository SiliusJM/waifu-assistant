import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

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

function assertIso(value, label) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error(`${label} must be an ISO timestamp`);
}

function validateClockMarker(marker, manifest) {
  assertReadyMarker(marker, manifest, 'host', 'clock-reference');
  if (marker.fresh !== true) throw new Error('clock-reference is not fresh');
  assertIso(marker.observedAt, 'clock-reference.observedAt');
  assertIso(marker.gatewayUtc, 'clock-reference.gatewayUtc');
  assertIso(marker.browserUtc, 'clock-reference.browserUtc');
  if (!Number.isSafeInteger(marker.maxOffsetMs) || marker.maxOffsetMs < 0) throw new Error('clock-reference.maxOffsetMs is invalid');
  const age = Date.now() - Date.parse(marker.observedAt);
  if (age < 0 || age > manifest.policy.maxClockAgeMs) throw new Error('clock-reference is outside the configured freshness window');
}

function validateCounterMarker(marker, manifest) {
  assertReadyMarker(marker, manifest, 'gateway', 'counters-before');
  if (marker.captured !== true) throw new Error('counters-before is not captured');
  if (!Number.isSafeInteger(marker.packetsBefore) || marker.packetsBefore < 0) throw new Error('packetsBefore is invalid');
  if (!Number.isSafeInteger(marker.bytesBefore) || marker.bytesBefore < 0) throw new Error('bytesBefore is invalid');
  assertIso(marker.observedAt, 'counters-before.observedAt');
}

function validateReadinessMarker(marker, manifest, source, kind, predicate) {
  assertReadyMarker(marker, manifest, source, kind);
  if (!predicate(marker)) throw new Error(`${source}/${kind} does not satisfy its readiness contract`);
}

async function runPreflight(bundleRoot, manifest) {
  const checks = [];
  const missing = [];
  const check = async (name, action) => {
    try {
      await action();
      checks.push({ name, status: 'PASS' });
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
    ['fresh clocks', readiness.clockReference, 'host', 'clock-reference', validateClockMarker],
    ['egress counters before', readiness.countersBefore, 'gateway', 'counters-before', validateCounterMarker],
    ['formal DNS capability', readiness.dnsFormal, 'gateway', 'dns-formal', (marker) => marker.formal === true && marker.canExportSequence === true],
    ['formal egress capability', readiness.egressFormal, 'gateway', 'egress-formal', (marker) => marker.formal === true && marker.differential === true && marker.canExportDelta === true],
    ['independent internalHits fixture', readiness.internalHits, 'fixture', 'internal-hits', (marker) => marker.independent === true && marker.canMeasure === true],
    ['rollback snapshot', readiness.rollback, 'host', 'rollback', (marker) => marker.reversible === true && typeof marker.snapshotId === 'string' && marker.snapshotId.length > 0],
    ['Browser to Fixture isolation', readiness.browserFixtureIsolation, 'browser', 'fixture-isolation', (marker) => marker.verified === true && marker.browserToFixtureDirectRoute === false],
  ];

  for (const [name, relativePath, source, kind, predicate] of markerEntries) {
    await check(name, async () => {
      const path = relativeArtifactPath(bundleRoot, relativePath);
      if (!(await exists(path))) throw new Error(`missing ${relativePath}`);
      const marker = await readJson(path);
      if (kind === 'clock-reference') validateClockMarker(marker, manifest);
      else if (kind === 'counters-before') validateCounterMarker(marker, manifest);
      else validateReadinessMarker(marker, manifest, source, kind, predicate);
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
  if (target === 'EXECUTE' && manifest.preflight.status !== 'READY') throw new Error('Execution is blocked until preflight is READY');
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

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === 'help') {
    printHelp();
    return;
  }
  if (options.command === 'prepare') await prepare(options.values);
  else if (options.command === 'preflight') await preflight(options.values);
  else if (options.command === 'advance') await advance(options.values);
  else throw new Error(`Unknown command: ${options.command}`);
}

try {
  await main();
} catch (error) {
  console.error(`phase-08-lab-bundle: ${error.message}`);
  process.exitCode = 1;
}
