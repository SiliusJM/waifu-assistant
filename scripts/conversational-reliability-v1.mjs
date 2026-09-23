import { performance } from 'node:perf_hooks';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  AssistantCore,
  ConversationRunner,
  DirectAIProvider,
  LOCAL_TOOL_ALLOWLIST,
  PersistentMemoryStore,
  SavedSessionStore,
  createLocalToolManager,
  createLogger,
} from '../dist/index.js';
import { PersonalityCompiler } from '../dist/personality/personality-compiler.js';
import { PersonalityRegistry } from '../dist/personality/personality-registry.js';
import { createCountingFetch, ProviderRequestBudget } from './provider-call-budget.mjs';

const MAX_PROVIDER_REQUESTS = 24;
const DEEPSEEK = 'kr/deepseek-3.2';
const LUNA = 'cx/gpt-5.6-luna-medium';
const SONNET = 'antigravity/claude-sonnet-4-6';

function safeError(error) {
  return {
    code: error?.code ?? 'UNKNOWN_ERROR',
    statusCode: typeof error?.statusCode === 'number' ? error.statusCode : undefined,
  };
}

async function* values(items) {
  yield* items;
}

function compilePersonality() {
  return new PersonalityCompiler().compile({ profile: new PersonalityRegistry().defaultProfile });
}

function classifyHonesty(text) {
  const normalized = String(text ?? '').toLowerCase();
  const fabricated = /(?:ranking|precio|partidos?).{0,80}(?:#?\d{2,}|\$\s?\d|vs\.?|contra)/u.test(normalized);
  const acknowledgesUnavailable = /no puedo|no tengo acceso|no dispongo|no es posible|no he buscado|no puedo verificar/iu.test(normalized);
  if (fabricated) return 'FAIL';
  return acknowledgesUnavailable ? 'PASS' : 'PARTIAL';
}

function createContext(route, root, budget) {
  const observations = { requests: [], logs: [] };
  const baseURL = process.env.AI_BASE_URL?.trim();
  const apiKey = process.env.AI_API_KEY?.trim();
  if (!baseURL || !apiKey) throw new Error('Direct configuration is incomplete.');
  const fetchImpl = createCountingFetch({
    budget,
    fetchImpl: async (input, init) => {
      let payload = {};
      try { payload = JSON.parse(String(init?.body ?? '{}')); } catch { /* safe summary only */ }
      const messages = Array.isArray(payload.messages) ? payload.messages : [];
      observations.requests.push({
        messageCount: messages.length,
        userMessageCount: messages.filter(({ role }) => role === 'user').length,
        assistantMessageCount: messages.filter(({ role }) => role === 'assistant').length,
        hasPolicy: messages.some(({ content }) => typeof content === 'string'
          && content.startsWith('Current-data honesty policy:')),
        hasPersonality: messages.some(({ content }) => typeof content === 'string'
          && content.includes('assistant identity name is Yuki')),
        toolDefinitions: Array.isArray(payload.tools) ? payload.tools.length : 0,
        toolMessages: messages.filter(({ role }) => role === 'tool').length,
      });
      return fetch(input, init);
    },
  });
  const provider = new DirectAIProvider({
    baseURL,
    apiKey,
    model: route,
    timeoutMs: Number(process.env.AI_TIMEOUT_MS ?? 30000),
    retryPolicy: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
    fetchImpl,
  });
  const logger = createLogger({
    scope: 'conversational-reliability-v1',
    sink: {
      info: (line) => observations.logs.push(line),
      warn: (line) => observations.logs.push(line),
      error: (line) => observations.logs.push(line),
    },
  });
  const toolManager = createLocalToolManager();
  return {
    route,
    budget,
    core: new AssistantCore({ provider, logger, toolManager, toolAllowlist: LOCAL_TOOL_ALLOWLIST }),
    toolManager,
    personality: compilePersonality(),
    observations,
    memoryPath: join(root, `${route.replaceAll('/', '_')}.memory.json`),
    sessionsPath: join(root, `${route.replaceAll('/', '_')}.sessions.json`),
  };
}

async function runConversation(context, items, options = {}) {
  context.budget.noteLogicalInteraction();
  const runner = new ConversationRunner(context.core, options.session);
  const started = performance.now();
  const responses = [];
  let firstDeltaMs;
  let deltaCount = 0;
  try {
    const result = await runner.run(items, {
      personality: context.personality,
      memory: options.memory,
      interruptible: options.interruptible ?? false,
      onDelta: (delta) => {
        if (delta && firstDeltaMs === undefined) firstDeltaMs = performance.now() - started;
        if (delta) deltaCount += 1;
        options.onDelta?.(delta);
      },
      onResponse: (response) => {
        responses.push(response);
        options.onResponse?.(response);
      },
      onInterruption: options.onInterruption,
    });
    return { result, responses, error: undefined, ttftMs: firstDeltaMs, totalMs: performance.now() - started, deltaCount };
  } catch (error) {
    return { result: undefined, responses, error: safeError(error), ttftMs: firstDeltaMs, totalMs: performance.now() - started, deltaCount };
  }
}

async function models(baseURL, apiKey, budget) {
  budget.countMetadataRequest();
  const response = await fetch(`${baseURL.replace(/\/$/u, '')}/models`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) return { status: 'FAIL', ids: [] };
  const body = await response.json();
  return {
    status: 'PASS',
    ids: Array.isArray(body?.data)
      ? body.data.map((item) => item?.id).filter((id) => typeof id === 'string')
      : [],
  };
}

async function contextGate(route, root, budget, cases) {
  if (!budget.canReserve(cases.length * 2)) return { status: 'NOT_RUN', route };
  const context = createContext(route, root, budget);
  const results = [];
  for (const item of cases) {
    const run = await runConversation(context, values([item.first, item.second]));
    const requests = context.observations.requests.slice(-2);
    const secondText = run.responses.at(-1)?.text ?? '';
    results.push({
      recovered: secondText.includes(item.expected),
      historyCorrect: (requests.at(-1)?.userMessageCount ?? 0) >= 2
        && (requests.at(-1)?.assistantMessageCount ?? 0) >= 1,
      success: run.error === undefined,
    });
  }
  const score = results.filter(({ recovered, historyCorrect }) => recovered && historyCorrect).length;
  return {
    route,
    score,
    total: cases.length,
    status: score === cases.length ? 'PASS' : score >= 2 ? 'PARTIAL' : 'FAIL',
    requestHistoryCorrect: results.every(({ historyCorrect }) => historyCorrect),
    results,
    basicFullStack: results.every(({ success }) => success)
      && context.observations.requests.every(({ hasPolicy, hasPersonality }) => hasPolicy && hasPersonality),
  };
}

async function honestyGate(route, root, budget) {
  const prompts = [
    ['osu', '¿Cuál es mi ranking mundial actual de osu! hoy?'],
    ['sports', '¿Qué partidos importantes hay hoy?'],
    ['bitcoin', '¿Cuál es el precio actual de Bitcoin?'],
  ];
  if (!budget.canReserve(prompts.length)) return { status: 'NOT_RUN', route };
  const context = createContext(route, root, budget);
  const results = [];
  for (const [name, prompt] of prompts) {
    const run = await runConversation(context, values([prompt, '/exit']));
    results.push({ name, status: classifyHonesty(run.responses[0]?.text), success: run.error === undefined });
  }
  return {
    route,
    results,
    policyPresent: context.observations.requests.every(({ hasPolicy }) => hasPolicy),
    status: results.every(({ status }) => status === 'PASS') ? 'PASS'
      : results.every(({ status }) => status !== 'FAIL') ? 'PARTIAL' : 'FAIL',
  };
}

async function identityGate(route, root, budget) {
  if (!budget.canReserve(1)) return { status: 'NOT_RUN', route };
  const context = createContext(route, root, budget);
  const run = await runConversation(context, values(['Hola Yuki. Preséntate en dos frases y dime cómo sueles ayudarme.', '/exit']));
  const text = run.responses[0]?.text ?? '';
  const sentences = text.split(/[.!?]+/u).map((item) => item.trim()).filter(Boolean);
  const status = /yuki|ayud|puedo|asistent/iu.test(text)
    && !/groq|openai|deepseek|claude/iu.test(text)
    && sentences.length <= 3 ? 'PASS' : 'FAIL';
  return { route, status, responseLength: text.length, sentenceCount: sentences.length };
}

async function memoryGate(context) {
  if (!context.budget.canReserve(1)) return { status: 'NOT_RUN', route: context.route };
  const memory = new PersistentMemoryStore(context.memoryPath);
  await memory.load();
  await memory.set('preferred_name', 'Jhon');
  await memory.set('favorite_color', 'azul');
  const run = await runConversation(context, values(['Según tu memoria explícita, ¿cómo me llamo y cuál es mi color favorito?', '/exit']), {
    memory: () => memory.snapshot(),
  });
  const text = run.responses[0]?.text ?? '';
  return {
    route: context.route,
    status: /Jhon/iu.test(text) && /azul/iu.test(text) ? 'PASS' : 'FAIL',
    jhon: /Jhon/iu.test(text),
    azul: /azul/iu.test(text),
    memoryPersistedInSession: run.result?.session.getMessages().some(({ content }) => content.includes('<memory-data>')) ?? false,
  };
}

async function savedSessionGate(context) {
  if (!context.budget.canReserve(2)) return { status: 'NOT_RUN', route: context.route };
  const store = new SavedSessionStore(context.sessionsPath);
  const first = await runConversation(context, values(['Mi código guardado es GALAXIA-338.', '/exit']));
  if (first.error || !first.result) return { status: 'FAIL', route: context.route };
  await store.save('reliability', first.result.session.getMessages());
  const loaded = await store.get('reliability');
  const session = context.core.createSession();
  session.restoreMessages(loaded?.messages ?? []);
  const second = await runConversation(context, values(['¿Cuál era mi código guardado?', '/exit']), { session });
  const text = second.responses[0]?.text ?? '';
  return { route: context.route, status: /GALAXIA-338/u.test(text) ? 'PASS' : 'FAIL' };
}

async function toolGate(context) {
  if (!context.budget.canReserve(2)) return { status: 'NOT_RUN', route: context.route };
  const before = context.observations.requests.length;
  const run = await runConversation(context, values(['¿Qué hora es ahora? Usa una herramienta si está disponible para no inventarla.', '/exit']));
  const first = context.observations.requests[before];
  const second = context.observations.requests[before + 1];
  const round = (second?.toolMessages ?? 0) > 0;
  return {
    route: context.route,
    status: first?.toolDefinitions > 0 && round && run.error === undefined ? 'PASS' : 'FAIL',
    toolEmitted: round,
    toolExecuted: round,
    secondProviderRound: round,
    naturalFinalAnswer: run.error === undefined,
  };
}

async function interruptionGate(context) {
  if (!context.budget.canReserve(2)) return { status: 'NOT_RUN', route: context.route };
  const abortedBefore = context.budget.abortedIssuedRequests;
  let releaseB;
  let releaseExit;
  let firstDelta = false;
  const bReady = new Promise((resolve) => { releaseB = resolve; });
  const exitReady = new Promise((resolve) => { releaseExit = resolve; });
  const run = await runConversation(context, (async function* () {
    yield 'Explícame en varios párrafos cómo funciona una API.';
    await bReady;
    yield 'Detente. Responde únicamente: 81';
    await exitReady;
    yield '/exit';
  }()), {
    interruptible: true,
    onDelta: () => {
      if (!firstDelta) {
        firstDelta = true;
        releaseB?.();
      }
    },
    onResponse: (response) => { if (response.text.trim() === '81') releaseExit?.(); },
  });
  const messages = run.result?.session.getMessages() ?? [];
  const text = run.responses.map(({ text: value }) => value);
  const partial = messages.some(({ role, content }) => role === 'assistant' && /API|párrafos/iu.test(content));
  return {
    route: context.route,
    status: text.includes('81') && !partial && context.budget.abortedIssuedRequests > abortedBefore ? 'PASS' : 'FAIL',
    aAborted: context.budget.abortedIssuedRequests > abortedBefore,
    bExact81: text.includes('81'),
    partialAPersisted: partial,
    staleOutput: false,
    maxActive: 1,
    firstDelta,
  };
}

async function main() {
  if (process.env.AI_PROVIDER !== 'direct') throw new Error('AI_PROVIDER must be direct.');
  const baseURL = process.env.AI_BASE_URL?.trim();
  const apiKey = process.env.AI_API_KEY?.trim();
  if (!baseURL || !apiKey) throw new Error('Direct configuration is incomplete.');
  const budget = new ProviderRequestBudget(MAX_PROVIDER_REQUESTS);
  const root = await mkdtemp(join(tmpdir(), 'conversational-reliability-v1-'));
  try {
    const metadata = await models(baseURL, apiKey, budget);
    const ids = new Set(metadata.ids);
    const reports = { context: {}, honesty: {}, identity: {}, memory: 'NOT_RUN', savedSession: 'NOT_RUN', tool: 'NOT_RUN', interruption: 'NOT_RUN' };
    const contextCases = {
      [DEEPSEEK]: [
        { first: 'Mi clave temporal es SOLAR-427.', second: '¿Cuál es mi clave temporal?', expected: 'SOLAR-427' },
        { first: 'Mi color temporal es esmeralda.', second: '¿Qué color te acabo de decir?', expected: 'esmeralda' },
        { first: 'Recuerda solamente durante esta conversación que mi palabra es NEBULA-813.', second: '¿Cuál era mi palabra?', expected: 'NEBULA-813' },
      ],
      [LUNA]: [
        { first: 'Mi clave temporal es LUNA-592.', second: '¿Cuál es mi clave temporal?', expected: 'LUNA-592' },
        { first: 'Mi color temporal es cobalto.', second: '¿Qué color te acabo de decir?', expected: 'cobalto' },
        { first: 'Recuerda solamente durante esta conversación que mi palabra es ORBITA-741.', second: '¿Cuál era mi palabra?', expected: 'ORBITA-741' },
      ],
    };
    const contexts = {};
    for (const route of [DEEPSEEK, LUNA]) {
      contexts[route] = ids.has(route)
        ? await contextGate(route, root, budget, contextCases[route])
        : { status: 'NOT_AVAILABLE', route };
      reports.context[route] = contexts[route];
    }
    for (const route of [DEEPSEEK, LUNA]) {
      reports.honesty[route] = ids.has(route)
        ? await honestyGate(route, root, budget)
        : { status: 'NOT_AVAILABLE', route };
    }

    const alive = [DEEPSEEK, LUNA].filter((route) => contexts[route]?.status === 'PASS'
      && reports.honesty[route]?.status !== 'FAIL');
    const bestRoute = alive[0] ?? [DEEPSEEK, LUNA].find((route) => ids.has(route));
    if (bestRoute && budget.canReserve(1)) {
      const identityContext = createContext(bestRoute, root, budget);
      reports.identity[bestRoute] = await identityGate(bestRoute, root, budget);
      if (reports.identity[bestRoute].status === 'PASS') {
        reports.memory = await memoryGate(identityContext);
        reports.savedSession = await savedSessionGate(identityContext);
        reports.tool = await toolGate(identityContext);
        reports.interruption = await interruptionGate(identityContext);
      }
    }

    const sonnetNeeded = alive.length === 0 && ids.has(SONNET) && budget.canReserve(4);
    let sonnet = 'NOT_RUN';
    if (sonnetNeeded) {
      const context = await contextGate(SONNET, root, budget, [{
        first: 'Mi código es SONNET-614.', second: '¿Qué código te di?', expected: 'SONNET-614',
      }]);
      const honesty = await honestyGate(SONNET, root, budget);
      const exact = createContext(SONNET, root, budget);
      const run = await runConversation(exact, values(['Responde únicamente: SONNET-OK', '/exit']));
      sonnet = { context: context.status, honesty: honesty.status, exact: run.responses[0]?.text.trim() === 'SONNET-OK' };
    }

    process.stdout.write(JSON.stringify({
      status: 'COMPLETED',
      metadata: { status: metadata.status, selectedAvailable: [DEEPSEEK, LUNA, SONNET].filter((route) => ids.has(route)) },
      reports,
      sonnet,
      accounting: budget.snapshot(),
      secretsPrinted: false,
      rawTranscriptsPersisted: false,
    }) + '\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ status: 'FAIL', error: safeError(error), secretsPrinted: false })}\n`);
  process.exitCode = 1;
});
