import { performance } from 'node:perf_hooks';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
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
import { PersonalityCompiler } from '../dist/personality/personality-compiler.js';
import { PersonalityRegistry } from '../dist/personality/personality-registry.js';
import { createCountingFetch, ProviderRequestBudget } from './provider-call-budget.mjs';

export const YUKI_LAB_ROUTE = 'yuki-lab-chat';
export const REAL_REQUEST_LIMIT = 20;
export const ACCEPTANCE_CALL_PLAN = Object.freeze([
  { name: 'smoke', maximumRequests: 1 },
  { name: 'eight-turn-soak', maximumRequests: 8 },
  { name: 'sports-honesty', maximumRequests: 1 },
  { name: 'non-live-control', maximumRequests: 1 },
  { name: 'calculator', maximumRequests: 2 },
  { name: 'unicode', maximumRequests: 1 },
  { name: 'interruption', maximumRequests: 2 },
]);

const processStartedAt = new Date();
const DEFAULT_TIMEOUT_MS = 30_000;
// AssistantCore serializes local.calculate as local_calculate on the provider wire.
const TRACKED_TOOL_IDS = new Set(['local.calculate', 'local_calculate', 'local.time', 'local_time']);

function safeError(error) {
  const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,64}$/u.test(error.code)
    ? error.code
    : 'UNKNOWN_ERROR';
  return {
    code,
    statusCode: typeof error?.statusCode === 'number' ? error.statusCode : undefined,
  };
}

function safeModelId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,100}$/u.test(value)) return undefined;
  if (/^[a-f0-9]{24,}$/iu.test(value) || /^[0-9a-f-]{32,}$/iu.test(value) || value.includes('@')) return undefined;
  return value;
}

function responseExcerpt(value, maximum = 180) {
  const compact = String(value ?? '').replace(/\s+/gu, ' ').trim();
  return compact.length <= maximum ? compact : `${compact.slice(0, maximum - 1)}…`;
}

export function evaluateSportsHonesty(value) {
  const text = String(value ?? '').normalize('NFKC').toLowerCase();
  const acknowledgesNoVerifiedCurrentSource = /(?:no\s+(?:tengo|dispongo de|cuento con|puedo consultar)\s+(?:acceso|datos|informaci[oó]n|fuentes?)|sin\s+(?:acceso|datos|informaci[oó]n|fuentes?)).{0,100}(?:actual|hoy|en vivo|tiempo real|verificad)|no puedo verificar.{0,80}(?:partidos?|agenda|calendario|horario|actual)/iu.test(text);
  const concreteFixture = /\b\d{1,2}:\d{2}\b/u.test(text)
    || /\b\d{1,2}\s*[-–:]\s*\d{1,2}\b/u.test(text)
    || /\b(?:vs\.?|contra|se enfrenta a|juega contra)\b/iu.test(text);
  return {
    status: acknowledgesNoVerifiedCurrentSource && !concreteFixture ? 'PASS' : 'FAIL',
    acknowledgesNoVerifiedCurrentSource,
    concreteFixture,
  };
}

export function evaluateNonLiveExplanation(value) {
  const text = String(value ?? '').normalize('NFKC').trim();
  const unnecessaryRefusal = /no puedo (?:ayudarte|responder|explicar)|no tengo acceso|no dispongo de datos/iu.test(text);
  const explainsConcept = /(?:ranking|clasificaci[oó]n|posici[oó]n|orden|jugadores|rendimiento|puntuaci[oó]n|tabla|comparar)/iu.test(text);
  return { status: text.length >= 30 && explainsConcept && !unnecessaryRefusal ? 'PASS' : 'FAIL', unnecessaryRefusal, explainsConcept };
}

export function evaluateCalculator(value) {
  return /(?<!\d)355(?!\d)/u.test(String(value ?? '').normalize('NFKC')) ? 'PASS' : 'FAIL';
}

export function evaluateUnicode(value) {
  return String(value ?? '').trim() === 'ñ á ü 🌸' ? 'PASS' : 'FAIL';
}

export function evaluationAccepted(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value === 'PASS';
  return value?.status === 'PASS';
}

export function validateResumeEvidence(value) {
  const startedAt = Date.parse(value?.sessionStartedAt);
  if (value?.route !== YUKI_LAB_ROUTE
    || value?.metadata?.status !== 'PASS' || value.metadata.comboFound !== true
    || value?.smoke?.status !== 'PASS'
    || value.smoke.validResponse !== true || value.smoke.spanish !== true
    || value.smoke.yukiStack !== true || value.smoke.streamObserved !== true
    || !Number.isFinite(startedAt)
    || !Number.isInteger(value.smoke.responseLength) || value.smoke.responseLength < 1
    || !Number.isFinite(value.smoke.ttftMs) || !Number.isFinite(value.smoke.totalMs)
    || safeModelId(value.smoke.responseModel) === undefined) {
    throw new Error('Resume evidence is incomplete or does not match this acceptance run.');
  }
  return {
    route: YUKI_LAB_ROUTE,
    sessionStartedAt: new Date(startedAt).toISOString(),
    metadata: { status: 'PASS', comboFound: true },
    smoke: {
      status: 'PASS', responseProvider: 'direct-http',
      responseModel: safeModelId(value.smoke.responseModel),
      responseLength: value.smoke.responseLength,
      ttftMs: Math.round(value.smoke.ttftMs),
      totalMs: Math.round(value.smoke.totalMs),
      streamObserved: true,
      reusedPriorObservedResult: true,
    },
  };
}

export function plannedProviderRequestMaximum() {
  return ACCEPTANCE_CALL_PLAN.reduce((total, item) => total + item.maximumRequests, 0);
}

function silentLogger() {
  return createLogger({ sink: { info: () => {}, warn: () => {}, error: () => {} } });
}

async function* inputValues(values) {
  yield* values;
}

function personality() {
  return new PersonalityCompiler().compile({ profile: new PersonalityRegistry().defaultProfile });
}

function lastUserMessage(body) {
  if (!Array.isArray(body?.messages)) return '';
  return [...body.messages].reverse().find((message) => message?.role === 'user')?.content ?? '';
}

export function requestedToolIds(body) {
  const ids = new Set();
  for (const message of body?.messages ?? []) {
    for (const call of message?.tool_calls ?? []) {
      const name = call?.function?.name;
      if (TRACKED_TOOL_IDS.has(name)) ids.add(name === 'local_calculate' ? 'local.calculate'
        : name === 'local_time' ? 'local.time' : name);
    }
    if (message?.role === 'tool' && TRACKED_TOOL_IDS.has(message?.name)) {
      ids.add(message.name === 'local_calculate' ? 'local.calculate'
        : message.name === 'local_time' ? 'local.time' : message.name);
    }
  }
  return [...ids];
}

function createContext(budget, root, observations) {
  const baseURL = process.env.AI_BASE_URL?.trim();
  const apiKey = process.env.AI_API_KEY?.trim();
  if (!baseURL || !apiKey) throw new Error('Direct configuration is incomplete.');

  const fetchImpl = async (input, init = {}) => {
    let body;
    try { body = JSON.parse(String(init.body ?? '{}')); } catch { body = undefined; }
    const request = {
      startedAt: performance.now(),
      promptLength: lastUserMessage(body).length,
      toolIds: requestedToolIds(body),
      ttftMs: undefined,
      totalMs: undefined,
      statusCode: undefined,
      abortedAt: undefined,
    };
    observations.requests.push(request);
    for (const toolId of request.toolIds) {
      if (toolId === 'local.calculate') observations.localCalculateRequests += 1;
    }
    observations.activeRequests += 1;
    observations.maxActiveRequests = Math.max(observations.maxActiveRequests, observations.activeRequests);
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      init.signal?.removeEventListener('abort', onAbort);
      observations.activeRequests -= 1;
      request.totalMs ??= Math.round(performance.now() - request.startedAt);
    };
    const onAbort = () => {
      request.abortedAt ??= performance.now();
      if (request.abortClassified) return;
      request.abortClassified = true;
      if (init.signal?.reason?.name === 'TimeoutError') observations.timeouts += 1;
      else observations.abortedIssuedRequests += 1;
    };
    init.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const response = await fetch(input, init);
      request.statusCode = response.status;
      if (response.status >= 400 && response.status < 500) observations.httpErrors['4xx'] += 1;
      if (response.status >= 500) observations.httpErrors['5xx'] += 1;
      if (!response.body) {
        settle();
        return response;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let firstChunk = true;
      let modelScan = '';
      const body = new ReadableStream({
        async pull(controller) {
          try {
            const chunk = await reader.read();
            if (chunk.done) {
              modelScan += decoder.decode();
              const modelMatch = modelScan.match(/"model"\s*:\s*"([^"\\]{1,120})"/u);
              const model = safeModelId(modelMatch?.[1]);
              if (model) observations.reportedModels.add(model);
              settle();
              controller.close();
              return;
            }
            if (firstChunk) {
              request.ttftMs = Math.round(performance.now() - request.startedAt);
              firstChunk = false;
            }
            const decoded = decoder.decode(chunk.value, { stream: true });
            modelScan = `${modelScan}${decoded}`.slice(-8_000);
            controller.enqueue(chunk.value);
          } catch (error) {
            settle();
            controller.error(error);
          }
        },
        async cancel(reason) {
          try { await reader.cancel(reason); } finally { settle(); }
        },
      });
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) {
      if (init.signal?.aborted) {
        onAbort();
        if (error?.code === 'PROVIDER_TIMEOUT_ERROR' && init.signal.reason?.name !== 'TimeoutError') observations.timeouts += 1;
      } else if (error?.name === 'TimeoutError' || error?.code === 'PROVIDER_TIMEOUT_ERROR') {
        observations.timeouts += 1;
      } else {
        observations.transportErrors += 1;
      }
      settle();
      throw error;
    }
  };

  const provider = new DirectAIProvider({
    baseURL,
    apiKey,
    model: YUKI_LAB_ROUTE,
    timeoutMs: Number(process.env.AI_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS),
    retryPolicy: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
    fetchImpl: createCountingFetch({ budget, fetchImpl }),
  });
  return {
    budget,
    provider,
    observations,
    core: new AssistantCore({
      provider,
      logger: silentLogger(),
      toolManager: createLocalToolManager(),
      toolAllowlist: LOCAL_TOOL_ALLOWLIST,
    }),
    personality: personality(),
    memoryPath: join(root, 'memory.json'),
    sessionsPath: join(root, 'sessions.json'),
  };
}

async function discoverCombo(baseURL, apiKey, budget, observations) {
  budget.countMetadataRequest();
  try {
    const response = await fetch(`${baseURL.replace(/\/+$/u, '')}/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    if (response.status >= 400 && response.status < 500) observations.httpErrors['4xx'] += 1;
    if (response.status >= 500) observations.httpErrors['5xx'] += 1;
    if (!response.ok) return { status: 'FAIL', comboFound: false, statusCode: response.status };
    const body = await response.json();
    const comboFound = Array.isArray(body?.data) && body.data.some((item) => item?.id === YUKI_LAB_ROUTE);
    return { status: 'PASS', comboFound };
  } catch (error) {
    return { status: 'FAIL', comboFound: false, error: safeError(error) };
  }
}

async function runConversation(context, prompts, options = {}) {
  const responses = [];
  const deltaCounts = [];
  let currentDeltas = '';
  let currentDeltaCount = 0;
  async function* trackedPrompts() {
    for await (const prompt of prompts) {
      if (prompt !== '/exit') context.budget.noteLogicalInteraction();
      yield prompt;
    }
  }
  const runner = new ConversationRunner(context.core, options.session);
  try {
    const result = await runner.run(trackedPrompts(), {
      personality: context.personality,
      interruptible: options.interruptible ?? false,
      onDelta(delta) {
        if (delta) {
          currentDeltaCount += 1;
          currentDeltas += delta;
        }
        options.onDelta?.(delta);
      },
      onResponse(response) {
        responses.push(response);
        deltaCounts.push({ matchesResponse: currentDeltas === response.text, count: currentDeltaCount });
        currentDeltas = '';
        currentDeltaCount = 0;
        options.onResponse?.(response);
      },
      onInterruption() {
        currentDeltas = '';
        currentDeltaCount = 0;
        options.onInterruption?.();
      },
    });
    return { status: 'PASS', result, responses, deltaCounts };
  } catch (error) {
    if (error?.code === 'INVALID_RESPONSE_ERROR') context.observations.invalidResponses += 1;
    if (error?.code === 'TIMEOUT_ERROR') context.observations.timeouts += 1;
    context.observations.runErrors += 1;
    return { status: 'FAIL', result: undefined, responses, deltaCounts, error: safeError(error) };
  }
}

async function oneTurn(context, prompt, evaluate, options = {}) {
  if (!context.budget.canReserve(1)) return { status: 'NOT_RUN' };
  const firstRequestIndex = context.observations.requests.length;
  const run = await runConversation(context, inputValues([prompt, '/exit']), options);
  const response = run.responses.at(-1);
  const text = response?.text ?? '';
  const evaluation = evaluate(text, response, run);
  const accepted = evaluationAccepted(evaluation);
  const firstRequest = context.observations.requests[firstRequestIndex];
  return {
    status: run.status === 'PASS' && accepted ? 'PASS' : 'FAIL',
    responseProvider: response?.provider === 'direct-http' ? response.provider : (response ? 'other' : undefined),
    responseModel: safeModelId(response?.model),
    responseLength: text.length,
    ...(options.includeExcerpt ? { excerpt: responseExcerpt(text) } : {}),
    evaluation: options.includeEvaluation ? evaluation : undefined,
    ttftMs: firstRequest?.ttftMs,
    totalMs: firstRequest?.totalMs,
    streamObserved: (run.deltaCounts.at(-1)?.count ?? 0) > 0,
    error: run.error,
  };
}

export async function runSoak(context) {
  if (!context.budget.canReserve(8)) return { status: 'NOT_RUN', reason: 'INSUFFICIENT_BUDGET' };
  const requestStart = context.observations.requests.length;
  const prompts = [
    'Hola Yuki, vamos a comprobar una conversación larga.',
    'Mi código temporal es ASTRA-728.',
    'Explícame brevemente la diferencia entre memoria persistente y contexto de conversación.',
    'Resume lo anterior en una sola oración.',
    '¿Cuál era mi código temporal?',
    'Dame dos ejemplos sencillos de cosas que guardarías en memoria y dos que dejarías solo en la conversación.',
    '¿Todavía recuerdas el código temporal que te di?',
    'Termina esta prueba con una frase breve.',
    '/exit',
  ];
  const run = await runConversation(context, inputValues(prompts));
  const texts = run.responses.map(({ text }) => text);
  const messages = run.result?.session.getMessages() ?? [];
  const userMessages = messages.filter(({ role }) => role === 'user');
  const assistantMessages = messages.filter(({ role }) => role === 'assistant');
  const toolRoundObserved = (context.observations.requests ?? []).slice(requestStart)
    .some(({ toolIds }) => toolIds?.length > 0);
  const identities = texts.filter((text) => /\b(?:soy|me llamo)\s+(?:chatgpt|claude|gemini|gpt[- ]?\d|deepseek)\b/iu.test(text));
  const summaryText = texts[3] ?? '';
  const summaryInstruction = summaryText.trim().length > 0
    && summaryText.split(/[.!?]+/u).filter((part) => part.trim().length > 0).length <= 1;
  const coreChecksPass = run.status === 'PASS' && texts.length === 8 && /ASTRA-728/iu.test(texts[4] ?? '')
      && /ASTRA-728/iu.test(texts[6] ?? '') && summaryInstruction
      && userMessages.length === 8 && assistantMessages.length === 8
      && run.deltaCounts.length === 8 && identities.length === 0;
  const streamMismatch = run.deltaCounts.some((item) => !item.matchesResponse);
  const streamAssessment = !streamMismatch ? 'PASS' : toolRoundObserved ? 'NOT_VERIFIED' : 'FAIL';
  return {
    status: coreChecksPass && streamAssessment === 'PASS' ? 'PASS'
      : coreChecksPass && streamAssessment === 'NOT_VERIFIED' ? 'NOT_VERIFIED' : 'FAIL',
    allEightTurnsCompleted: run.status === 'PASS' && texts.length === 8 ? 'PASS' : 'FAIL',
    astraTurn5: /ASTRA-728/iu.test(texts[4] ?? '') ? 'PASS' : 'FAIL',
    astraTurn7: /ASTRA-728/iu.test(texts[6] ?? '') ? 'PASS' : 'FAIL',
    summaryInstruction: summaryInstruction ? 'PASS' : 'FAIL',
    contextContinuity: userMessages.length === 8 && assistantMessages.length === 8 ? 'PASS' : 'FAIL',
    sessionReset: userMessages.length !== 8 || assistantMessages.length !== 8,
    duplicateStreaming: streamAssessment,
    toolRoundObserved,
    identityCorruption: identities.length > 0,
    responses: texts.map((text) => responseExcerpt(text, 120)),
    streamingTurns: run.deltaCounts.filter((item) => item.count > 0).length,
    error: run.error,
  };
}

export async function runInterruption(context) {
  if (!context.budget.canReserve(2)) return { status: 'NOT_RUN', reason: 'INSUFFICIENT_BUDGET' };
  const requestStart = context.observations.requests.length;
  const activeMaximumStart = context.observations.maxActiveRequests;
  let releaseB;
  let releaseExit;
  let aTtftAt;
  let bAcceptedAt;
  let bRequestStartedAt;
  let bTtftAt;
  let bFinalAt;
  let bStream = '';
  const timedDeltas = [];
  const timedResponses = [];
  const inputReady = new Promise((resolveReady) => { releaseB = resolveReady; });
  const exitReady = new Promise((resolveReady) => { releaseExit = resolveReady; });
  const run = await runConversation(context, (async function* () {
    yield 'Explícame detalladamente cómo funciona una API y da varios ejemplos.';
    await inputReady;
    yield 'Detente. Responde únicamente: 256';
    await exitReady;
    yield '/exit';
  }()), {
    interruptible: true,
    onInterruption() {
      bAcceptedAt ??= performance.now();
      bStream = '';
    },
    onDelta(delta) {
      const now = performance.now();
      timedDeltas.push({ at: now, text: delta });
      if (bAcceptedAt === undefined) {
        if (delta.trim() && aTtftAt === undefined) {
          aTtftAt = now;
          releaseB?.();
        }
      } else {
        const activeB = context.observations.requests.slice(requestStart)
          .find(({ startedAt }) => startedAt >= bAcceptedAt);
        if (activeB && now >= activeB.startedAt) {
          bRequestStartedAt ??= activeB.startedAt;
          bTtftAt ??= now;
          bStream += delta;
        }
      }
    },
    onResponse(response) {
      timedResponses.push({ at: performance.now(), text: response.text });
      if (bAcceptedAt === undefined) releaseB?.();
      if (bAcceptedAt !== undefined) releaseExit?.();
    },
  });
  const [requestA, requestB] = context.observations.requests.slice(requestStart, requestStart + 2);
  bRequestStartedAt ??= requestB?.startedAt;
  const bResponse = timedResponses.find(({ at }) => bRequestStartedAt !== undefined && at >= bRequestStartedAt);
  bFinalAt = bResponse?.at;
  const bResponseText = bResponse?.text;
  bTtftAt ??= timedDeltas.find(({ at }) => bRequestStartedAt !== undefined && at >= bRequestStartedAt)?.at;
  const sessionMessages = run.result?.session.getMessages() ?? [];
  const assistantMessages = sessionMessages.filter(({ role }) => role === 'assistant');
  const exactFinal = bResponseText?.trim() === '256'
    && assistantMessages.some(({ content }) => content.trim() === '256');
  const bStreamMatchesResponse = bResponseText !== undefined && bStream.trim() === bResponseText.trim();
  const aAborted = requestA?.abortedAt !== undefined;
  const staleOutput = bAcceptedAt !== undefined && bRequestStartedAt !== undefined
    && timedDeltas.some(({ at }) => at >= bAcceptedAt && at < bRequestStartedAt);
  const staleCompletion = bAcceptedAt !== undefined && bRequestStartedAt !== undefined
    && timedResponses.some(({ at }) => at >= bAcceptedAt && at < bRequestStartedAt);
  const attributionVerified = bAcceptedAt !== undefined && bRequestStartedAt !== undefined && Boolean(bResponse);
  const maximumActive = Math.max(activeMaximumStart, context.observations.maxActiveRequests);
  const checksPass = requestA && aAborted && requestB && exactFinal
    && bStreamMatchesResponse && !staleOutput && !staleCompletion
    && maximumActive === 1 && run.status === 'PASS';
  return {
    status: checksPass ? 'PASS' : attributionVerified ? 'FAIL' : 'NOT_VERIFIED',
    aIssued: Boolean(requestA),
    aAborted,
    bIssued: Boolean(requestB),
    bFinal256: exactFinal,
    bStreamMatchesResponse,
    partialAPersisted: assistantMessages.some(({ content }) => content.trim() !== '256'),
    staleOutput,
    staleCompletion,
    attributionVerified,
    maxActive: maximumActive,
    timing: {
      aTtftMs: aTtftAt === undefined || !requestA ? undefined : Math.round(aTtftAt - requestA.startedAt),
      bAcceptedMs: bAcceptedAt === undefined || !requestA ? undefined : Math.round(bAcceptedAt - requestA.startedAt),
      aAbortMs: requestA?.abortedAt === undefined || !requestA ? undefined : Math.round(requestA.abortedAt - requestA.startedAt),
      interruptionLatencyMs: requestA?.abortedAt === undefined || bAcceptedAt === undefined ? undefined : Math.round(requestA.abortedAt - bAcceptedAt),
      bTtftMs: bTtftAt === undefined || !requestB ? undefined : Math.round(bTtftAt - requestB.startedAt),
      bTotalMs: bFinalAt === undefined || !requestB ? undefined : Math.round(bFinalAt - requestB.startedAt),
    },
  };
}

function latencySummary(observations) {
  const ttft = observations.requests.map((item) => item.ttftMs).filter(Number.isFinite);
  const total = observations.requests.map((item) => item.totalMs).filter(Number.isFinite);
  const average = (values) => values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : undefined;
  return {
    ttftMinMs: ttft.length ? Math.min(...ttft) : undefined,
    ttftAvgMs: average(ttft),
    ttftMaxMs: ttft.length ? Math.max(...ttft) : undefined,
    totalAvgMs: average(total),
    ttftOver3s: ttft.filter((value) => value > 3_000).length,
    ttftOver5s: ttft.filter((value) => value > 5_000).length,
    ttftOver10s: ttft.filter((value) => value > 10_000).length,
    samples: ttft.length,
  };
}

function hasUnexpectedProviderFailure(observations) {
  return observations.httpErrors['4xx'] > 0 || observations.httpErrors['5xx'] > 0
    || observations.timeouts > 0 || observations.transportErrors > 0 || observations.invalidResponses > 0 || observations.runErrors > 0;
}

export async function runFinalAcceptance() {
  const baseURL = process.env.AI_BASE_URL?.trim();
  const apiKey = process.env.AI_API_KEY?.trim();
  const observations = {
    requests: [], activeRequests: 0, maxActiveRequests: 0,
    reportedModels: new Set(), localCalculateRequests: 0,
    httpErrors: { '4xx': 0, '5xx': 0 }, timeouts: 0,
    transportErrors: 0, invalidResponses: 0, runErrors: 0, abortedIssuedRequests: 0,
  };
  const budget = new ProviderRequestBudget(REAL_REQUEST_LIMIT);
  let resumeEvidence;
  if (process.env.YUKI_LAB_ACCEPTANCE_RESUME_JSON) {
    try {
      resumeEvidence = validateResumeEvidence(JSON.parse(process.env.YUKI_LAB_ACCEPTANCE_RESUME_JSON));
    } catch {
      throw new Error('Resume evidence could not be validated.');
    } finally {
      delete process.env.YUKI_LAB_ACCEPTANCE_RESUME_JSON;
    }
  }
  if (resumeEvidence) {
    budget.countMetadataRequest();
    budget.countProviderRequest();
    budget.noteLogicalInteraction();
  }
  const root = await mkdtemp(join(tmpdir(), 'yuki-lab-final-acceptance-v2-'));
  const report = {
    status: 'BLOCKED',
    route: YUKI_LAB_ROUTE,
    metadata: 'NOT_RUN',
    smoke: 'NOT_RUN',
    soak: 'NOT_RUN',
    sportsHonesty: 'NOT_RUN',
    nonLiveControl: 'NOT_RUN',
    calculator: 'NOT_RUN',
    unicode: 'NOT_RUN',
    interruption: 'NOT_RUN',
    accounting: undefined,
    latency: undefined,
    errors: undefined,
    sessionStartedAt: resumeEvidence?.sessionStartedAt ?? processStartedAt.toISOString(),
    sessionFinishedAt: undefined,
    wallClockElapsedMs: undefined,
    requestedRoute: YUKI_LAB_ROUTE,
    reportedUpstreamModels: [],
    naturalFallback: 'NOT_OBSERVED',
    forcedFallback: false,
    secretsPrinted: false,
    accountIdsLogged: false,
    rawFullTranscriptsPersisted: false,
  };
  try {
    if (process.env.AI_PROVIDER !== 'direct' || !baseURL || !apiKey) {
      report.configuration = 'BLOCKED';
      return report;
    }
    if (resumeEvidence) {
      report.metadata = { ...resumeEvidence.metadata, reusedPriorObservedResult: true };
      report.smoke = resumeEvidence.smoke;
      observations.reportedModels.add(resumeEvidence.smoke.responseModel);
      observations.requests.push({
        startedAt: performance.now() - resumeEvidence.smoke.totalMs,
        ttftMs: resumeEvidence.smoke.ttftMs,
        totalMs: resumeEvidence.smoke.totalMs,
        reusedPriorObservedResult: true,
      });
    }
    const discovery = resumeEvidence
      ? { status: 'PASS', comboFound: true }
      : await discoverCombo(baseURL, apiKey, budget, observations);
    report.metadata = {
      status: discovery.status,
      comboFound: discovery.comboFound,
      ...(resumeEvidence ? { reusedPriorObservedResult: true } : {}),
      statusCode: discovery.statusCode,
      error: discovery.error,
    };
    if (!discovery.comboFound) return report;

    const context = createContext(budget, root, observations);
    if (!resumeEvidence) {
      const smoke = await oneTurn(context, 'Hola Yuki. Responde brevemente para confirmar que estás disponible.', (text, response, run) => {
        const spanish = /[áéíóúñ¿¡]/iu.test(text) || /\b(?:sí|estoy|aquí|lista|disponible|claro|puedo|hola)\b/iu.test(text);
        const yukiStack = response?.provider === 'direct-http' && Boolean(safeModelId(response?.model));
        const stream = (run.deltaCounts.at(-1)?.count ?? 0) > 0;
        const valid = typeof text === 'string' && text.trim().length > 0;
        return valid && spanish && yukiStack && stream;
      }, { includeExcerpt: true });
      smoke.validResponse = smoke.responseLength > 0;
      smoke.spanish = /[áéíóúñ¿¡]/iu.test(smoke.excerpt ?? '') || /\b(?:sí|estoy|aquí|lista|disponible|claro|puedo|hola)\b/iu.test(smoke.excerpt ?? '');
      smoke.yukiStack = smoke.responseProvider === 'direct-http' && Boolean(safeModelId(smoke.responseModel));
      report.smoke = smoke;
      if (smoke.status !== 'PASS') {
        report.status = 'COMPLETED';
        return report;
      }
    }

    report.soak = await runSoak(context);
    if (hasUnexpectedProviderFailure(observations)) {
      report.status = 'COMPLETED';
      return report;
    }

    if (budget.canReserve(1)) {
      report.sportsHonesty = await oneTurn(context, '¿Qué partidos importantes hay hoy?', evaluateSportsHonesty, { includeExcerpt: true, includeEvaluation: true });
    }
    if (hasUnexpectedProviderFailure(observations)) { report.status = 'COMPLETED'; return report; }
    if (budget.canReserve(1)) {
      report.nonLiveControl = await oneTurn(context, 'Explícame brevemente qué significa el ranking mundial de osu!.', evaluateNonLiveExplanation, { includeExcerpt: true, includeEvaluation: true });
    }
    if (hasUnexpectedProviderFailure(observations)) { report.status = 'COMPLETED'; return report; }
    if (budget.canReserve(2)) {
      report.calculator = await oneTurn(context, '¿Cuánto es (48 * 7) + 19? Puedes utilizar tu calculadora local si está disponible.', evaluateCalculator, { includeExcerpt: true });
      report.calculator.localCalculateExecuted = observations.localCalculateRequests > 0 ? 'YES' : 'NO';
    }
    if (hasUnexpectedProviderFailure(observations)) { report.status = 'COMPLETED'; return report; }
    if (budget.canReserve(1)) {
      report.unicode = await oneTurn(context, 'Responde exactamente: ñ á ü 🌸', evaluateUnicode, { includeExcerpt: true });
    }
    if (hasUnexpectedProviderFailure(observations)) { report.status = 'COMPLETED'; return report; }
    if (budget.canReserve(2)) report.interruption = await runInterruption(context);

    report.reportedUpstreamModels = [...observations.reportedModels].sort();
    report.accounting = budget.snapshot();
    report.latency = latencySummary(observations);
    report.errors = {
      ...observations.httpErrors,
      timeout: observations.timeouts,
      transport: observations.transportErrors,
      invalidResponse: observations.invalidResponses,
      runErrors: observations.runErrors,
      abortedIssuedRequests: observations.abortedIssuedRequests,
    };
    report.status = 'COMPLETED';
    return report;
  } finally {
    await rm(root, { recursive: true, force: true });
    report.sessionFinishedAt = new Date().toISOString();
    report.wallClockElapsedMs = Math.max(0, Date.now() - Date.parse(report.sessionStartedAt));
    report.accounting ??= budget.snapshot();
    report.errors ??= { ...observations.httpErrors, timeout: observations.timeouts, transport: observations.transportErrors, invalidResponse: observations.invalidResponses, runErrors: observations.runErrors, abortedIssuedRequests: observations.abortedIssuedRequests };
    report.latency ??= latencySummary(observations);
    report.reportedUpstreamModels = [...observations.reportedModels].sort();
    const acceptanceChecks = [
      report.smoke?.status,
      report.soak?.status,
      report.sportsHonesty?.status,
      report.nonLiveControl?.status,
      report.calculator?.status,
      report.unicode?.status,
      report.interruption?.status,
    ];
    report.acceptanceStatus = acceptanceChecks.every((status) => status === 'PASS')
      && budget.providerRequests <= REAL_REQUEST_LIMIT
      && budget.blockedByBudget === 0
      && observations.httpErrors['4xx'] === 0 && observations.httpErrors['5xx'] === 0
      && observations.timeouts === 0 && observations.transportErrors === 0 && observations.invalidResponses === 0 && observations.runErrors === 0
      ? 'PASS'
      : acceptanceChecks.some((status) => status === 'FAIL') ? 'PARTIAL' : 'BLOCKED';
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (report.acceptanceStatus !== 'PASS' || report.status !== 'COMPLETED') process.exitCode = 1;
  }
}

const directInvocation = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (directInvocation) {
  runFinalAcceptance().catch((error) => {
    process.stderr.write(`${JSON.stringify({ status: 'FAIL', error: safeError(error), secretsPrinted: false })}\n`);
    process.exitCode = 1;
  });
}
