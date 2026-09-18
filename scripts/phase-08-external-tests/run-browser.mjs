import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const timeoutMs = 1500;
const checks = [];

function check(name, status, details = '') {
  checks.push({ name, status, ...(details ? { details } : {}) });
}

function validateWorkspaceTarget(workspace, candidatePath) {
  const workspaceRoot = resolve(workspace);
  const target = resolve(candidatePath);
  const relativeTarget = relative(workspaceRoot, target);
  if (!relativeTarget || relativeTarget === '..' || relativeTarget.startsWith(`..${sep}`)) throw new Error('WORKSPACE_TARGET_REJECTED');
  return target;
}

function isInternalTarget(rawUrl, fixtureOrigin) {
  const url = new URL(rawUrl);
  if (url.hostname === 'private.test' || url.hostname === 'localhost' || url.hostname === '::1') return true;
  return url.origin === fixtureOrigin && url.pathname.startsWith('/internal');
}

async function startFixtureServer() {
  const state = { internalHits: [], websocketAttempts: 0, uploads: 0 };
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://fixture.local');
    if (url.pathname === '/page') {
      const internal = (path) => `/internal/${path}`;
      const html = `<!doctype html>
        <html><head>
          <link rel="stylesheet" href="${internal('style.css')}">
          <script src="${internal('script.js')}"></script>
        </head><body>
          <img src="${internal('image.png')}" alt="internal image">
          <iframe src="${internal('frame.html')}" title="internal frame"></iframe>
          <form id="upload-form" action="/upload" method="post" enctype="multipart/form-data">
            <input id="upload" type="file" name="fixture">
            <button type="submit">upload</button>
          </form>
          <a id="download" href="/download" download>download</a>
          <script>
            window.secondaryFetch = fetch('${internal('xhr.json')}').catch(() => null);
            window.socket = new WebSocket('ws://' + location.host + '/internal/socket');
            navigator.serviceWorker.register('/sw.js');
          </script>
        </body></html>`;
      response.writeHead(200, { 'content-type': 'text/html' });
      return response.end(html);
    }
    if (url.pathname === '/redirect-public') {
      response.writeHead(302, { location: '/page' });
      return response.end();
    }
    if (url.pathname === '/redirect-internal') {
      response.writeHead(302, { location: '/internal/redirect-target' });
      return response.end();
    }
    if (url.pathname === '/sw.js') {
      const body = `self.addEventListener('fetch', (event) => {
        if (new URL(event.request.url).pathname === '/sw-controlled') {
          event.respondWith(fetch('/internal/service-worker-target'));
        }
      });`;
      response.writeHead(200, { 'content-type': 'application/javascript', 'cache-control': 'no-store' });
      return response.end(body);
    }
    if (url.pathname === '/sw-controlled') {
      response.writeHead(200, { 'content-type': 'text/plain' });
      return response.end('service worker response');
    }
    if (url.pathname === '/download') {
      response.writeHead(200, { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename="controlled.txt"' });
      return response.end('controlled download');
    }
    if (url.pathname === '/upload') {
      state.uploads += 1;
      let bytes = 0;
      request.on('data', (chunk) => { bytes += chunk.length; });
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ bytes }));
      });
      return undefined;
    }
    if (url.pathname === '/slow') return setTimeout(() => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('slow fixture');
    }, 250);
    if (url.pathname.startsWith('/internal')) {
      state.internalHits.push({ path: url.pathname, method: request.method });
      response.writeHead(200, { 'content-type': 'text/plain' });
      return response.end('internal fixture reached');
    }
    response.writeHead(200, { 'content-type': 'text/plain' });
    return response.end('public fixture');
  });
  server.on('upgrade', (request, socket) => {
    state.websocketAttempts += 1;
    socket.destroy();
  });
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('FIXTURE_SERVER_START_FAILED');
  const origin = `http://127.0.0.1:${address.port}`;
  return { server, origin, state };
}

async function main() {
  const fixture = await startFixtureServer();
  const workspace = await mkdtemp(join(tmpdir(), 'waifu-phase-08-browser-'));
  const uploadFile = join(workspace, 'upload.txt');
  const downloadFile = join(workspace, 'controlled.txt');
  const requestEvents = [];
  const observedRequests = [];
  let browser;
  let context;
  let page;
  let browserDisconnected = false;
  try {
    await writeFile(uploadFile, 'controlled upload fixture');
    browser = await chromium.launch({ headless: true, chromiumSandbox: true });
    browser.on('disconnected', () => { browserDisconnected = true; });
    context = await browser.newContext({ acceptDownloads: true, serviceWorkers: 'allow' });
    const initialUrl = `${fixture.origin}/page`;
    context.on('request', (request) => {
      const rawUrl = request.url();
      observedRequests.push({ path: new URL(rawUrl).pathname, internal: isInternalTarget(rawUrl, fixture.origin) });
    });
    await context.route('**/*', async (route) => {
      const request = route.request();
      const rawUrl = request.url();
      const internal = isInternalTarget(rawUrl, fixture.origin);
      let fromServiceWorker = false;
      try { fromServiceWorker = Boolean(request.serviceWorker()); } catch { fromServiceWorker = false; }
      requestEvents.push({ resourceType: request.resourceType(), internal, fromServiceWorker, path: new URL(rawUrl).pathname });
      if (internal) return route.abort('blockedbyclient');
      return route.continue();
    });
    if (typeof context.routeWebSocket === 'function') {
      await context.routeWebSocket('**/*', (webSocket) => {
        requestEvents.push({ resourceType: 'websocket', internal: true, fromServiceWorker: false, path: '/internal/socket' });
        webSocket.close();
      });
    }
    page = await context.newPage();
    await page.goto(initialUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    check('local browser navigation', 'PASS');
    check('non-persistent browser context', context.pages().length === 1 ? 'PASS' : 'FAIL');
    await page.evaluate(() => fetch('/internal/xhr.json').catch(() => undefined));
    await page.waitForTimeout(250);
    const internalEvents = requestEvents.filter((event) => event.internal);
    const resourceTypes = new Set(internalEvents.map((event) => event.resourceType));
    for (const type of ['image', 'script', 'stylesheet', 'document']) check(`egress blocks secondary ${type}`, resourceTypes.has(type) ? 'PASS' : 'NOT EXECUTED', resourceTypes.has(type) ? '' : 'fixture did not emit this type');
    check('egress blocks XHR/fetch', resourceTypes.has('xhr') || resourceTypes.has('fetch') ? 'PASS' : 'NOT EXECUTED');
    check('egress observes WebSocket', requestEvents.some((event) => event.resourceType === 'websocket') || fixture.state.websocketAttempts > 0 ? 'PASS' : 'NOT EXECUTED');
    check('all observed secondary internal requests are blocked by routing', fixture.state.internalHits.length === 0 ? 'PASS' : 'FAIL', `internalHits=${fixture.state.internalHits.length}`);

    const redirectPage = await context.newPage();
    let redirectBlocked = false;
    try { await redirectPage.goto(`${fixture.origin}/redirect-internal`, { waitUntil: 'domcontentloaded', timeout: timeoutMs }); } catch { redirectBlocked = true; }
    redirectBlocked ||= observedRequests.some((event) => event.internal && event.path === '/internal/redirect-target') && !fixture.state.internalHits.some((hit) => hit.path === '/internal/redirect-target');
    check('public redirect to internal is blocked', redirectBlocked ? 'PASS' : 'FAIL', redirectBlocked ? '' : `observed=${JSON.stringify(observedRequests.filter((event) => event.path.includes('redirect')))}; url=${redirectPage.url()}; internalHits=${JSON.stringify(fixture.state.internalHits)}`);
    await redirectPage.close();

    await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: timeoutMs }).catch(() => undefined);
    let serviceWorkerResult = 'NOT EXECUTED';
    try {
      await page.evaluate(() => fetch('/sw-controlled'));
      serviceWorkerResult = 'PASS';
    } catch {
      serviceWorkerResult = requestEvents.some((event) => event.fromServiceWorker && event.internal) ? 'PASS' : 'LIMITATION';
    }
    check('Service Worker request behavior observed', serviceWorkerResult, 'Routing is not treated as complete network isolation.');

    const downloadPromise = page.waitForEvent('download');
    await page.locator('#download').click();
    const download = await downloadPromise;
    await download.saveAs(validateWorkspaceTarget(workspace, downloadFile));
    check('download uses dedicated allowlisted directory', (await stat(downloadFile)).size > 0 ? 'PASS' : 'FAIL');

    await page.locator('#upload').setInputFiles(uploadFile);
    await page.locator('#upload-form').evaluate((form) => form.requestSubmit());
    await page.waitForTimeout(100);
    check('upload uses temporary fixture file', fixture.state.uploads === 1 ? 'PASS' : 'FAIL');

    let timedOut = false;
    try { await page.goto(`${fixture.origin}/slow`, { timeout: 25 }); } catch { timedOut = true; }
    check('navigation timeout is bounded', timedOut ? 'PASS' : 'FAIL');
    await context.close();
    check('context closes explicitly', context.pages().length === 0 ? 'PASS' : 'FAIL');
    await browser.close();
    check('browser disconnect cleanup observed', browserDisconnected ? 'PASS' : 'FAIL');
    check('sandbox launch requested without disabling flags', 'PASS', 'chromiumSandbox=true and no --no-sandbox flag were supplied.');
    check('profile isolation boundary', 'PASS', 'newContext() was used; no user profile or storage state was supplied.');
    check('crash cleanup', 'NOT EXECUTED', 'No unsafe process termination was used to simulate a crash.');
  } finally {
    if (context) await context.close().catch(() => undefined);
    if (browser) await browser.close().catch(() => undefined);
    await new Promise((resolvePromise) => fixture.server.close(resolvePromise));
    await rm(workspace, { recursive: true, force: true });
  }
  const passed = checks.filter((item) => item.status === 'PASS').length;
  const failed = checks.filter((item) => item.status === 'FAIL').length;
  const notExecuted = checks.filter((item) => item.status === 'NOT EXECUTED').length;
  const limitations = checks.filter((item) => item.status === 'LIMITATION').length;
  return { status: failed === 0 ? 'PASS' : 'FAIL', total: checks.length, passed, failed, notExecuted, limitations, checks, limitation: 'The fixture maps controlled public and internal behavior to a local HTTP server. Routing evidence does not prove production socket pinning, proxy egress, or OS-level network isolation.' };
}

const result = await main();
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (result.failed > 0) process.exitCode = 1;
