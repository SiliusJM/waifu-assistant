import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const checks = [];

function check(name, status, details = '') {
  checks.push({ name, status, ...(details ? { details } : {}) });
}

async function startFixture() {
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://fixture.local').pathname;
    if (pathname === '/slow') {
      return setTimeout(() => {
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end('slow fixture');
      }, 250);
    }
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<!doctype html><html><body><h1>controlled isolation fixture</h1></body></html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('FIXTURE_START_FAILED');
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

async function pathExists(candidate) {
  try {
    await stat(candidate);
    return true;
  } catch {
    return false;
  }
}

async function run() {
  const fixture = await startFixture();
  const experimentRoot = await mkdtemp(join(tmpdir(), 'waifu-phase-08-host-isolation-'));
  const workspace = join(experimentRoot, 'workspace');
  const outsideWorkspace = join(experimentRoot, 'outside-workspace');
  await mkdir(workspace);
  await mkdir(outsideWorkspace);
  const outsideFile = join(outsideWorkspace, 'fictional-marker.txt');
  await writeFile(outsideFile, 'fictional isolation marker only');

  let browser;
  let firstContext;
  let secondContext;
  let shutdownContext;
  let timeoutObserved = false;
  let timeoutContextClosed = false;
  let shutdownContextClosed = false;
  let browserClosed = false;
  let fixtureClosed = false;
  let temporaryRootRemoved = false;
  try {
    browser = await chromium.launch({ headless: true, chromiumSandbox: true });

    firstContext = await browser.newContext();
    const firstPage = await firstContext.newPage();
    await firstPage.goto(fixture.origin, { waitUntil: 'domcontentloaded', timeout: 1500 });
    await firstPage.evaluate(() => {
      localStorage.setItem('fictional-token', 'not-a-credential');
      document.cookie = 'fictional-cookie=fixture-only; Path=/';
    });
    const firstState = await firstContext.storageState();
    await firstContext.close();
    firstContext = undefined;

    secondContext = await browser.newContext();
    const secondPage = await secondContext.newPage();
    await secondPage.goto(fixture.origin, { waitUntil: 'domcontentloaded', timeout: 1500 });
    const secondState = await secondContext.storageState();
    const inheritedStorage = await secondPage.evaluate(() => ({
      cookie: document.cookie,
      localStorage: localStorage.getItem('fictional-token'),
    }));
    const cleanContext = secondState.cookies.length === 0
      && secondState.origins.length === 0
      && inheritedStorage.cookie === ''
      && inheritedStorage.localStorage === null;
    check('ephemeral context starts without inherited storage', cleanContext ? 'PASS' : 'FAIL', JSON.stringify({
      firstContextStoredFixtureData: firstState.cookies.length > 0 || firstState.origins.length > 0,
      secondContextState: secondState,
      secondContextVisibleStorage: inheritedStorage,
    }));
    check('no persistent storage state supplied', 'PASS', 'newContext() was used without storageState or a persistent userDataDir.');

    const outsideFileUrl = pathToFileURL(outsideFile).href;
    const fileAccess = await secondPage.evaluate(async (url) => {
      try {
        const response = await fetch(url);
        return { accessible: true, status: response.status };
      } catch {
        return { accessible: false };
      }
    }, outsideFileUrl);
    check('browser-origin file access outside allowed workspace is inaccessible', fileAccess.accessible ? 'FAIL' : 'PASS', JSON.stringify({
      attemptedScheme: 'file:',
      browserResult: fileAccess,
    }));
    check('host OS filesystem isolation', 'LIMITATION', 'The page-level file:// denial does not prove a Windows OS-level filesystem boundary; no sandbox escape or privileged browser automation was attempted.');
    check('sandbox launch requested without disabling flags', 'PASS', 'chromiumSandbox=true was supplied and no --no-sandbox argument was supplied.');
    check('sandbox OS-level effectiveness', 'LIMITATION', 'Launch configuration is observable; OS-level sandbox effectiveness is not proven by this harness.');

    try {
      await secondPage.goto(`${fixture.origin}/slow`, { timeout: 25 });
    } catch {
      timeoutObserved = true;
    }
    await secondContext.close();
    timeoutContextClosed = true;
    secondContext = undefined;
    check('timeout is observed without leaving the context active', timeoutObserved && timeoutContextClosed ? 'PASS' : 'FAIL');

    shutdownContext = await browser.newContext();
    await shutdownContext.newPage();
    await shutdownContext.close();
    shutdownContextClosed = true;
    await browser.close();
    browserClosed = true;
    browser = undefined;
    check('orderly shutdown closes context and browser', shutdownContextClosed && browserClosed ? 'PASS' : 'FAIL');
  } finally {
    if (firstContext) await firstContext.close().catch(() => undefined);
    if (secondContext) await secondContext.close().catch(() => undefined);
    if (shutdownContext) await shutdownContext.close().catch(() => undefined);
    if (browser) await browser.close().catch(() => undefined);
    await new Promise((resolve) => fixture.server.close(resolve));
    fixtureClosed = true;
    await rm(experimentRoot, { recursive: true, force: true });
    temporaryRootRemoved = !(await pathExists(experimentRoot));
  }

  check('normal fixture and temporary directory cleanup', fixtureClosed && temporaryRootRemoved ? 'PASS' : 'FAIL', JSON.stringify({
    fixtureClosed,
    temporaryRootRemoved,
    temporaryDirectories: { experimentRoot, workspace, outsideWorkspace },
  }));
  check('crash cleanup', 'NOT EXECUTED', 'No safe crash reproduction is available without child_process, spawn, exec, shell or arbitrary process termination.');

  const passed = checks.filter((item) => item.status === 'PASS').length;
  const failed = checks.filter((item) => item.status === 'FAIL').length;
  const notExecuted = checks.filter((item) => item.status === 'NOT EXECUTED').length;
  const limitations = checks.filter((item) => item.status === 'LIMITATION').length;
  return {
    status: failed === 0 ? 'PASS' : 'FAIL',
    total: checks.length,
    passed,
    failed,
    notExecuted,
    limitations,
    checks,
    browser: 'Chromium via Playwright',
    chromiumSandboxRequested: true,
    persistentProfile: false,
    storageStateSupplied: false,
    temporaryDirectories: { experimentRoot, workspace, outsideWorkspace },
  };
}

const result = await run();
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (result.failed > 0) process.exitCode = 1;
