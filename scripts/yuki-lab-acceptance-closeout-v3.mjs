import { performance } from 'node:perf_hooks';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import {
  AssistantCore,
  ConversationRunner,
  DirectAIProvider,
  LOCAL_TOOL_ALLOWLIST,
  createLocalToolManager,
  createLogger,
} from '../dist/index.js';
import { CURRENT_DATA_HONESTY_POLICY } from '../dist/core/current-data-policy.js';
import { PersonalityCompiler } from '../dist/personality/personality-compiler.js';
import { PersonalityRegistry } from '../dist/personality/personality-registry.js';
import { ProviderRequestBudget, createCountingFetch } from './provider-call-budget.mjs';

export const ROUTE = 'yuki-lab-chat';
export const MAX_PROVIDER_REQUESTS = 12;

function safeModel(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,100}$/u.test(value)) return undefined;
  if (/^[a-f0-9]{24,}$/iu.test(value) || /^[0-9a-f-]{32,}$/iu.test(value) || value.includes('@')) return undefined;
  return value;
}

function excerpt(text, maximum = 180) {
  const compact = String(text ?? '').replace(/\s+/gu, ' ').trim();
  return compact.length <= maximum ? compact : `${compact.slice(0, maximum - 1)}…`;
}

export function classifyNonLive(text, { promptMatches, policyPresent, sessionContaminated, prompt }) {
  if (!promptMatches || !policyPresent || sessionContaminated) return 'EVALUATOR_FAILURE';
  const value = String(text ?? '').normalize('NFKC').trim();
  const osuPrompt = /osu!/iu.test(prompt ?? '');
  const explainsConcept = value.length >= 30 && (osuPrompt
    ? /(?:ranking|clasificaci[oó]n|posici[oó]n|orden|jugadores|rendimiento|puntuaci[oó]n|tabla|comparar|jugar)/iu.test(value)
    : /(?:bitcoin|criptomoneda|moneda|blo[cq]ue|descentralizad|transaccion|red digital|activo digital)/iu.test(value));
  if (explainsConcept) return 'PASS';
  const needlessRefusalOrDeferral = /(?:no puedo (?:ayudarte|responder|explicar)|no tengo acceso|no dispongo de datos|¿(?:te refieres|quieres decir)|\?\s*$)/iu.test(value);
  return needlessRefusalOrDeferral ? 'MINOR_MODEL_OVER_REFUSAL' : 'PRODUCT_FAILURE';
}

export function classifyUnicode(text) {
  const value = String(text ?? '').trim();
  const expected = 'ñ á ü 🌸';
  if (value === expected) return 'PASS';
  if (/[�]|(?:Ã±|Ã¡|Ã¼|ðŸ)/u.test(value)) return 'UTF8_TRANSPORT_FAILURE';
  return 'MINOR_MODEL_INSTRUCTION_FAILURE';
}

export function evaluateStreamingRounds({ rounds, finalText }) {
  if (!Array.isArray(rounds) || typeof finalText !== 'string') return 'NOT_VERIFIED';
  const ids = rounds.map(({ requestId }) => requestId).filter(Boolean);
  if (ids.length !== rounds.length || new Set(ids).size !== ids.length) return 'NOT_VERIFIED';
  const finalRound = [...rounds].reverse().find(({ kind }) => kind === 'final');
  if (!finalRound || finalRound.text !== finalText) return 'NOT_VERIFIED';
  if (!Array.isArray(finalRound.deltas) || finalRound.deltas.length === 0) return finalText ? 'BUFFERED' : 'NOT_VERIFIED';
  return finalRound.deltas.join('') === finalText ? 'PASS' : 'FAIL';
}

export function evaluateInterruptionWindow({ interactionId, events, requestAId, requestBId, bOwnershipAt, assistantMessages, maxActive, expectedText = '256' }) {
  if (!interactionId || !Array.isArray(events) || !Number.isFinite(bOwnershipAt)) return { status: 'NOT_VERIFIED' };
  const local = events.filter((event) => event.interactionId === interactionId);
  const requestA = local.find((event) => event.type === 'request-start' && event.requestId === requestAId);
  const requestB = local.find((event) => event.type === 'request-start' && event.requestId === requestBId);
  const aAborted = local.some((event) => event.type === 'request-abort' && event.requestId === requestAId);
  const bFinal = local.some((event) => event.type === 'response' && event.requestId === requestBId && event.text?.trim() === expectedText);
  const staleDelta = local.some((event) => event.type === 'delta' && event.requestId === requestAId && event.at >= bOwnershipAt);
  const staleCompletion = local.some((event) => event.type === 'response' && event.requestId === requestAId && event.at >= bOwnershipAt);
  const partialA = assistantMessages?.some((message) => message.requestId === requestAId) ?? false;
  const complete = Boolean(requestA && aAborted && requestB && bFinal && !partialA
    && !staleDelta && !staleCompletion && maxActive === 1);
  return {
    status: complete ? 'PASS' : requestA && requestB && aAborted && Number.isInteger(maxActive) ? 'FAIL' : 'NOT_VERIFIED',
    aIssued: Boolean(requestA), aAborted, bIssued: Boolean(requestB),
    expectedText, bFinalExpected: bFinal, ...(expectedText === '256' ? { bFinal256: bFinal } : {}),
    partialAPersisted: partialA, staleDelta, staleCompletion, maxActive,
  };
}

function quietLogger() {
  return createLogger({ sink: { info() {}, warn() {}, error() {} } });
}

function safeError(error) {
  return {
    name: typeof error?.name === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(error.name) ? error.name : 'Error',
    code: typeof error?.code === 'string' && /^[A-Z0-9_]{1,64}$/u.test(error.code) ? error.code : 'UNKNOWN_ERROR',
    statusCode: typeof error?.statusCode === 'number' ? error.statusCode : undefined,
  };
}

function lastUser(messages) {
  return [...messages].reverse().find((message) => message?.role === 'user')?.content ?? '';
}

function createLiveContext(budget) {
  const baseURL = process.env.AI_BASE_URL?.trim();
  const apiKey = process.env.AI_API_KEY?.trim();
  if (!baseURL || !apiKey) throw new Error('Direct provider configuration is incomplete.');
  const requests = [];
  const events = [];
  const startedAt = performance.now();
  let context;
  let requestNumber = 0;
  const active = new Set();
  const observedFetch = async (input, init = {}) => {
    let body;
    try { body = JSON.parse(String(init.body ?? '{}')); } catch { body = undefined; }
    const id = `v3-${++requestNumber}`;
    const request = {
      id, startedAt: performance.now(), finishedAt: undefined, abortedAt: undefined,
      statusCode: undefined,
      promptMatches: false,
      policyPresent: Array.isArray(body?.messages) && body.messages.some((message) => message?.role === 'system'
        && typeof message.content === 'string' && message.content.includes(CURRENT_DATA_HONESTY_POLICY)),
      userMessageCount: Array.isArray(body?.messages) ? body.messages.filter((message) => message?.role === 'user').length : 0,
      toolRound: Array.isArray(body?.messages) && body.messages.some((message) => message?.role === 'tool' || message?.tool_calls),
      model: safeModel(body?.model),
      ttftMs: undefined,
    };
    request.userText = lastUser(body?.messages ?? []);
    request.promptMatches = false;
    requests.push(request);
    active.add(id);
    if (context) context.maxActiveRequests = Math.max(context.maxActiveRequests, active.size);
    events.push({ type: 'request-start', requestId: id, at: request.startedAt });
    const settle = () => {
      if (request.finishedAt !== undefined) return;
      request.finishedAt = performance.now();
      active.delete(id);
    };
    const onAbort = () => {
      request.abortedAt ??= performance.now();
      events.push({ type: 'request-abort', requestId: id, at: request.abortedAt });
      if (context) {
        if (init.signal?.reason?.name === 'TimeoutError') context.errors.timeout += 1;
        else context.errors.aborted += 1;
      }
    };
    init.signal?.addEventListener('abort', onAbort, { once: true });
    let response;
    try {
      response = await fetch(input, init);
      request.statusCode = response.status;
      if (context) {
        if (response.status >= 400 && response.status < 500) context.errors.http4xx += 1;
        if (response.status >= 500) context.errors.http5xx += 1;
      }
      if (response.status >= 400) context?.onProviderError?.();
    } catch (error) {
      settle();
      init.signal?.removeEventListener('abort', onAbort);
      if (!init.signal?.aborted) context?.onProviderError?.();
      if (context) {
        if (!init.signal?.aborted) context.errors.transport += 1;
      }
      throw error;
    }
    if (!response.body) {
      settle();
      init.signal?.removeEventListener('abort', onAbort);
      if (response.status >= 400) context?.onProviderError?.();
      return response;
    }
    const reader = response.body.getReader();
    const wrapped = new ReadableStream({
      async pull(controller) {
        try {
          const part = await reader.read();
          if (part.done) {
            settle();
            init.signal?.removeEventListener('abort', onAbort);
            controller.close();
          } else {
            request.ttftMs ??= Math.round(performance.now() - request.startedAt);
            controller.enqueue(part.value);
          }
        } catch (error) {
          settle();
          init.signal?.removeEventListener('abort', onAbort);
          if (!init.signal?.aborted) context?.onProviderError?.();
          if (context && !init.signal?.aborted) context.errors.transport += 1;
          controller.error(error);
        }
      },
      async cancel(reason) {
        try { await reader.cancel(reason); } finally { settle(); init.signal?.removeEventListener('abort', onAbort); }
      },
    });
    return new Response(wrapped, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
  const fetchImpl = createCountingFetch({ budget, fetchImpl: observedFetch });
  const provider = new DirectAIProvider({
    baseURL, apiKey, model: ROUTE, timeoutMs: Number(process.env.AI_TIMEOUT_MS ?? 30_000),
    retryPolicy: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 }, fetchImpl,
  });
  const core = new AssistantCore({ provider, logger: quietLogger(), toolManager: createLocalToolManager(), toolAllowlist: LOCAL_TOOL_ALLOWLIST });
  const personality = new PersonalityCompiler().compile({ profile: new PersonalityRegistry().defaultProfile });
  context = { budget, provider, core, personality, requests, events, active, startedAt,
    maxActiveRequests: 0, models: new Set(), responseModels: new Set(), errors: { http4xx: 0, http5xx: 0, timeout: 0, transport: 0, aborted: 0 }, onProviderError: undefined };
  return context;
}

async function runConversation(context, inputSource, options = {}) {
  const session = context.core.createSession();
  const runner = new ConversationRunner(context.core, session);
  const requestStart = context.requests.length;
  const deltasByRequest = new Map();
  const responses = [];
  const deltas = [];
  const activeRequestId = () => {
    if (context.active.size === 1) return [...context.active][0];
    const currentRequests = context.requests.slice(requestStart);
    return currentRequests.length === 1 ? currentRequests[0].id : undefined;
  };
  let result;
  let error;
  try { result = await runner.run(inputSource, {
    personality: context.personality,
    interruptible: options.interruptible ?? false,
    onDelta(delta) {
      const requestId = activeRequestId();
      const at = performance.now();
      deltas.push({ requestId, at, delta });
      if (requestId) deltasByRequest.set(requestId, [...(deltasByRequest.get(requestId) ?? []), delta]);
      options.onDelta?.(delta, { requestId, at });
    },
    onResponse(response) {
      const currentRequests = context.requests.slice(requestStart);
      const matching = currentRequests.filter((request) => (deltasByRequest.get(request.id) ?? []).join('') === response.text);
      const latestUserText = lastUser(session.getMessages());
      const promptMatch = [...currentRequests].reverse().find((request) => request.userText === latestUserText);
      const requestId = matching.length === 1 ? matching[0].id : promptMatch?.id ?? activeRequestId();
      const at = performance.now();
      if (safeModel(response.model)) {
        context.responseModels.add(safeModel(response.model));
        if (response.model !== ROUTE) context.models.add(safeModel(response.model));
      }
      responses.push({ response, requestId, at });
      options.onResponse?.(response, { requestId, at });
    },
    onInterruption() { options.onInterruption?.(performance.now()); },
  }); } catch (caught) { error = safeError(caught); }
  return { session, result, responses, deltas, error };
}

async function* values(items) { yield* items; }

async function runOne(context, prompt, { retainEvaluationText = false } = {}) {
  const start = context.requests.length;
  const run = await runConversation(context, values([prompt, '/exit']));
  const responseRecord = run.responses.at(-1);
  const text = responseRecord?.response.text ?? '';
  const requests = context.requests.slice(start);
  const userMessages = run.session.getMessages().filter(({ role }) => role === 'user');
  const request = requests[0];
  if (request) request.promptMatches = request.userText === prompt;
  const semantic = classifyNonLive(text, {
    promptMatches: requests.length > 0 && requests.every((item) => item.userText === prompt),
    policyPresent: requests.length > 0 && requests.every((item) => item.policyPresent),
    sessionContaminated: userMessages.length !== 1 || userMessages[0]?.content !== prompt,
    prompt,
  });
  return {
    status: run.result?.status === 'completed' ? semantic : 'NOT_VERIFIED',
    responseExcerpt: excerpt(text),
    provider: responseRecord?.response.provider === 'direct-http' ? 'direct-http' : undefined,
    model: safeModel(responseRecord?.response.model),
    promptCorrect: requests.length > 0 && requests.every((item) => item.userText === prompt),
    currentDataPolicyPresent: requests.length > 0 && requests.every((item) => item.policyPresent),
    sessionContaminated: userMessages.length !== 1 || userMessages[0]?.content !== prompt,
    providerRequests: requests.length,
    statusCodes: requests.map(({ statusCode }) => statusCode),
    runStatus: run.result?.status ?? 'failed',
    error: run.error,
    deltaCounts: roundDeltas(run, requests).map(({ deltas }) => deltas.length),
    ...((retainEvaluationText || prompt.startsWith('Responde exactamente:')) ? { evaluationText: text } : {}),
  };
}

function roundDeltas(run, requests) {
  return requests.map((request) => ({
    requestId: request.id,
    deltas: run.deltas.filter((delta) => delta.requestId === request.id).map(({ delta }) => delta),
  }));
}

async function runUnicode(context) {
  if (!context.budget.canReserve(3)) return { status: 'NOT_VERIFIED', reason: 'BUDGET_RESERVE' };
  const result = await runOne(context, 'Responde exactamente: ñ á ü 🌸');
  const classification = classifyUnicode(result.evaluationText);
  delete result.evaluationText;
  return { ...result, status: classification, exact: classification === 'PASS', classification };
}

export async function runInterruption(context, expectedText = '256') {
  if (!context.budget.canReserve(2)) return { status: 'NOT_VERIFIED', reason: 'BUDGET_RESERVE' };
  const interactionId = `interrupt-${Math.round(performance.now())}`;
  const requestStart = context.requests.length;
  const inputReady = {};
  inputReady.promise = new Promise((resolvePromise) => { inputReady.resolve = resolvePromise; });
  const exitReady = {};
  exitReady.promise = new Promise((resolvePromise) => { exitReady.resolve = resolvePromise; });
  let bOwnershipAt;
  let aRequestId;
  let bRequestId;
  const timer = setTimeout(() => exitReady.resolve(), context.interruptionTimeoutMs ?? 45_000);
  context.onProviderError = () => { inputReady.resolve(); exitReady.resolve(); };
  try {
    const run = await runConversation(context, (async function* () {
      yield 'Explícame detalladamente cómo funciona una API y da varios ejemplos.';
      await inputReady.promise;
      yield `Detente. Responde únicamente: ${expectedText}`;
      await exitReady.promise;
      yield '/exit';
    }()), {
      interruptible: true,
      onDelta(delta, event) {
        const request = context.requests.find((item) => item.id === event.requestId);
        if (!bOwnershipAt) {
          if (delta.trim() && !aRequestId) {
            aRequestId = request?.id;
            inputReady.resolve();
          }
        } else if (!bRequestId && request?.startedAt >= bOwnershipAt) bRequestId = request.id;
        context.events.push({ interactionId, type: 'delta', requestId: request?.id, at: event.at, text: delta });
      },
      onResponse(response, event) {
        const request = context.requests.find((item) => item.id === event.requestId);
        if (!bOwnershipAt) inputReady.resolve();
        else if (!bRequestId && request?.startedAt >= bOwnershipAt) bRequestId = request.id;
        context.events.push({ interactionId, type: 'response', requestId: request?.id, at: event.at, text: response.text });
        if (request?.id === bRequestId || request?.startedAt >= bOwnershipAt) exitReady.resolve();
      },
      onInterruption(at) {
        bOwnershipAt ??= at;
        const localRequests = context.requests.slice(requestStart);
        aRequestId ??= localRequests[0]?.id;
        bRequestId ??= localRequests.find((request) => request.startedAt >= bOwnershipAt)?.id;
      },
    });
    const localRequests = context.requests.slice(requestStart);
    aRequestId ??= localRequests[0]?.id;
    bRequestId ??= localRequests.find((request) => request.id !== aRequestId)?.id;
    const events = [
      ...localRequests.map((request) => ({ interactionId, type: 'request-start', requestId: request.id, at: request.startedAt })),
      ...localRequests.filter((request) => request.abortedAt !== undefined)
        .map((request) => ({ interactionId, type: 'request-abort', requestId: request.id, at: request.abortedAt })),
      ...context.events.filter((event) => event.interactionId === interactionId),
    ];
    const assistantMessages = run.session.getMessages().filter(({ role }) => role === 'assistant')
      .map((message, index) => ({ content: message.content, requestId: run.responses[index]?.requestId }));
    const evidence = evaluateInterruptionWindow({
      interactionId, events, requestAId: aRequestId, requestBId: bRequestId,
      bOwnershipAt, assistantMessages, maxActive: context.maxActiveRequests, expectedText,
    });
    return { ...evidence, status: run.result?.status === 'completed' ? evidence.status : 'NOT_VERIFIED', requestCount: localRequests.length, error: run.error };
  } finally {
    clearTimeout(timer);
    context.onProviderError = undefined;
    exitReady.resolve();
  }
}

export async function runCloseout() {
  const start = new Date();
  const baseURL = process.env.AI_BASE_URL?.trim();
  const key = process.env.AI_API_KEY?.trim();
  const configured = process.env.AI_PROVIDER === 'direct' && Boolean(baseURL && key);
  const budget = new ProviderRequestBudget(MAX_PROVIDER_REQUESTS);
  const report = {
    status: 'BLOCKED', route: ROUTE, startedAt: start.toISOString(), finishedAt: undefined,
    elapsedMs: undefined, metadata: 'NOT_RUN', nonLiveOsu: 'NOT_RUN',
    nonLiveBitcoin: 'NOT_RUN', unicode: 'NOT_RUN', interruption: 'NOT_RUN',
    secretsPrinted: false, accountIdsLogged: false, rawFullTranscriptsPersisted: false,
  };
  let root;
  try {
    if (!configured) return report;
    budget.countMetadataRequest();
    let modelResponse;
    try { modelResponse = await fetch(`${baseURL.replace(/\/+$/u, '')}/models`, { headers: { authorization: `Bearer ${key}` } }); }
    catch { report.metadata = { status: 'FAIL', comboFound: false, reason: 'TRANSPORT' }; return report; }
    if (!modelResponse.ok) { report.metadata = { status: 'FAIL', comboFound: false, statusCode: modelResponse.status }; return report; }
    const modelBody = await modelResponse.json();
    const comboFound = Array.isArray(modelBody?.data) && modelBody.data.some(({ id }) => id === ROUTE);
    report.metadata = { status: comboFound ? 'PASS' : 'FAIL', comboFound };
    if (!comboFound) return report;
    root = await mkdtemp(join(tmpdir(), 'yuki-lab-closeout-v3-'));
    const context = createLiveContext(budget);
    if (budget.canReserve(5)) {
      report.nonLiveOsu = await runOne(context, 'Explícame brevemente qué significa el ranking mundial en osu!.');
      if (report.nonLiveOsu.status === 'MINOR_MODEL_OVER_REFUSAL' || report.nonLiveOsu.status === 'PRODUCT_FAILURE'
        || report.nonLiveOsu.status === 'EVALUATOR_FAILURE') {
        if (budget.canReserve(4)) report.nonLiveBitcoin = await runOne(context, 'Explícame qué es Bitcoin sin darme su precio actual.');
      }
    }
    if (report.nonLiveOsu?.status !== 'PASS' && report.nonLiveBitcoin?.status === 'PASS') {
      const minorClass = report.nonLiveOsu.status === 'MINOR_MODEL_OVER_REFUSAL'
        ? 'MINOR_MODEL_OVER_REFUSAL' : 'MINOR_MODEL_BEHAVIOR';
      report.nonLiveOsu.classification = minorClass;
      report.nonLiveOsu.status = minorClass;
    }
    if (budget.canReserve(3)) report.unicode = await runUnicode(context);
    if (budget.canReserve(2)) {
      report.interruption = await runInterruption(context);
      if (report.interruption.status === 'NOT_VERIFIED' && budget.canReserve(4)) {
        report.interruptionConfirm = await runInterruption(context, '512');
      }
    }
    const requests = context.requests;
    report.provider = 'direct-http';
    report.requestedRoute = ROUTE;
    report.reportedUpstreamModels = [...context.models].sort();
    report.responseModels = [...context.responseModels].sort();
    report.latency = {
      ttftMinMs: min(requests.map((request) => request.ttftMs)),
      ttftAvgMs: avg(requests.map((request) => request.ttftMs)),
      ttftMaxMs: max(requests.map((request) => request.ttftMs)),
      totalAvgMs: avg(requests.map((request) => request.finishedAt === undefined ? undefined : request.finishedAt - request.startedAt)),
      ttftOver3s: requests.filter((request) => request.ttftMs > 3000).length,
      ttftOver5s: requests.filter((request) => request.ttftMs > 5000).length,
      ttftOver10s: requests.filter((request) => request.ttftMs > 10000).length,
    };
    report.accounting = budget.snapshot();
    report.errors = context.errors;
    report.status = 'COMPLETED';
    return report;
  } finally {
    if (root) await rm(root, { recursive: true, force: true });
    report.finishedAt = new Date().toISOString();
    report.elapsedMs = Date.parse(report.finishedAt) - Date.parse(report.startedAt);
    report.accounting ??= budget.snapshot();
    report.acceptance = acceptanceDecision(report);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (report.status !== 'COMPLETED' || report.acceptance.verdict !== 'PASS') process.exitCode = 1;
  }
}

function min(items) { const values = items.filter(Number.isFinite); return values.length ? Math.min(...values) : undefined; }
function max(items) { const values = items.filter(Number.isFinite); return values.length ? Math.max(...values) : undefined; }
function avg(items) { const values = items.filter(Number.isFinite); return values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : undefined; }

export function acceptanceDecision(report) {
  const nonLive = [report.nonLiveOsu?.status, report.nonLiveBitcoin?.status].filter((value) => value !== 'NOT_RUN');
  const minorStatuses = ['MINOR_MODEL_OVER_REFUSAL', 'MINOR_MODEL_BEHAVIOR'];
  const minorCount = nonLive.filter((value) => minorStatuses.includes(value)).length;
  const conceptualOkay = nonLive.length > 0 && nonLive.some((value) => value === 'PASS')
    && nonLive.every((value) => value === 'PASS' || minorStatuses.includes(value)) && minorCount < 2;
  const unicodeOkay = ['PASS', 'MINOR_MODEL_INSTRUCTION_FAILURE'].includes(report.unicode?.classification ?? report.unicode?.status);
  const errors = report.errors ?? {};
  const transportOkay = errors.http4xx === 0 && errors.http5xx === 0 && errors.timeout === 0 && errors.transport === 0;
  const interruptionStatus = report.interruptionConfirm?.status === 'PASS' ? 'PASS' : report.interruption?.status;
  if (interruptionStatus === 'PASS' && conceptualOkay && unicodeOkay && transportOkay) {
    return { verdict: 'PASS', suitableExperimentalDefault: true, suitableLocalDevelopmentDefault: true };
  }
  if ([...nonLive, report.unicode?.classification, report.interruption?.status].includes('PRODUCT_FAILURE')
    || interruptionStatus === 'FAIL') {
    return { verdict: 'PARTIAL', suitableExperimentalDefault: false, suitableLocalDevelopmentDefault: false };
  }
  return { verdict: 'PARTIAL', suitableExperimentalDefault: false, suitableLocalDevelopmentDefault: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCloseout().catch(() => {
    process.stderr.write('{"status":"FAIL","reason":"SAFE_RUNNER_ERROR","secretsPrinted":false}\n');
    process.exitCode = 1;
  });
}
