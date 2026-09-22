import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import {
  DEFAULTS,
  classifyOverall,
  correlateBrowserDnsEgress,
  validateClockReference,
  validateDnsEvidence,
  validateEgressEvidence,
} from './classifier.mjs';

function parseArgs(argv) {
  const options = {
    targetUrl: process.env.PHASE08_REBIND_URL ?? `http://${DEFAULTS.hostname}/`,
    dnsEvidencePath: null,
    egressEvidencePath: null,
    clockEvidencePath: null,
    reportPath: process.env.PHASE08_REPORT_PATH ?? null,
    timeoutMs: Number(process.env.PHASE08_NAVIGATION_TIMEOUT_MS ?? 10_000),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = argv[index + 1];
    if (argument === '--dns-evidence') options.dnsEvidencePath = next;
    else if (argument === '--egress-evidence') options.egressEvidencePath = next;
    else if (argument === '--clock-evidence') options.clockEvidencePath = next;
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
        '  --clock-evidence PATH     Cross-VM UTC clock reference JSON',
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

function safeUrlDetails(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'http:' ? '80' : '443'),
      path: url.pathname,
    };
  } catch {
    return null;
  }
}

function cdpTimestamp(event) {
  return Number.isFinite(event?.timestamp) ? event.timestamp : null;
}

const NETLOG_MAX_SIZE_MB = 16;
const NETLOG_SUMMARY_MAX_EVENTS = 1000;

const NETLOG_EVENT_GROUPS = Object.freeze({
  dns: new Set([
    'HOST_RESOLVER_MANAGER_REQUEST',
    'HOST_RESOLVER_MANAGER_CACHE_HIT',
    'HOST_RESOLVER_MANAGER_HOSTS_HIT',
    'HOST_RESOLVER_SYSTEM_TASK',
    'HOST_RESOLVER_DNS_TASK',
    'HOST_RESOLVER_DNS_TASK_EXTRACTION_RESULTS',
    'HOST_RESOLVER_SERVICE_ENDPOINTS_UPDATED',
  ]),
  connection: new Set([
    'TRANSPORT_CONNECT_JOB_CONNECT_ATTEMPT',
    'TCP_CONNECT_JOB_CONNECTOR_CONNECT_START',
    'TCP_CONNECT_JOB_CONNECTOR_CONNECT_COMPLETE',
    'TCP_CONNECT_JOB_CONNECTOR_DONE',
    'TCP_CONNECT_JOB_VERIFY_IP_ENDPOINT_USABLE',
    'CONNECT_JOB_TIMED_OUT',
    'TCP_CONNECT_JOB_CONNECT',
    'TRANSPORT_CONNECT_JOB_CONNECT',
  ]),
  socket: new Set([
    'CONNECT_JOB_SET_SOCKET',
    'SOCKET_POOL_REUSED_AN_EXISTING_SOCKET',
    'SOCKET_POOL_BOUND_TO_SOCKET',
    'SOCKET_POOL_BOUND_TO_CONNECT_JOB',
  ]),
  request: new Set([
    'URL_REQUEST_START_JOB',
    'HTTP_STREAM_JOB',
    'HTTP_TRANSACTION',
    'TCP_CLIENT_SOCKET_POOL_REQUESTED_SOCKET',
  ]),
  error: new Set([
    'FAILED',
    'CANCELLED',
    'CONNECT_JOB_TIMED_OUT',
    'TCP_CONNECT_JOB_CONNECTOR_COMPLETE',
    'TCP_CONNECT_JOB_CONNECTOR_DONE',
  ]),
});

const NETLOG_ADDRESS_KEYS = new Set([
  'address',
  'address_list',
  'addresses',
  'ip_endpoint',
  'ipv4_endpoints',
  'ipv6_endpoints',
  'remote_address',
]);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeNetLogId(value) {
  if (Number.isSafeInteger(value)) return String(value);
  if (typeof value === 'string' && value.length > 0) return value;
  if (isRecord(value)) return normalizeNetLogId(value.id);
  return null;
}

function collectSourceDependencies(value, result = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectSourceDependencies(item, result);
    return result;
  }
  if (!isRecord(value)) return result;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'source_dependency' || key === 'sourceDependency') {
      const dependency = normalizeNetLogId(child);
      if (dependency) result.add(dependency);
    }
    collectSourceDependencies(child, result);
  }
  return result;
}

function containsTargetHost(value) {
  if (typeof value === 'string') return value.includes(DEFAULTS.hostname);
  if (Array.isArray(value)) return value.some(containsTargetHost);
  if (isRecord(value)) return Object.values(value).some(containsTargetHost);
  return false;
}

function netLogEventGroup(type) {
  for (const [group, types] of Object.entries(NETLOG_EVENT_GROUPS)) {
    if (types.has(type)) return group;
  }
  return null;
}

function isSafeNetworkEndpoint(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) return false;
  return /^(?:\[[0-9a-f:]+\]|(?:\d{1,3}\.){3}\d{1,3})(?::\d{1,5})?$/i.test(value);
}

function collectNetLogAddresses(value, key = null, result = new Set()) {
  if (typeof value === 'string') {
    if (key && NETLOG_ADDRESS_KEYS.has(key) && isSafeNetworkEndpoint(value)) result.add(value);
    return result;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectNetLogAddresses(item, key, result);
    return result;
  }
  if (!isRecord(value)) return result;

  if (typeof value.address === 'string' && isSafeNetworkEndpoint(value.address)) {
    const port = Number.isSafeInteger(value.port) && value.port >= 0 && value.port <= 65535
      ? `:${value.port}`
      : '';
    result.add(`${value.address}${port}`);
  }
  for (const [childKey, child] of Object.entries(value)) {
    if (NETLOG_ADDRESS_KEYS.has(childKey)) collectNetLogAddresses(child, childKey, result);
  }
  return result;
}

function safeNetLogErrorParams(params) {
  const result = {};
  if (!isRecord(params)) return result;
  if (Number.isSafeInteger(params.net_error)) result.netError = params.net_error;
  if (Number.isSafeInteger(params.os_error)) result.osError = params.os_error;
  if (typeof params.error_text === 'string' && params.error_text.length <= 128) {
    result.errorText = params.error_text;
  }
  if (typeof params.error === 'string' && params.error.length <= 128) {
    result.error = params.error;
  }
  if (Number.isSafeInteger(params.idle_ms)) result.idleMs = params.idle_ms;
  return result;
}

function summarizeNetLogEvent(event, group) {
  const params = isRecord(event.params) ? event.params : {};
  const sourceId = normalizeNetLogId(event.source);
  const sourceDependencies = [...collectSourceDependencies(params)].sort();
  const addresses = [...collectNetLogAddresses(params)].sort();
  return {
    group,
    type: typeof event.type === 'string' ? event.type : 'UNKNOWN',
    phase: Number.isSafeInteger(event.phase) ? event.phase : null,
    netlogTime: typeof event.time === 'number' && Number.isFinite(event.time) ? event.time : null,
    sourceId,
    sourceType: isRecord(event.source) && typeof event.source.type === 'string' ? event.source.type : null,
    sourceDependencies,
    targetHost: DEFAULTS.hostname,
    addresses,
    ...safeNetLogErrorParams(params),
  };
}

function summarizeNetLogDocument(document) {
  const events = Array.isArray(document?.events) ? document.events : [];
  const targetSources = new Set();

  for (const event of events) {
    if (!isRecord(event)) continue;
    const dependencies = collectSourceDependencies(event.params);
    if (containsTargetHost(event.params)) {
      const sourceId = normalizeNetLogId(event.source);
      if (sourceId) targetSources.add(sourceId);
      for (const dependency of dependencies) targetSources.add(dependency);
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const event of events) {
      if (!isRecord(event)) continue;
      const sourceId = normalizeNetLogId(event.source);
      const dependencies = collectSourceDependencies(event.params);
      if ((sourceId && targetSources.has(sourceId))
        || [...dependencies].some((dependency) => targetSources.has(dependency))) {
        if (sourceId && !targetSources.has(sourceId)) {
          targetSources.add(sourceId);
          changed = true;
        }
        for (const dependency of dependencies) {
          if (!targetSources.has(dependency)) {
            targetSources.add(dependency);
            changed = true;
          }
        }
      }
    }
  }

  const relevantEvents = events
    .map((event) => {
      if (!isRecord(event)) return null;
      const group = netLogEventGroup(event.type);
      if (!group) return null;
      const sourceId = normalizeNetLogId(event.source);
      const dependencies = collectSourceDependencies(event.params);
      const related = containsTargetHost(event.params)
        || (sourceId && targetSources.has(sourceId))
        || [...dependencies].some((dependency) => targetSources.has(dependency));
      return related ? summarizeNetLogEvent(event, group) : null;
    })
    .filter((event) => event !== null);

  const truncated = relevantEvents.length > NETLOG_SUMMARY_MAX_EVENTS;
  return {
    status: relevantEvents.length > 0 && !truncated ? 'OBSERVED' : 'LIMITATION',
    targetHost: DEFAULTS.hostname,
    eventCount: relevantEvents.length,
    truncated,
    events: relevantEvents.slice(0, NETLOG_SUMMARY_MAX_EVENTS),
  };
}

async function readNetLog(netlogPath) {
  try {
    const raw = await readFile(netlogPath, 'utf8');
    const sha256 = createHash('sha256').update(raw).digest('hex');
    let document;
    try {
      document = JSON.parse(raw);
    } catch {
      return { status: 'INVALID', sha256, summary: null, reason: 'NETLOG_JSON_INVALID' };
    }
    return {
      status: 'AVAILABLE',
      sha256,
      summary: summarizeNetLogDocument(document),
    };
  } catch (error) {
    return {
      status: error?.code === 'ENOENT' ? 'NOT EXECUTED' : 'INVALID',
      summary: null,
      reason: error?.code === 'ENOENT' ? 'NETLOG_FILE_NOT_FOUND' : 'NETLOG_UNREADABLE',
    };
  }
}

async function cleanupNetLogDirectory(netlogDirectory) {
  if (!netlogDirectory) return 'NOT_CREATED';
  try {
    await rm(netlogDirectory, { recursive: true, force: true });
    return 'CLEANED';
  } catch {
    return 'FAILED';
  }
}

const TIMING_FIELDS = [
  'startTime',
  'domainLookupStart',
  'domainLookupEnd',
  'connectStart',
  'connectEnd',
  'requestStart',
  'responseStart',
  'responseEnd',
];

function serializeTiming(request) {
  let raw;
  try {
    raw = request.timing();
  } catch {
    return null;
  }
  const timing = Object.fromEntries(TIMING_FIELDS.map((field) => [field, raw[field] ?? -1]));
  const absolute = {};
  if (Number.isFinite(raw.startTime)) {
    for (const field of TIMING_FIELDS.slice(1)) {
      const value = raw[field];
      absolute[field] = Number.isFinite(value) && value >= 0
        ? new Date(raw.startTime + value).toISOString()
        : null;
    }
  }
  return { ...timing, absolute };
}

function safeRequest(request, requestAt = now()) {
  const url = new URL(request.url());
  return {
    requestAt,
    hostname: url.hostname,
    port: url.port || (url.protocol === 'http:' ? '80' : '443'),
    path: url.pathname,
    method: request.method(),
    resourceType: request.resourceType(),
    timing: serializeTiming(request),
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
    observations: {
      playwright: [],
      cdp: [],
    },
    netlog: {
      status: 'NOT EXECUTED',
      summary: null,
      cleanupStatus: 'NOT_STARTED',
    },
    cdpSetupError: null,
    cleanupStartedAt: null,
    finishedAt: null,
  };
  let browser;
  let context;
  let page;
  let cdpSession;
  let netlogDirectory;
  let netlogPath;
  try {
    netlogDirectory = await mkdtemp(join(tmpdir(), 'phase-08-netlog-'));
    netlogPath = join(netlogDirectory, 'netlog.json');
    browser = await chromium.launch({
      headless: true,
      chromiumSandbox: true,
      args: [
        `--log-net-log=${netlogPath}`,
        `--net-log-max-size-mb=${NETLOG_MAX_SIZE_MB}`,
      ],
    });
    browser.on('disconnected', () => {
      attempt.observations.playwright.push({
        event: 'browser.disconnected',
        timestamp: now(),
      });
    });
    context = await browser.newContext();
    page = await context.newPage();
    page.on('close', () => {
      attempt.observations.playwright.push({
        event: 'page.close',
        timestamp: now(),
      });
    });
    page.on('crash', () => {
      attempt.observations.playwright.push({
        event: 'page.crash',
        timestamp: now(),
      });
    });

    try {
      cdpSession = await context.newCDPSession(page);
      const cdpTargetRequestIds = new Set();
      cdpSession.on('Network.requestWillBeSent', (event) => {
        const requestDetails = safeUrlDetails(event.request?.url);
        const isTarget = requestDetails?.hostname === DEFAULTS.hostname;
        if (isTarget && event.requestId) cdpTargetRequestIds.add(event.requestId);
        attempt.observations.cdp.push({
          event: 'Network.requestWillBeSent',
          observedAt: now(),
          protocolTimestamp: cdpTimestamp(event),
          wallTime: Number.isFinite(event?.wallTime) ? event.wallTime : null,
          requestId: event.requestId ?? null,
          loaderId: event.loaderId ?? null,
          frameId: event.frameId ?? null,
          type: event.type ?? null,
          target: isTarget,
          documentUrl: safeUrlDetails(event.documentURL),
          request: {
            ...requestDetails,
            method: event.request?.method ?? null,
          },
          redirectResponseStatus: event.redirectResponse?.status ?? null,
        });
      });
      cdpSession.on('Network.responseReceived', (event) => {
        const responseDetails = safeUrlDetails(event.response?.url);
        const isTarget = responseDetails?.hostname === DEFAULTS.hostname
          || cdpTargetRequestIds.has(event.requestId);
        attempt.observations.cdp.push({
          event: 'Network.responseReceived',
          observedAt: now(),
          protocolTimestamp: cdpTimestamp(event),
          requestId: event.requestId ?? null,
          loaderId: event.loaderId ?? null,
          frameId: event.frameId ?? null,
          type: event.type ?? null,
          target: isTarget,
          response: {
            ...responseDetails,
            status: Number.isFinite(event.response?.status) ? event.response.status : null,
            mimeType: event.response?.mimeType ?? null,
            remoteIPAddress: event.response?.remoteIPAddress ?? null,
            remotePort: Number.isFinite(event.response?.remotePort) ? event.response.remotePort : null,
          },
        });
      });
      cdpSession.on('Network.loadingFailed', (event) => {
        attempt.observations.cdp.push({
          event: 'Network.loadingFailed',
          observedAt: now(),
          protocolTimestamp: cdpTimestamp(event),
          requestId: event.requestId ?? null,
          type: event.type ?? null,
          target: cdpTargetRequestIds.has(event.requestId),
          errorText: event.errorText ?? null,
          canceled: event.canceled === true,
          blockedReason: event.blockedReason ?? null,
          corsErrorStatus: event.corsErrorStatus ?? null,
          encodedDataLength: Number.isFinite(event.encodedDataLength) ? event.encodedDataLength : null,
        });
      });
      await cdpSession.send('Network.enable');
    } catch (error) {
      attempt.cdpSetupError = error instanceof Error ? error.message : 'CDP_SETUP_FAILED';
    }

    const targetRequests = new Map();
    page.on('request', (request) => {
      const requestAt = now();
      const requestInfo = safeRequest(request, requestAt);
      if (requestInfo.hostname === DEFAULTS.hostname) {
        attempt.requests.push(requestInfo);
        targetRequests.set(request, requestInfo);
        attempt.targetRequestObserved = true;
        attempt.observations.playwright.push({
          event: 'request',
          timestamp: requestAt,
          hostname: requestInfo.hostname,
          port: requestInfo.port,
          path: requestInfo.path,
          method: requestInfo.method,
          resourceType: requestInfo.resourceType,
        });
      }
    });
    page.on('response', (response) => {
      const url = new URL(response.url());
      if (url.hostname === DEFAULTS.hostname) {
        const timestamp = now();
        attempt.responseStatus = response.status();
        const requestInfo = targetRequests.get(response.request());
        if (requestInfo) requestInfo.timing = serializeTiming(response.request());
        attempt.observations.playwright.push({
          event: 'response',
          timestamp,
          hostname: url.hostname,
          port: url.port || (url.protocol === 'http:' ? '80' : '443'),
          path: url.pathname,
          status: response.status(),
        });
      }
    });
    page.on('requestfailed', (request) => {
      const url = new URL(request.url());
      if (url.hostname === DEFAULTS.hostname) {
        const timestamp = now();
        const failure = request.failure();
        attempt.navigationError = failure?.errorText ?? 'REQUEST_FAILED';
        const requestInfo = targetRequests.get(request);
        if (requestInfo) requestInfo.timing = serializeTiming(request);
        attempt.observations.playwright.push({
          event: 'requestfailed',
          timestamp,
          hostname: url.hostname,
          port: url.port || (url.protocol === 'http:' ? '80' : '443'),
          path: url.pathname,
          failure,
          errorText: failure?.errorText ?? null,
        });
      }
    });
    page.on('requestfinished', (request) => {
      const requestInfo = targetRequests.get(request);
      if (requestInfo) {
        requestInfo.timing = serializeTiming(request);
        attempt.observations.playwright.push({
          event: 'requestfinished',
          timestamp: now(),
          hostname: requestInfo.hostname,
          port: requestInfo.port,
          path: requestInfo.path,
        });
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
    attempt.cleanupStartedAt = now();
    if (cdpSession) await cdpSession.detach().catch(() => undefined);
    if (context) await context.close().catch(() => undefined);
    if (browser) await browser.close().catch(() => undefined);
    attempt.finishedAt = now();
    if (netlogPath) attempt.netlog = await readNetLog(netlogPath);
    attempt.netlog.cleanupStatus = await cleanupNetLogDirectory(netlogDirectory);
  }
  return attempt;
}

async function readEvidence(path, name) {
  if (!path) return null;
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    return { _readError: `${name.toUpperCase()}_EVIDENCE_UNREADABLE:${error instanceof Error ? error.message : 'READ_FAILED'}` };
  }
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
  const clockEvidence = validateClockReference(await readEvidence(options.clockEvidencePath, 'clock'));
  const correlation = correlateBrowserDnsEgress(attempts, dnsEvidence, egressEvidence, clockEvidence);
  const report = {
    generatedAt: now(),
    status: classifyOverall(attempts, dnsEvidence, egressEvidence, correlation),
    target: { hostname: DEFAULTS.hostname, url: options.target.toString() },
    browser: {
      launches: attempts.length,
      processRelaunchBetweenAttempts: true,
      chromiumSandboxRequested: true,
      netlog: {
        enabled: true,
        maxSizeMb: NETLOG_MAX_SIZE_MB,
        rawRetained: false,
      },
      hostResolverRulesUsed: false,
      hostsFileUsed: false,
      browserOnlyLimitation: 'Playwright does not expose the DNS answer or TCP socket selected by Chromium.',
    },
    attempts,
    dnsEvidence,
    egressEvidence,
    clockEvidence,
    correlation,
    limitations: [
      'The Gateway DNS and nftables evidence must be exported separately and passed to this harness.',
      'A cross-VM clock reference is required for PASS; its maxOffsetMs must come from the operator, not this harness.',
      'A PASS does not demonstrate DNS pinning or a production BrowserProvider.',
      'Two Chromium launches make cache/connection reuse observable but do not guarantee a DNS query; the Gateway DNS evidence must show both A answers.',
      'No HTTPS/TLS, Service Worker, browser-remote, crash-cleanup or Search-provider test is performed by this harness.',
    ],
  };
  if (options.reportPath) await writeFile(options.reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report, null, 2));
  if (report.status === 'FAIL') process.exitCode = 1;
  else if (report.status === 'LIMITATION' || report.status === 'NOT EXECUTED') process.exitCode = 2;
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options) await run(options);
} catch (error) {
  console.error(JSON.stringify({ status: 'NOT EXECUTED', error: error instanceof Error ? error.message : 'HARNESS_FAILED' }));
  process.exitCode = 2;
}
