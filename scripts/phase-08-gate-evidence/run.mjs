import { createServer, request as httpRequest } from 'node:http';
import { chromium } from 'playwright';

const checks = [];
const state = { internalHits: [], observations: [] };

function check(name, status, details = '') {
  checks.push({ name, status, ...(details ? { details } : {}) });
}

function policyFor(hostname) {
  if (hostname === 'localhost') return { allowed: true, classification: 'controlled-local-public', destination: '127.0.0.1' };
  return { allowed: false, classification: 'loopback-or-internal', destination: hostname };
}

function observe(method, target, channel) {
  const policy = policyFor(target.hostname);
  const observation = {
    method,
    channel,
    host: target.hostname,
    path: target.pathname,
    destination: policy.destination,
    classification: policy.classification,
    boundaryObserved: true,
    blocked: !policy.allowed,
    protocol: target.protocol,
  };
  state.observations.push(observation);
  return policy;
}

async function startFixture() {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://fixture.local');
    if (url.pathname === '/page') {
      const body = `<!doctype html><script>navigator.serviceWorker.register('/sw.js')</script>`;
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
      return response.end('service worker controlled response');
    }
    if (url.pathname === '/internal/service-worker-target') {
      state.internalHits.push({ channel: 'Service Worker', path: url.pathname, method: request.method });
      response.writeHead(200, { 'content-type': 'text/plain' });
      return response.end('internal fixture reached');
    }
    response.writeHead(404);
    return response.end('not found');
  });
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('FIXTURE_START_FAILED');
  return { server, port: address.port };
}

function startProxy(fixturePort) {
  const server = createServer((request, response) => {
    const target = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    const policy = observe(request.method ?? 'GET', target, target.pathname.includes('service-worker') ? 'Service Worker' : 'fixture');
    if (!policy.allowed) {
      response.writeHead(403, { 'x-egress-boundary': 'blocked' });
      return response.end('egress blocked');
    }
    const upstream = httpRequest({ hostname: '127.0.0.1', port: fixturePort, method: request.method, path: `${target.pathname}${target.search}`, headers: { ...request.headers, host: `127.0.0.1:${fixturePort}` } }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
    request.pipe(upstream);
  });
  server.on('connect', (request, socket) => {
    const hostname = (request.url ?? '').split(':')[0];
    const target = new URL(`http://${hostname}/`);
    const policy = observe('CONNECT', target, 'Service Worker');
    socket.write(`HTTP/1.1 ${policy.allowed ? 200 : 403} ${policy.allowed ? 'Connection Established' : 'Forbidden'}\r\n\r\n`);
    socket.destroy();
  });
  return server;
}

async function main() {
  const fixture = await startFixture();
  const proxy = startProxy(fixture.port);
  let browser;
  let context;
  try {
    await new Promise((resolvePromise) => proxy.listen(0, '127.0.0.1', resolvePromise));
    const proxyPort = proxy.address().port;
    browser = await chromium.launch({
      headless: true,
      chromiumSandbox: true,
      proxy: { server: `http://127.0.0.1:${proxyPort}`, bypass: '' },
      // Fixture-only: Chromium normally bypasses proxies for loopback; this keeps the controlled localhost page on the boundary.
      args: ['--proxy-bypass-list=<-loopback>'],
    });
    context = await browser.newContext({ serviceWorkers: 'allow' });
    const page = await context.newPage();
    await page.goto(`http://localhost:${fixture.port}/page`, { waitUntil: 'domcontentloaded', timeout: 1500 });
    const available = await page.evaluate(() => 'serviceWorker' in navigator);
    if (!available) {
      check('Service Worker internal request', 'NOT EXECUTED', 'Chromium did not expose navigator.serviceWorker in the localhost fixture.');
    } else {
      await page.evaluate(() => navigator.serviceWorker.ready);
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 1500 });
      const requestAttempted = await page.evaluate(async () => {
        try { await fetch('/sw-controlled'); } catch { /* expected when the boundary blocks the worker's internal fetch */ }
        return true;
      });
      await page.waitForTimeout(200);
      const internalObservation = state.observations.find((item) => item.channel === 'Service Worker' && item.path === '/internal/service-worker-target');
      const internalHits = state.internalHits.length;
      const result = requestAttempted && internalObservation?.blocked && internalHits === 0 ? 'PASS' : 'FAIL';
      check('Service Worker internal request', result, JSON.stringify({ requestAttempted, proxyObserved: Boolean(internalObservation), destination: internalObservation?.destination ?? null, blocked: internalObservation?.blocked ?? false, internalHits }));
    }
    await context.close();
    await browser.close();
  } finally {
    if (context) await context.close().catch(() => undefined);
    if (browser) await browser.close().catch(() => undefined);
    await new Promise((resolvePromise) => proxy.close(resolvePromise));
    await new Promise((resolvePromise) => fixture.server.close(resolvePromise));
  }
  const passed = checks.filter((item) => item.status === 'PASS').length;
  const failed = checks.filter((item) => item.status === 'FAIL').length;
  const notExecuted = checks.filter((item) => item.status === 'NOT EXECUTED').length;
  return { status: failed > 0 ? 'FAIL' : 'PASS', total: checks.length, passed, failed, notExecuted, checks, observations: state.observations, internalHits: state.internalHits };
}

const result = await main();
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (result.failed > 0) process.exitCode = 1;
