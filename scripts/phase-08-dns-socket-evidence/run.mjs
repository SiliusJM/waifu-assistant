import { createServer, request as httpRequest } from 'node:http';
import { createSocket } from 'node:dgram';
import { Resolver } from 'node:dns/promises';
import { chromium } from 'playwright';

const CONTROLLED_PUBLIC_IP = '127.0.0.2';
const INTERNAL_IP = '127.0.0.3';
const checks = [];
const dnsQueries = [];
const boundaryObservations = [];
const internalHits = [];

function check(name, status, details = '') {
  checks.push({ name, status, ...(details ? { details } : {}) });
}

function encodeDnsName(name) {
  const labels = name.split('.').map((label) => {
    const value = Buffer.from(label, 'ascii');
    return Buffer.concat([Buffer.from([value.length]), value]);
  });
  return Buffer.concat([...labels, Buffer.from([0])]);
}

function readDnsQuestion(packet) {
  let offset = 12;
  const labels = [];
  while (offset < packet.length) {
    const length = packet[offset];
    offset += 1;
    if (length === 0) break;
    labels.push(packet.subarray(offset, offset + length).toString('ascii'));
    offset += length;
  }
  const questionEnd = offset + 4;
  return {
    name: labels.join('.').toLowerCase(),
    type: packet.readUInt16BE(offset),
    question: packet.subarray(12, questionEnd),
  };
}

function encodeIpv4(address) {
  return Buffer.from(address.split('.').map((octet) => Number(octet)));
}

function createDnsResponse(query, question, address) {
  const header = Buffer.alloc(12);
  query.copy(header, 0, 0, 2);
  header.writeUInt16BE(0x8180, 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(address ? 1 : 0, 6);

  if (!address) return Buffer.concat([header, question]);

  const answer = Buffer.alloc(16);
  answer.writeUInt16BE(0xc00c, 0);
  answer.writeUInt16BE(1, 2);
  answer.writeUInt16BE(1, 4);
  answer.writeUInt32BE(1, 6);
  answer.writeUInt16BE(4, 10);
  encodeIpv4(address).copy(answer, 12);
  return Buffer.concat([header, question, answer]);
}

async function startDnsFixture() {
  const answers = new Map([
    ['public.test', [CONTROLLED_PUBLIC_IP]],
    ['internal.test', [INTERNAL_IP]],
    ['rebind.test', [CONTROLLED_PUBLIC_IP, INTERNAL_IP]],
  ]);
  const counts = new Map();
  const server = createSocket('udp4');

  server.on('message', (packet, remote) => {
    const question = readDnsQuestion(packet);
    const sequence = answers.get(question.name) ?? [];
    const count = counts.get(question.name) ?? 0;
    const address = sequence[Math.min(count, Math.max(sequence.length - 1, 0))] ?? null;
    counts.set(question.name, count + 1);
    dnsQueries.push({
      hostname: question.name,
      type: question.type,
      answer: address,
      queryNumber: count + 1,
      client: `${remote.address}:${remote.port}`,
    });
    server.send(createDnsResponse(packet, question.question, address), remote.port, remote.address);
  });

  await new Promise((resolvePromise) => server.bind(0, '127.0.0.1', resolvePromise));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('DNS_FIXTURE_START_FAILED');
  return { server, port: address.port, counts };
}

async function startHttpFixture(host, port, role) {
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', `http://${host}`).pathname;
    if (role === 'internal') {
      internalHits.push({ host, path, method: request.method });
      response.writeHead(200, { 'content-type': 'text/plain' });
      return response.end('internal fixture reached');
    }
    response.writeHead(200, { 'content-type': 'text/plain' });
    return response.end('controlled public fixture');
  });

  await new Promise((resolvePromise) => server.listen(port, host, resolvePromise));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('HTTP_FIXTURE_START_FAILED');
  return { server, port: address.port };
}

async function resolveAddress(resolver, hostname) {
  const addresses = await resolver.resolve4(hostname);
  const address = addresses[0];
  if (!address) throw new Error(`DNS_EMPTY_ANSWER:${hostname}`);
  return address;
}

async function startBoundary(dnsPort, publicPort) {
  const resolver = new Resolver();
  resolver.setServers([`127.0.0.1:${dnsPort}`]);
  const requestUpstream = (options, resolvePromise) => {
    const upstream = httpRequest(options, resolvePromise);
    upstream.on('socket', (socket) => {
      socket.once('connect', () => {
        const observation = boundaryObservations.at(-1);
        if (observation) observation.socketRemoteAddress = socket.remoteAddress ?? null;
      });
    });
    return upstream;
  };
  const server = createServer(async (request, response) => {
    const target = new URL(request.url ?? '/', `http://${request.headers.host ?? 'invalid.test'}`);
    const hostname = target.hostname.toLowerCase();
    const validatedIp = await resolveAddress(resolver, hostname);
    const resolution = [{ phase: 'validated', ip: validatedIp }];
    let effectiveIp = validatedIp;
    if (hostname === 'rebind.test') {
      effectiveIp = await resolveAddress(resolver, hostname);
      resolution.push({ phase: 'effective', ip: effectiveIp });
    }
    const allowed = hostname === 'public.test' && effectiveIp === CONTROLLED_PUBLIC_IP && target.port === String(publicPort);
    const observation = {
      hostname,
      requestedPort: target.port,
      validatedIp,
      effectiveIp,
      resolution,
      blocked: !allowed,
      socketRemoteAddress: null,
      internalHitsBefore: internalHits.length,
    };
    boundaryObservations.push(observation);

    if (!allowed) {
      response.writeHead(403, { 'x-dns-egress-boundary': 'blocked' });
      return response.end('dns egress blocked');
    }

    const upstream = await new Promise((resolvePromise, rejectPromise) => {
      const requestOptions = {
        hostname: effectiveIp,
        port: publicPort,
        method: request.method,
        path: `${target.pathname}${target.search}`,
        headers: { ...request.headers, host: `public.test:${publicPort}` },
      };
      const clientRequest = requestUpstream(requestOptions, resolvePromise);
      clientRequest.on('error', rejectPromise);
      request.pipe(clientRequest);
    });
    response.writeHead(upstream.statusCode ?? 502, upstream.headers);
    upstream.pipe(response);
  });

  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('BOUNDARY_START_FAILED');
  return { server, port: address.port };
}

async function run() {
  const dns = await startDnsFixture();
  const publicFixture = await startHttpFixture(CONTROLLED_PUBLIC_IP, 0, 'public');
  const internalFixture = await startHttpFixture(INTERNAL_IP, publicFixture.port, 'internal');
  const boundary = await startBoundary(dns.port, publicFixture.port);
  let browser;
  let context;

  try {
    browser = await chromium.launch({
      headless: true,
      chromiumSandbox: true,
      proxy: { server: `http://127.0.0.1:${boundary.port}`, bypass: '' },
      args: ['--proxy-bypass-list=<-loopback>'],
    });
    context = await browser.newContext();
    const page = await context.newPage();

    const publicResponse = await page.goto(`http://public.test:${publicFixture.port}/page`, { waitUntil: 'domcontentloaded', timeout: 1500 });
    const publicObservation = boundaryObservations.at(-1);
    const publicPass = publicResponse?.status() === 200
      && publicObservation?.validatedIp === CONTROLLED_PUBLIC_IP
      && publicObservation.effectiveIp === CONTROLLED_PUBLIC_IP
      && publicObservation.socketRemoteAddress === CONTROLLED_PUBLIC_IP
      && internalHits.length === 0;
    check('controlled public hostname uses validated effective socket', publicPass ? 'PASS' : 'FAIL', JSON.stringify({ status: publicResponse?.status() ?? null, observation: publicObservation ?? null, internalHits }));

    const internalResponse = await page.goto(`http://internal.test:${internalFixture.port}/internal-target`, { waitUntil: 'domcontentloaded', timeout: 1500 });
    const internalObservation = boundaryObservations.at(-1);
    const internalPass = internalResponse?.status() === 403
      && internalObservation?.blocked === true
      && internalObservation.effectiveIp === INTERNAL_IP
      && internalObservation.socketRemoteAddress === null
      && internalHits.length === 0;
    check('internal effective destination is blocked before socket connection', internalPass ? 'PASS' : 'FAIL', JSON.stringify({ status: internalResponse?.status() ?? null, observation: internalObservation ?? null, internalHits }));

    const rebindResponse = await page.goto(`http://rebind.test:${publicFixture.port}/rebind-target`, { waitUntil: 'domcontentloaded', timeout: 1500 });
    const rebindObservation = boundaryObservations.at(-1);
    const rebindSimulated = rebindResponse?.status() === 403
      && rebindObservation?.resolution?.[0]?.ip === CONTROLLED_PUBLIC_IP
      && rebindObservation.resolution?.[1]?.ip === INTERNAL_IP
      && rebindObservation.blocked === true
      && rebindObservation.socketRemoteAddress === null
      && internalHits.length === 0;
    check('controlled DNS answer change is revalidated and blocked', rebindSimulated ? 'SIMULATED' : 'FAIL', JSON.stringify({ status: rebindResponse?.status() ?? null, observation: rebindObservation ?? null, internalHits }));
  } finally {
    if (context) await context.close().catch(() => undefined);
    if (browser) await browser.close().catch(() => undefined);
    await new Promise((resolvePromise) => boundary.server.close(resolvePromise));
    await new Promise((resolvePromise) => publicFixture.server.close(resolvePromise));
    await new Promise((resolvePromise) => internalFixture.server.close(resolvePromise));
    await new Promise((resolvePromise) => dns.server.close(resolvePromise));
  }

  const passed = checks.filter((item) => item.status === 'PASS').length;
  const failed = checks.filter((item) => item.status === 'FAIL').length;
  const notExecuted = checks.filter((item) => item.status === 'NOT EXECUTED').length;
  const simulated = checks.filter((item) => item.status === 'SIMULATED').length;
  return { status: failed > 0 ? 'FAIL' : 'PASS', total: checks.length, passed, failed, notExecuted, simulated, checks, dnsQueries, boundaryObservations, internalHits };
}

const result = await run();
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (result.failed > 0) process.exitCode = 1;
