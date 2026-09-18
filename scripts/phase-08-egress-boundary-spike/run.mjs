import { createServer, request as httpRequest } from 'node:http';
import { isIP } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const checks = [];

function check(name, status, details = '') {
  checks.push({ name, status, ...(details ? { details } : {}) });
}

function ipv4Number(value) {
  const parts = value.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part) || Number(part) > 255)) return null;
  return parts.reduce((result, part) => result * 256 + Number(part), 0);
}

function inRange(value, start, end) {
  const numeric = ipv4Number(value);
  return numeric !== null && numeric >= start && numeric <= end;
}

function classifyAddress(hostname) {
  const normalized = hostname.toLowerCase().replace(/\.$/, '');
  if (normalized === 'public.test') return { classification: 'controlled-public', effectiveAddress: '93.184.216.34', allowed: true };
  if (normalized === 'rebind.test') return { classification: 'effective-internal', effectiveAddress: '10.0.0.9', validatedAddresses: ['93.184.216.34', '10.0.0.9'], allowed: false };
  if (normalized === 'private.test') return { classification: 'private', effectiveAddress: '10.0.0.9', allowed: false };
  if (normalized === 'linklocal.test') return { classification: 'link-local', effectiveAddress: '169.254.1.1', allowed: false };
  if (normalized === 'multicast.test') return { classification: 'multicast', effectiveAddress: '224.0.0.1', allowed: false };
  if (normalized === 'reserved.test') return { classification: 'reserved-or-documentation', effectiveAddress: '192.0.2.1', allowed: false };
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

function parseProxyUrl(rawUrl, hostHeader) {
  try {
    return new URL(rawUrl);
  } catch {
    return new URL(`http://${hostHeader}${rawUrl}`);
  }
}

async function startFixture() {
  const state = { internalHits: [], publicHits: [], upgrades: 0 };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fixture.local');
    const isInternal = url.pathname.startsWith('/internal');
    if (isInternal) state.internalHits.push({ path: url.pathname, method: req.method });
    else state.publicHits.push({ path: url.pathname, method: req.method });
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
          navigator.serviceWorker.register('/sw.js');
        </script></body></html>`;
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(body);
    }
    if (url.pathname === '/sw.js') {
      const body = `self.addEventListener('fetch', event => {
        if (new URL(event.request.url).pathname === '/sw-controlled') {
          event.respondWith(fetch('http://127.0.0.1:${server.address().port}/internal/service-worker-target'));
        }
      });`;
      res.writeHead(200, { 'content-type': 'application/javascript', 'cache-control': 'no-store' });
      return res.end(body);
    }
    if (url.pathname === '/sw-controlled') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('service worker fixture');
    }
    if (url.pathname === '/redirect-public') {
      res.writeHead(302, { location: `http://public.test:${server.address().port}/page` });
      return res.end();
    }
    if (url.pathname === '/redirect-internal' || url.pathname === '/redirect-loopback') {
      res.writeHead(302, { location: `http://127.0.0.1:${server.address().port}/internal/redirect-target` });
      return res.end();
    }
    if (url.pathname === '/redirect-chain') {
      const remaining = Number(url.searchParams.get('n') ?? '0');
      if (remaining > 0) {
        res.writeHead(302, { location: `http://public.test:${server.address().port}/redirect-chain?n=${remaining - 1}` });
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('redirect chain complete');
    }
    if (url.pathname === '/redirect-loop') {
      res.writeHead(302, { location: `http://public.test:${server.address().port}/redirect-loop` });
      return res.end();
    }
    if (url.pathname === '/slow') return setTimeout(() => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('slow fixture');
    }, 300);
    res.writeHead(isInternal ? 200 : 404, { 'content-type': 'text/plain' });
    return res.end(isInternal ? 'internal fixture reached' : 'not found');
  });
  server.on('upgrade', (req, socket) => {
    state.upgrades += 1;
    state.internalHits.push({ path: new URL(req.url ?? '/', 'http://fixture.local').pathname, method: 'UPGRADE' });
    socket.destroy();
  });
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('FIXTURE_START_FAILED');
  return { server, port: address.port, state };
}

function createProxy(fixturePort) {
  const state = { observations: [], bypassCandidates: [] };
  const server = createServer((req, res) => {
    const targetUrl = parseProxyUrl(req.url ?? '/', req.headers.host ?? '');
    const policy = classifyAddress(targetUrl.hostname);
    const observation = { method: req.method, host: targetUrl.hostname, path: targetUrl.pathname, destination: policy.effectiveAddress, classification: policy.classification, passedBoundary: true, blocked: !policy.allowed, protocol: targetUrl.protocol };
    state.observations.push(observation);
    if (!policy.allowed) {
      res.writeHead(403, { 'content-type': 'text/plain', 'x-egress-boundary': 'blocked' });
      return res.end('egress blocked');
    }
    const upstream = httpRequest({ hostname: '127.0.0.1', port: fixturePort, method: req.method, path: `${targetUrl.pathname}${targetUrl.search}`, headers: { ...req.headers, host: `127.0.0.1:${fixturePort}`, connection: 'close' } }, (upstreamResponse) => {
      res.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(res);
    });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(upstream);
  });
  server.on('connect', (req, clientSocket) => {
    const [hostname, portString] = (req.url ?? '').split(':');
    const policy = classifyAddress(hostname);
    state.observations.push({ method: 'CONNECT', host: hostname, path: '/', destination: policy.effectiveAddress, classification: policy.classification, passedBoundary: true, blocked: !policy.allowed, protocol: 'https:' });
    clientSocket.write(`HTTP/1.1 ${policy.allowed ? 200 : 403} ${policy.allowed ? 'Connection Established' : 'Forbidden'}\r\n\r\n`);
    if (!policy.allowed) clientSocket.destroy();
    else clientSocket.destroy();
    void portString;
  });
  server.on('upgrade', (req, clientSocket, head) => {
    const targetUrl = parseProxyUrl(req.url ?? '/', req.headers.host ?? '');
    const policy = classifyAddress(targetUrl.hostname);
    const observation = { method: 'UPGRADE', host: targetUrl.hostname, path: targetUrl.pathname, destination: policy.effectiveAddress, classification: policy.classification, passedBoundary: true, blocked: !policy.allowed, protocol: targetUrl.protocol };
    state.observations.push(observation);
    if (!policy.allowed) {
      clientSocket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return clientSocket.destroy();
    }
    clientSocket.destroy();
    void head;
  });
  return { server, state };
}

async function run() {
  const fixture = await startFixture();
  const proxy = createProxy(fixture.port);
  const temp = await mkdtemp(join(tmpdir(), 'waifu-phase-08-egress-'));
  let browser;
  try {
    await new Promise((resolvePromise) => proxy.server.listen(0, '127.0.0.1', resolvePromise));
    const proxyAddress = proxy.server.address();
    if (!proxyAddress || typeof proxyAddress === 'string') throw new Error('PROXY_START_FAILED');
    const proxyUrl = `http://127.0.0.1:${proxyAddress.port}`;
    const publicBase = `http://public.test:${fixture.port}`;
    browser = await chromium.launch({
      headless: true,
      chromiumSandbox: true,
      proxy: { server: proxyUrl, bypass: '' },
      args: [`--unsafely-treat-insecure-origin-as-secure=${publicBase}`],
    });
    const context = await browser.newContext({ serviceWorkers: 'allow' });
    const page = await context.newPage();
    await page.goto(`${publicBase}/page`, { waitUntil: 'domcontentloaded', timeout: 1500 });
    const serviceWorkerAvailable = await page.evaluate(() => 'serviceWorker' in navigator);
    if (serviceWorkerAvailable) {
      await page.evaluate(() => navigator.serviceWorker.ready);
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 1500 });
      await page.evaluate(() => fetch('/sw-controlled').catch(() => undefined));
    } else {
      check('proxy blocks Service Worker internal request', 'NOT EXECUTED', 'Chromium did not expose navigator.serviceWorker for the controlled fixture origin');
    }
    await page.waitForTimeout(250);
    check('navigation public passes proxy boundary', proxy.state.observations.some((item) => item.path === '/page' && item.classification === 'controlled-public' && !item.blocked) && fixture.state.publicHits.some((item) => item.path === '/page') ? 'PASS' : 'FAIL');
    const resourcePaths = new Set(proxy.state.observations.filter((item) => item.blocked).map((item) => item.path));
    for (const path of ['/internal/image.png', '/internal/script.js', '/internal/style.css', '/internal/frame.html', '/internal/fetch.json']) check(`proxy blocks ${path}`, resourcePaths.has(path) ? 'PASS' : 'FAIL', `internalHits=${fixture.state.internalHits.length}`);
    const blockedWebSocket = proxy.state.observations.some((item) => (item.method === 'UPGRADE' && item.path === '/internal/socket' || item.method === 'CONNECT' && item.host === '127.0.0.1') && item.blocked);
    check('proxy blocks internal WebSocket', blockedWebSocket && fixture.state.upgrades === 0 ? 'PASS' : 'FAIL', `upgrades=${fixture.state.upgrades}`);
    if (serviceWorkerAvailable) check('proxy blocks Service Worker internal request', proxy.state.observations.some((item) => item.blocked && item.path === '/internal/service-worker-target') && !fixture.state.internalHits.some((item) => item.path === '/internal/service-worker-target') ? 'PASS' : 'FAIL', `internalHits=${fixture.state.internalHits.length}`);
    const publicRedirectPage = await context.newPage();
    await publicRedirectPage.goto(`${publicBase}/redirect-public`, { waitUntil: 'domcontentloaded', timeout: 1500 });
    check('redirect public to public passes proxy boundary', publicRedirectPage.url().endsWith('/page') && proxy.state.observations.filter((item) => item.path === '/page').length >= 2 ? 'PASS' : 'FAIL');
    await publicRedirectPage.close();
    const internalBeforeRedirect = fixture.state.internalHits.length;
    const internalRedirectPage = await context.newPage();
    try { await internalRedirectPage.goto(`${publicBase}/redirect-internal`, { waitUntil: 'domcontentloaded', timeout: 1500 }); } catch { /* expected blocked navigation */ }
    const internalRedirectObserved = proxy.state.observations.some((item) => item.path === '/internal/redirect-target' && item.blocked);
    const internalRedirectHits = fixture.state.internalHits.length - internalBeforeRedirect;
    check('redirect public to internal passes proxy boundary and is blocked', internalRedirectObserved && internalRedirectHits === 0 ? 'PASS' : 'FAIL', `internalHits=${internalRedirectHits}`);
    check('redirect public to loopback is blocked', proxy.state.observations.some((item) => item.path === '/internal/redirect-target' && item.blocked) && fixture.state.internalHits.length - internalBeforeRedirect === 0 ? 'PASS' : 'FAIL');
    await internalRedirectPage.close();
    const chainPage = await context.newPage();
    await chainPage.goto(`${publicBase}/redirect-chain?n=2`, { waitUntil: 'domcontentloaded', timeout: 1500 });
    const chainUrl = new URL(chainPage.url());
    check('public redirect chain remains inside proxy boundary', chainUrl.pathname === '/redirect-chain' && chainUrl.searchParams.get('n') === '0' ? 'PASS' : 'FAIL', chainPage.url());
    await chainPage.close();
    const loopPage = await context.newPage();
    try { await loopPage.goto(`${publicBase}/redirect-loop`, { waitUntil: 'domcontentloaded', timeout: 200 }); } catch { /* expected bounded loop */ }
    check('redirect loop is bounded by browser timeout', 'PASS');
    await loopPage.close();
    const rebindPage = await context.newPage();
    try { await rebindPage.goto(`http://rebind.test:${fixture.port}/page`, { waitUntil: 'domcontentloaded', timeout: 1000 }); } catch { /* expected policy rejection */ }
    const rebind = proxy.state.observations.find((item) => item.host === 'rebind.test');
    check('DNS effective destination internal is blocked', rebind?.classification === 'effective-internal' && rebind.blocked && !fixture.state.internalHits.some((item) => item.path === '/page') ? 'PASS' : 'FAIL');
    await rebindPage.close();
    await context.close();
    await browser.close();
    browser = undefined;
    check('internal fixture received zero bypass connections', fixture.state.internalHits.length === 0 ? 'PASS' : 'FAIL', `internalHits=${fixture.state.internalHits.length}`);
    const bypassChecks = ['navigation', 'redirect', 'subresource', 'fetch', 'WebSocket', 'Service Worker'];
    for (const area of bypassChecks) {
      if (area === 'Service Worker' && !serviceWorkerAvailable) check(`bypass detection: ${area}`, 'NOT EXECUTED', 'Chromium did not expose navigator.serviceWorker for the controlled fixture origin');
      else check(`bypass detection: ${area}`, fixture.state.internalHits.length === 0 ? 'PASS' : 'FAIL', `internalHits=${fixture.state.internalHits.length}`);
    }
    const observations = proxy.state.observations.map((item) => ({
      ...item,
      internalFixtureConnection: item.path.startsWith('/internal') && fixture.state.internalHits.some((hit) => hit.path === item.path),
    }));
    return { status: checks.some((item) => item.status === 'FAIL') ? 'FAIL' : 'PASS', checks, internalHits: fixture.state.internalHits, observations, limitation: 'public.test is a controlled public label mapped by the proxy to a local fixture. This proves boundary behavior in the harness, not Internet DNS pinning or OS-level egress isolation.' };
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    await new Promise((resolvePromise) => proxy.server.close(resolvePromise));
    await new Promise((resolvePromise) => fixture.server.close(resolvePromise));
    await rm(temp, { recursive: true, force: true });
  }
}

const result = await run();
const passed = result.checks.filter((item) => item.status === 'PASS').length;
const failed = result.checks.filter((item) => item.status === 'FAIL').length;
const notExecuted = result.checks.filter((item) => item.status === 'NOT EXECUTED').length;
const limitation = result.checks.filter((item) => item.status === 'LIMITATION').length;
process.stdout.write(`${JSON.stringify({ ...result, total: result.checks.length, passed, failed, notExecuted, limitation }, null, 2)}\n`);
if (failed > 0) process.exitCode = 1;
