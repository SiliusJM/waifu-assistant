import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const DEFAULTS = Object.freeze({
  hostname: 'rebind.test',
  publicIp: '1.1.1.1',
  privateIp: '10.20.0.1',
  timeoutMs: 10_000,
});

function parseArgs(argv) {
  const options = {
    targetUrl: process.env.PHASE08_REBIND_URL ?? `http://${DEFAULTS.hostname}/`,
    dnsEvidencePath: null,
    egressEvidencePath: null,
    reportPath: process.env.PHASE08_REPORT_PATH ?? null,
    timeoutMs: Number(process.env.PHASE08_NAVIGATION_TIMEOUT_MS ?? DEFAULTS.timeoutMs),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = argv[index + 1];
    if (argument === '--dns-evidence') options.dnsEvidencePath = next;
    else if (argument === '--egress-evidence') options.egressEvidencePath = next;
    else if (argument === '--report') options.reportPath = next;
    else if (argument === '--timeout-ms') options.timeoutMs = Number(next);
    else if (argument === '--url') options.targetUrl = next;
    else if (argument === '--help') {
      console.log([
        'Usage: node scripts/phase-08-browser-dns-rebinding-evidence/run.mjs [options]',
        '  --url URL                 Browser target; default http://rebind.test/',
        '  --timeout-ms N            Navigation timeout; default 10000',
        '  --dns-evidence PATH       Gateway DNS evidence JSON',
        '  --egress-evidence PATH    Gateway nftables evidence JSON',
        '  --report PATH             Write the browser report JSON',
      ].join('\n'));
      process.exitCode = 0;
      return null;
    } else {
      throw new Error(`UNKNOWN_ARGUMENT:${argument}`);
    }
    index += 1;
  }

  if (!options.targetUrl) throw new Error('TARGET_URL_REQUIRED');
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1000) {
    throw new Error('TIMEOUT_MS_INVALID');
  }
  const target = new URL(options.targetUrl);
  if (target.protocol !== 'http:' || target.hostname !== DEFAULTS.hostname) {
    throw new Error('TARGET_MUST_BE_HTTP_REBIND_TEST');
  }
  return { ...options, target };
}

function now() {
  return new Date().toISOString();
}

function safeRequest(request) {
  const url = new URL(request.url());
  return {
    at: now(),
    hostname: url.hostname,
    port: url.port || (url.protocol === 'http:' ? '80' : '443'),
    path: url.pathname,
    method: request.method(),
    resourceType: request.resourceType(),
  };
}

async function startControlFixture() {
  const server = createServer((request, response) => {
    if (request.url !== '/control') {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('not found');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end('<!doctype html><title>Phase 8 DNS rebinding control fixture</title>');
  });

  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('CONTROL_FIXTURE_START_FAILED');
  return { server, url: `http://127.0.0.1:${address.port}/control` };
}

async function runBrowserAttempt(label, targetUrl, controlUrl, timeoutMs) {
  const attempt = {
    label,
    startedAt: now(),
    targetUrl,
    requests: [],
    responseStatus: null,
    navigationError: null,
    controlFixtureLoaded: false,
    targetRequestObserved: false,
    finishedAt: null,
  };
  let browser;
  let context;
  try {
    browser = await chromium.launch({ headless: true, chromiumSandbox: true });
    context = await browser.newContext();
    const page = await context.newPage();
    page.on('request', (request) => {
      const requestInfo = safeRequest(request);
      if (requestInfo.hostname === DEFAULTS.hostname) {
        attempt.requests.push(requestInfo);
        attempt.targetRequestObserved = true;
      }
    });
    page.on('response', (response) => {
      const url = new URL(response.url());
      if (url.hostname === DEFAULTS.hostname) attempt.responseStatus = response.status();
    });
    page.on('requestfailed', (request) => {
      const url = new URL(request.url());
      if (url.hostname === DEFAULTS.hostname) {
        attempt.navigationError = request.failure()?.errorText ?? 'REQUEST_FAILED';
      }
    });

    await page.goto(controlUrl, { waitUntil: 'commit', timeout: timeoutMs });
    attempt.controlFixtureLoaded = true;
    try {
      await page.goto(targetUrl, { waitUntil: 'commit', timeout: timeoutMs });
    } catch (error) {
      attempt.navigationError = error instanceof Error ? error.message : 'NAVIGATION_FAILED';
    }
  } finally {
    if (context) await context.close().catch(() => undefined);
    if (browser) await browser.close().catch(() => undefined);
    attempt.finishedAt = now();
  }
  return attempt;
}

async function readEvidence(path, name) {
  if (!path) return { status: 'NOT EXECUTED', reason: `${name.toUpperCase()}_EVIDENCE_NOT_PROVIDED` };
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    return { status: 'FAIL', reason: `${name.toUpperCase()}_EVIDENCE_UNREADABLE`, detail: error instanceof Error ? error.message : 'READ_FAILED' };
  }
}

function validateDnsEvidence(evidence) {
  if (!evidence || evidence.status) return evidence;
  const answers = Array.isArray(evidence.answers) ? evidence.answers : [];
  const first = answers.find((answer) => answer.sequence === 1 && answer.type === 'A');
  const second = answers.find((answer) => answer.sequence === 2 && answer.type === 'A');
  const valid = evidence.source === 'gateway-dns'
    && evidence.hostname === DEFAULTS.hostname
    && first?.address === DEFAULTS.publicIp
    && second?.address === DEFAULTS.privateIp
    && typeof first?.observedAt === 'string'
    && typeof second?.observedAt === 'string';
  return {
    status: valid ? 'PASS' : 'FAIL',
    source: evidence.source ?? null,
    hostname: evidence.hostname ?? null,
    answers: answers.slice(0, 4),
    reason: valid ? 'REAL_DNS_SEQUENCE_MATCHED' : 'DNS_SEQUENCE_DID_NOT_MATCH_EXPECTED_LAB_SEQUENCE',
  };
}

function validateEgressEvidence(evidence) {
  if (!evidence || evidence.status) return evidence;
  const valid = evidence.source === 'gateway-nftables'
    && evidence.sourceAddress === '10.20.0.10'
    && evidence.destinationAddress === DEFAULTS.privateIp
    && evidence.action === 'drop'
    && Number.isSafeInteger(evidence.packets)
    && evidence.packets > 0
    && evidence.internalHits === 0;
  return {
    status: valid ? 'PASS' : 'FAIL',
    source: evidence.source ?? null,
    sourceAddress: evidence.sourceAddress ?? null,
    destinationAddress: evidence.destinationAddress ?? null,
    action: evidence.action ?? null,
    packets: evidence.packets ?? null,
    bytes: evidence.bytes ?? null,
    internalHits: evidence.internalHits ?? null,
    reason: valid ? 'LOWER_BOUNDARY_DROP_MATCHED' : 'EGRESS_BOUNDARY_EVIDENCE_DID_NOT_MATCH_EXPECTED_DROP',
  };
}

function classifyOverall(attempts, dnsEvidence, egressEvidence) {
  const browserAttempts = attempts.every((attempt) => attempt.controlFixtureLoaded && attempt.targetRequestObserved);
  if (dnsEvidence.status === 'FAIL' || egressEvidence.status === 'FAIL') return 'FAIL';
  if (browserAttempts && dnsEvidence.status === 'PASS' && egressEvidence.status === 'PASS') return 'PASS';
  if (dnsEvidence.status === 'NOT EXECUTED' || egressEvidence.status === 'NOT EXECUTED') return 'NOT EXECUTED';
  return 'LIMITATION';
}

async function run(options) {
  const fixture = await startControlFixture();
  let attempts;
  try {
    attempts = [
      await runBrowserAttempt('initial-public-resolution', options.target.toString(), fixture.url, options.timeoutMs),
      await runBrowserAttempt('post-rebind-private-resolution', options.target.toString(), fixture.url, options.timeoutMs),
    ];
  } finally {
    await new Promise((resolvePromise) => fixture.server.close(resolvePromise));
  }

  const dnsEvidence = validateDnsEvidence(await readEvidence(options.dnsEvidencePath, 'dns'));
  const egressEvidence = validateEgressEvidence(await readEvidence(options.egressEvidencePath, 'egress'));
  const report = {
    generatedAt: now(),
    status: classifyOverall(attempts, dnsEvidence, egressEvidence),
    target: { hostname: DEFAULTS.hostname, url: options.target.toString() },
    browser: {
      launches: attempts.length,
      processRelaunchBetweenAttempts: true,
      chromiumSandboxRequested: true,
      hostResolverRulesUsed: false,
      hostsFileUsed: false,
      browserOnlyLimitation: 'Playwright does not expose the DNS answer or TCP socket selected by Chromium.',
    },
    attempts,
    dnsEvidence,
    egressEvidence,
    limitations: [
      'The Gateway DNS and nftables evidence must be exported separately and passed to this harness.',
      'A PASS does not demonstrate DNS pinning or a production BrowserProvider.',
      'Two Chromium launches make cache/connection reuse observable but do not guarantee a DNS query; the Gateway DNS evidence must show both A answers.',
      'No HTTPS/TLS, Service Worker, browser-remote, crash-cleanup or Search-provider test is performed by this harness.',
    ],
  };
  if (options.reportPath) await writeFile(options.reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report, null, 2));
  if (report.status === 'FAIL') process.exitCode = 1;
  else if (report.status === 'NOT EXECUTED') process.exitCode = 2;
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options) await run(options);
} catch (error) {
  console.error(JSON.stringify({ status: 'NOT EXECUTED', error: error instanceof Error ? error.message : 'HARNESS_FAILED' }));
  process.exitCode = 2;
}
