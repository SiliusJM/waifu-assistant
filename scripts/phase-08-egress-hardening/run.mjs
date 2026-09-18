import { createServer, request as httpRequest } from 'node:http';
import { isIP } from 'node:net';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const checks = [];
const channels = ['navigation', 'redirect', 'image', 'script', 'stylesheet', 'iframe', 'fetch/XHR', 'WebSocket', 'Service Worker'];

function check(name, status, details = '') {
  checks.push({ name, status, ...(details ? { details } : {}) });
}

function ipv4Number(value) {
  const parts = value.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part) || Number(part) > 255)) return null;
  return parts.reduce((result, part) => result * 256 + Number(part), 0);
}

function inRange(value, start, end) {
  const number = ipv4Number(value);
  return number !== null && number >= start && number <= end;
}

function classifyAddress(hostname) {
  const normalized = hostname.toLowerCase().replace(/\.$/, '');
  if (normalized === 'public.test') return { classification: 'controlled-public', effectiveAddress: '93.184.216.34', allowed: true };
  if (normalized === 'rebind.test') return { classification: 'effective-internal', effectiveAddress: '10.0.0.9', validatedAddresses: ['93.184.216.34', '10.0.0.9'], allowed: false };
  if (normalized === 'localhost' || normalized === 'ip6-loopback.test') return { classification: 'loopback', effectiveAddress: normalized === 'localhost' ? '127.0.0.1' : '::1', allowed: false };
  if (isIP(normalized) === 4) {
    if (inRange(normalized, 0, 0x00ffffff)) return { classification: 'unspecified', effectiveAddress: normalized, allowed: false };
    if (inRange(normalized, 0x0a000000, 0x0affffff) || inRange(normalized, 0xac100000, 0xac1fffff) || inRange(normalized, 0xc0a80000, 0xc0a8ffff)) return { classification: 'private', effectiveAddress: normalized, allowed: false };
    if (inRange(normalized, 0x7f000000, 0x7fffffff)) return { classification: 'loopback', effectiveAddress: normalized, allowed: false };
    if (inRange(normalized, 0xa9fe0000, 0xa9feffff)) return { classification: 'link-local', effectiveAddress: normalized, allowed: false };
    if (inRange(normalized, 0xe0000000, 0xffffffff)) return { classification: 'multicast-or-reserved', effectiveAddress: normalized, allowed: false };
    if (inRange(normalized, 0xc0000000, 0xc00000ff) || inRange(normalized, 0xc0000200, 0xc00002ff) || inRange(normalized, 0xcb007100, 0xcb0071ff)) return { classification: 'reserved-or-documentation', effectiveAddress: normalized, allowed: false };
  }
  if (normalized === '::1') return { classification: 'loopback', effectiveAddress: normalized, allowed: false };
  return { classification: 'unknown', effectiveAddress: normalized, allowed: false };
}

function channelForPath(path) {
  const mapping = {
    '/internal/navigation-target': 'navigation',
    '/internal/redirect-target': 'redirect',
    '/internal/image.png': 'image',
    '/internal/script.js': 'script',
    '/internal/style.css': 'stylesheet',
    '/internal/frame.html': 'iframe',
    '/internal/fetch.json': 'fetch/XHR',
    '/internal/socket': 'WebSocket',
    '/internal/service-worker-target': 'Service Worker',
  };
  return mapping[path] ?? 'unknown';
}

function parseProxyUrl(rawUrl, hostHeader) {
  try {
    return new URL(rawUrl);
  } catch {
    return new URL(`http://${hostHeader}${rawUrl}`);
  }
}

async function startFixture() {
  const state = { internalHits: [], publicHits: [], upgrades: 0 };
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://fixture.local');
    const channel = channelForPath(url.pathname);
    if (url.pathname.startsWith('/internal')) state.internalHits.push({ channel, path: url.pathname, method: request.method });
    else state.publicHits.push({ path: url.pathname, method: request.method });
    if (url.pathname === '/page') {
      const internal = (path) => `http://127.0.0.1:${server.address().port}/internal/${path}`;
      const body = `<!doctype html><html><head>
        <link rel="stylesheet" href="${internal('style.css')}">
        <script src="${internal('script.js')}"></script>
        </head><body>
        <img src="${internal('image.png')}" alt="internal image">
        <iframe src="${internal('frame.html')}" title="internal frame"></iframe>
        <script>
          window.fetchAttempt = fetch('${internal('fetch.json')}').catch(() => null);
          window.socketAttempt = new WebSocket('ws://127.0.0.1:${server.address().port}/internal/socket');
          if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');
        </script></body></html>`;
      response.writeHead(200, { 'content-type': 'text/html' });
      return response.end(body);
    }
    if (url.pathname === '/sw.js') {
      const body = `self.addEventListener('fetch', event => {
        if (new URL(event.request.url).pathname === '/sw-controlled') {
          event.respondWith(fetch('http://127.0.0.1:${server.address().port}/internal/service-worker-target'));
        }
      });`;
      response.writeHead(200, { 'content-type': 'application/javascript', 'cache-control': 'no-store' });
      return response.end(body);
    }
    if (url.pathname === '/sw-controlled') {
      response.writeHead(200, { 'content-type': 'text/plain' });
      return response.end('service worker fixture');
    }
    if (url.pathname === '/redirect-internal') {
      response.writeHead(302, { location: `http://127.0.0.1:${server.address().port}/internal/redirect-target` });
      return response.end();
    }
    response.writeHead(url.pathname.startsWith('/internal') ? 200 : 404, { 'content-type': 'text/plain' });
    return response.end(url.pathname.startsWith('/internal') ? 'internal fixture reached' : 'not found');
  });
  server.on('upgrade', (request, socket) => {
    state.upgrades += 1;
    const path = new URL(request.url ?? '/', 'http://fixture.local').pathname;
    state.internalHits.push({ channel: channelForPath(path), path, method: 'UPGRADE' });
    socket.destroy();
  });
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('FIXTURE_START_FAILED');
  return { server, port: address.port, state };
}

function createProxy(fixturePort) {
  const state = { observations: [] };
  const observe = (method, targetUrl, channel) => {
    const policy = classifyAddress(targetUrl.hostname);
    const observation = {
      method,
      channel,
      host: targetUrl.hostname,
      path: targetUrl.pathname,
      destination: policy.effectiveAddress,
      classification: policy.classification,
      boundaryObserved: true,
      blocked: !policy.allowed,
      protocol: targetUrl.protocol,
    };
    state.observations.push(observation);
    return policy;
  };
  const server = createServer((request, response) => {
    const targetUrl = parseProxyUrl(request.url ?? '/', request.headers.host ?? '');
    const channel = channelForPath(targetUrl.pathname);
    const policy = observe(request.method ?? 'GET', targetUrl, channel);
    if (!policy.allowed) {
      response.writeHead(403, { 'content-type': 'text/plain', 'x-egress-boundary': 'blocked' });
      return response.end('egress blocked');
    }
    const upstream = httpRequest({ hostname: '127.0.0.1', port: fixturePort, method: request.method, path: `${targetUrl.pathname}${targetUrl.search}`, headers: { ...request.headers, host: `127.0.0.1:${fixturePort}`, connection: 'close' } }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
    request.pipe(upstream);
  });
  server.on('connect', (request, clientSocket) => {
    const [hostname] = (request.url ?? '').split(':');
    const targetUrl = new URL(`http://${hostname}/`);
    const policy = observe('CONNECT', targetUrl, 'WebSocket');
    clientSocket.write(`HTTP/1.1 ${policy.allowed ? 200 : 403} ${policy.allowed ? 'Connection Established' : 'Forbidden'}\r\n\r\n`);
    clientSocket.destroy();
  });
  server.on('upgrade', (request, clientSocket, head) => {
    const targetUrl = parseProxyUrl(request.url ?? '/', request.headers.host ?? '');
    const policy = observe('UPGRADE', targetUrl, channelForPath(targetUrl.pathname));
    if (!policy.allowed) clientSocket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    clientSocket.destroy();
    void head;
  });
  return { server, state };
}

function resultForChannel(channel, attempted, observations, internalHits) {
  const channelObservations = observations.filter((item) => item.channel === channel);
  const hits = internalHits.filter((item) => item.channel === channel);
  const observed = channelObservations.length > 0;
  const blocked = channelObservations.some((item) => item.blocked);
  const destination = channelObservations[0]?.destination ?? null;
  const result = !attempted ? 'NOT EXECUTED' : observed && blocked && hits.length === 0 ? 'PASS' : 'FAIL';
  return { channel, requestAttempted: attempted, proxyObserved: observed, destination, blocked, internalHits: hits.length, internalFixtureConnection: hits.length > 0, result };
}

async function run() {
  const fixture = await startFixture();
  const proxy = createProxy(fixture.port);
  const temp = await mkdtemp(join(tmpdir(), 'waifu-phase-08-egress-hardening-'));
  const cleanup = { contextClosed: false, browserClosed: false, proxyClosed: false, fixtureClosed: false, tempRemoved: false };
  let browser;
  let context;
  let serviceWorkerAvailable = false;
  try {
    await new Promise((resolvePromise) => proxy.server.listen(0, '127.0.0.1', resolvePromise));
    const proxyAddress = proxy.server.address();
    if (!proxyAddress || typeof proxyAddress === 'string') throw new Error('PROXY_START_FAILED');
    const publicBase = `http://public.test:${fixture.port}`;
    browser = await chromium.launch({ headless: true, chromiumSandbox: true, proxy: { server: `http://127.0.0.1:${proxyAddress.port}`, bypass: '' } });
    context = await browser.newContext({ serviceWorkers: 'allow' });
    const page = await context.newPage();
    await page.goto(`${publicBase}/page`, { waitUntil: 'domcontentloaded', timeout: 1500 });
    serviceWorkerAvailable = await page.evaluate(() => 'serviceWorker' in navigator);
    await page.waitForTimeout(250);
    const navigationPage = await context.newPage();
    try { await navigationPage.goto(`http://127.0.0.1:${fixture.port}/internal/navigation-target`, { waitUntil: 'domcontentloaded', timeout: 1000 }); } catch { /* expected blocked navigation */ }
    await navigationPage.close();
    const redirectPage = await context.newPage();
    try { await redirectPage.goto(`${publicBase}/redirect-internal`, { waitUntil: 'domcontentloaded', timeout: 1000 }); } catch { /* expected blocked redirect */ }
    await redirectPage.close();
    if (serviceWorkerAvailable) {
      try {
        await page.evaluate(() => navigator.serviceWorker.ready);
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 1500 });
        await page.evaluate(() => fetch('/sw-controlled').catch(() => undefined));
      } catch { /* the channel result records the observed evidence */ }
    }
    await page.waitForTimeout(250);
    await context.close();
    cleanup.contextClosed = true;
    await browser.close();
    cleanup.browserClosed = true;
  } finally {
    if (context) await context.close().catch(() => undefined);
    if (browser) await browser.close().catch(() => undefined);
    await new Promise((resolvePromise) => proxy.server.close(() => resolvePromise()));
    cleanup.proxyClosed = true;
    await new Promise((resolvePromise) => fixture.server.close(() => resolvePromise()));
    cleanup.fixtureClosed = true;
    await rm(temp, { recursive: true, force: true });
    try { await stat(temp); } catch { cleanup.tempRemoved = true; }
  }
  const attempted = Object.fromEntries(channels.map((channel) => [channel, channel !== 'Service Worker' || serviceWorkerAvailable]));
  const channelResults = channels.map((channel) => resultForChannel(channel, attempted[channel], proxy.state.observations, fixture.state.internalHits));
  for (const result of channelResults) check(`channel ${result.channel}`, result.result, JSON.stringify(result));
  for (const [name, value] of [['context cleanup', cleanup.contextClosed], ['browser cleanup', cleanup.browserClosed], ['proxy cleanup', cleanup.proxyClosed], ['fixture cleanup', cleanup.fixtureClosed], ['temporary directory cleanup', cleanup.tempRemoved]]) check(name, value ? 'PASS' : 'FAIL');
  check('HTTPS public to HTTPS public', 'NOT EXECUTED', 'No reproducible in-process TLS certificate fixture was available; no system security or process API was used.');
  check('HTTPS public to HTTP', 'NOT EXECUTED', 'TLS fixture unavailable; downgrade policy remains open.');
  check('HTTPS public to internal destination', 'NOT EXECUTED', 'TLS fixture unavailable; internal egress policy was tested only over HTTP.');
  check('DNS rebinding controlled case', 'SIMULATED', 'Validated public address 93.184.216.34; effective internal address 10.0.0.9; no real DNS/socket pinning.');
  check('browser remote critical cases', process.env.BROWSER_REMOTE_ENDPOINT && process.env.BROWSER_REMOTE_TOKEN ? 'NOT EXECUTED' : 'NOT EXECUTED', process.env.BROWSER_REMOTE_ENDPOINT ? 'Endpoint exists but this harness does not persist or request credentials.' : 'BROWSER_REMOTE_ENDPOINT/BROWSER_REMOTE_TOKEN absent.');
  check('crash cleanup', 'NOT EXECUTED', 'No safe crash simulation exists without process termination APIs.');
  check('timeout and orderly shutdown cleanup', cleanup.contextClosed && cleanup.browserClosed && cleanup.proxyClosed && cleanup.fixtureClosed && cleanup.tempRemoved ? 'PASS' : 'FAIL');
  const failed = checks.filter((item) => item.status === 'FAIL').length;
  const passed = checks.filter((item) => item.status === 'PASS').length;
  const notExecuted = checks.filter((item) => item.status === 'NOT EXECUTED').length;
  const simulated = checks.filter((item) => item.status === 'SIMULATED').length;
  return { status: failed > 0 ? 'FAIL' : 'PASS', total: checks.length, passed, failed, notExecuted, simulated, checks, channelResults, internalHits: fixture.state.internalHits, observations: proxy.state.observations, limitation: 'The fixture is local and controlled. It demonstrates policy evidence at the proxy boundary, not production network isolation or real DNS pinning.' };
}

const result = await run();
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (result.failed > 0) process.exitCode = 1;
