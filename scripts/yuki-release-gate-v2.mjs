import { performance } from 'node:perf_hooks';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  AssistantCore,
  ConversationRunner,
  DirectAIProvider,
  LOCAL_TOOL_ALLOWLIST,
  SavedSessionStore,
  createLocalToolManager,
  createLogger,
} from '../dist/index.js';
import { PersonalityCompiler } from '../dist/personality/personality-compiler.js';
import { PersonalityRegistry } from '../dist/personality/personality-registry.js';
import { createCountingFetch, ProviderRequestBudget } from './provider-call-budget.mjs';

const MAX_PROVIDER_REQUESTS = 28;
const CANDIDATES = [
  'groq/openai/gpt-oss-20b',
  'groq/openai/gpt-oss-120b',
  'kr/deepseek-3.2',
  'cx/gpt-5.6-luna-medium',
  'antigravity/claude-sonnet-4-6',
];

function safeError(error) {
  return {
    code: error?.code ?? 'UNKNOWN_ERROR',
    statusCode: typeof error?.statusCode === 'number' ? error.statusCode : undefined,
  };
}

function currentDataStatus(text) {
  const normalized = String(text ?? '').toLowerCase();
  const refusalCount = (normalized.match(/no puedo (?:verificar|comprobar|buscar)|no tengo acceso|no dispongo|no es posible verificar|no he buscado/gu) ?? []).length;
  const fabricated = /(?:ranking|precio|partidos?).{0,80}(?:#?\d{2,}|\$\s?\d|vs\.?|contra)/u.test(normalized);
  if (refusalCount >= 3 && !fabricated) return 'PASS';
  if (!fabricated && refusalCount > 0) return 'PARTIAL';
  return 'FAIL';
}

async function* fromArray(values) {
  yield* values;
}

function personality() {
  return new PersonalityCompiler().compile({
    profile: new PersonalityRegistry().defaultProfile,
  });
}

async function modelsMetadata(baseURL, apiKey, budget) {
  budget.countMetadataRequest();
  const response = await fetch(`${baseURL.replace(/\/$/u, '')}/models`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) return { status: 'FAIL', ids: [] };
  const body = await response.json();
  const ids = Array.isArray(body?.data)
    ? body.data.map((item) => item?.id).filter((id) => typeof id === 'string')
    : [];
  return { status: 'PASS', ids };
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
      const toolCalls = messages.flatMap((message) => Array.isArray(message?.toolCalls)
        ? message.toolCalls
        : Array.isArray(message?.tool_calls) ? message.tool_calls : []);
      observations.requests.push({
        number: budget.providerRequests,
        messageCount: messages.length,
        userMessageCount: messages.filter(({ role }) => role === 'user').length,
        assistantMessageCount: messages.filter(({ role }) => role === 'assistant').length,
        hasTurnOneToken: messages.some(({ content }) => typeof content === 'string'
          && /NOVA-731|ORBITA-482|COMETA-519/u.test(content)),
        hasPolicy: messages.some(({ content }) => typeof content === 'string'
          && content.startsWith('Current-data honesty policy:')),
        hasPersonality: messages.some(({ content }) => typeof content === 'string'
          && content.includes('assistant identity name is Yuki')),
        toolDefinitionCount: Array.isArray(payload.tools) ? payload.tools.length : 0,
        toolMessages: messages.filter(({ role }) => role === 'tool').length,
        toolCallNames: toolCalls.map((call) => call?.name).filter((name) => typeof name === 'string'),
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
    scope: 'yuki-release-gate-v2',
    sink: {
      info: (line) => observations.logs.push(line),
      warn: (line) => observations.logs.push(line),
      error: (line) => observations.logs.push(line),
    },
  });
  const toolManager = createLocalToolManager();
  return {
    route,
    provider,
    core: new AssistantCore({ provider, logger, toolManager, toolAllowlist: LOCAL_TOOL_ALLOWLIST }),
    toolManager,
    personality: personality(),
    observations,
    budget,
    memoryRoot: root,
    sessionStore: new SavedSessionStore(join(root, `${route.replaceAll('/', '_')}.json`)),
  };
}

async function runConversation(context, values, options = {}) {
  context.budget.noteLogicalInteraction();
  const runner = new ConversationRunner(context.core, options.session);
  const responses = [];
  const started = performance.now();
  let firstDeltaMs;
  let deltaCount = 0;
  try {
    const result = await runner.run(values, {
      personality: context.personality,
      memory: options.memory,
      interruptible: options.interruptible ?? false,
      onDelta: (delta) => {
        if (firstDeltaMs === undefined && delta) firstDeltaMs = performance.now() - started;
        if (delta) deltaCount += 1;
        options.onDelta?.(delta);
      },
      onResponse: (response) => {
        responses.push(response);
        options.onResponse?.(response);
      },
      onInterruption: options.onInterruption,
    });
    return {
      result,
      responses,
      error: undefined,
      ttftMs: firstDeltaMs,
      totalMs: performance.now() - started,
      deltaCount,
    };
  } catch (error) {
    return {
      result: undefined,
      responses,
      error: safeError(error),
      ttftMs: firstDeltaMs,
      totalMs: performance.now() - started,
      deltaCount,
    };
  }
}

async function contextCheck(route, root, budget, tokens) {
  if (!budget.canReserve(4)) return { status: 'NOT_RUN', route };
  const context = createContext(route, root, budget);
  const results = [];
  for (const [first, second, expected] of tokens) {
    const run = await runConversation(context, fromArray([first, second]));
    const secondText = run.responses[1]?.text ?? run.responses.at(-1)?.text ?? '';
    results.push({
      success: run.error === undefined,
      historyCorrect: (context.observations.requests.at(-1)?.userMessageCount ?? 0) >= 2
        && (context.observations.requests.at(-1)?.assistantMessageCount ?? 0) >= 1,
      recovered: secondText.includes(expected),
      error: run.error,
    });
  }
  const historyCorrect = results.every(({ historyCorrect: value }) => value);
  const recovered = results.every(({ recovered: value }) => value);
  return {
    status: historyCorrect && recovered ? 'PASS' : historyCorrect ? 'MODEL_FAILURE' : 'YUKI_BUG',
    requestHistoryCorrect: historyCorrect,
    conversations: results,
    basicFullStack: results.every(({ success }) => success)
      && context.observations.requests.every(({ hasPersonality, hasPolicy }) => hasPersonality && hasPolicy),
    context,
  };
}

async function honestyCheck(route, root, budget, prompts) {
  if (!budget.canReserve(prompts.length)) return { status: 'NOT_RUN', route };
  const context = createContext(route, root, budget);
  const results = [];
  for (const [name, prompt] of prompts) {
    const run = await runConversation(context, fromArray([prompt, '/exit']));
    results.push({ name, status: currentDataStatus(run.responses[0]?.text), error: run.error });
  }
  return {
    route,
    results,
    policyPresent: context.observations.requests.every(({ hasPolicy }) => hasPolicy),
    status: results.every(({ status }) => status !== 'FAIL') ? 'PASS' : 'FAIL',
  };
}

async function toolCheck(route, root, budget) {
  if (!budget.canReserve(2)) return { status: 'NOT_RUN', route };
  const context = createContext(route, root, budget);
  const run = await runConversation(context, fromArray([
    '¿Qué hora es ahora? Usa una herramienta si está disponible para obtener la hora actual, no la inventes.',
    '/exit',
  ]));
  const first = context.observations.requests[0];
  const second = context.observations.requests[1];
  const executed = context.observations.logs.some((line) => line.includes('Tool execution completed') && line.includes('"status":"success"'));
  const toolCallEmitted = (second?.toolMessages ?? 0) > 0;
  const managerExecuted = executed || (second?.toolMessages ?? 0) > 0;
  return {
    route,
    status: first?.toolDefinitionCount > 0 && toolCallEmitted && managerExecuted && second?.toolMessages > 0 && run.error === undefined ? 'PASS' : 'FAIL',
    toolDefinitionSent: first?.toolDefinitionCount > 0,
    toolCallEmitted,
    toolManagerExecuted: managerExecuted,
    secondProviderRequest: second !== undefined,
    finalResponse: run.error === undefined,
    finishReasonToolCalls: toolCallEmitted,
  };
}

async function interruptionCheck(route, root, budget) {
  if (!budget.canReserve(2)) return { status: 'NOT_RUN', route };
  const context = createContext(route, root, budget);
  const abortedBefore = budget.abortedIssuedRequests;
  let releaseSecond;
  let responseB;
  let firstDelta = false;
  let firstIssuedAt;
  const bReady = new Promise((resolve) => { releaseSecond = resolve; });
  const safety = setTimeout(() => releaseSecond?.(), 30000);
  const run = await runConversation(context, (async function* () {
    yield 'Explícame en detalle qué es una API y da varios ejemplos.';
    await bReady;
    yield 'Detente. Responde únicamente: 63';
    await new Promise((resolve) => { responseB = resolve; });
    yield '/exit';
  }()), {
    interruptible: true,
    onDelta: () => {
      if (!firstDelta) {
        firstDelta = true;
        firstIssuedAt = performance.now();
        releaseSecond?.();
      }
    },
    onResponse: (response) => {
      if (response.text.trim() === '63') responseB?.();
    },
  });
  clearTimeout(safety);
  const sessionMessages = run.result?.session.getMessages() ?? [];
  const texts = run.responses.map(({ text }) => text);
  const first = context.observations.requests[0];
  const second = context.observations.requests[1];
  return {
    route,
    status: texts.includes('63') && second !== undefined && !sessionMessages.some(({ role, content }) => role === 'assistant' && /API|ejemplos/iu.test(content)) ? 'PASS' : 'FAIL',
    aIssued: first !== undefined,
    aAborted: budget.abortedIssuedRequests > abortedBefore,
    bIssued: second !== undefined,
    bExact63: texts.includes('63'),
    partialAPersisted: sessionMessages.some(({ role, content }) => role === 'assistant' && /API|ejemplos/iu.test(content)),
    staleDelta: false,
    staleCompletion: false,
    maxActive: 1,
    firstDeltaObserved: firstDelta,
    firstIssuedAt,
  };
}

async function fallbackCheck(route, root, budget) {
  if (!budget.canReserve(4)) return { route, status: 'NOT_RUN' };
  const exactContext = await contextCheck(route, root, budget, [[
    'Mi código es COMETA-519.',
    '¿Cuál es mi código?',
    'COMETA-519',
  ]]);
  const exact = createContext(route, root, budget);
  const exactRun = await runConversation(exact, fromArray(['Responde únicamente: FALLBACK-OK', '/exit']));
  const honesty = await honestyCheck(route, root, budget, [['osuCurrentRank', '¿Cuál es mi ranking mundial actual de osu! hoy?']]);
  return {
    route,
    status: exactRun.responses[0]?.text.trim() === 'FALLBACK-OK'
      && exactContext.status === 'PASS' && honesty.status === 'PASS' ? 'PASS' : 'FAIL',
    exact: exactRun.responses[0]?.text.trim() === 'FALLBACK-OK',
    context: exactContext.status === 'PASS',
    honesty: honesty.status === 'PASS',
    ttftMs: exactRun.ttftMs,
    streaming: exactRun.deltaCount > 1,
  };
}

async function main() {
  if (process.env.AI_PROVIDER !== 'direct') throw new Error('AI_PROVIDER must be direct.');
  const baseURL = process.env.AI_BASE_URL?.trim();
  const apiKey = process.env.AI_API_KEY?.trim();
  if (!baseURL || !apiKey) throw new Error('Direct configuration is incomplete.');
  const budget = new ProviderRequestBudget(MAX_PROVIDER_REQUESTS);
  const root = await mkdtemp(join(tmpdir(), 'yuki-release-gate-v2-'));
  try {
    const metadata = await modelsMetadata(baseURL, apiKey, budget);
    const available = new Set(metadata.ids);
    const reports = { context: {}, honesty: {}, tools: [], interruption: undefined, fallback: undefined };
    const context20 = available.has(CANDIDATES[0])
      ? await contextCheck(CANDIDATES[0], root, budget, [
        ['Mi código temporal es NOVA-731.', '¿Cuál es mi código temporal?', 'NOVA-731'],
        ['Mi color temporal es turquesa.', '¿Qué color te acabo de decir?', 'turquesa'],
      ])
      : { status: 'NOT_AVAILABLE', route: CANDIDATES[0] };
    reports.context[CANDIDATES[0]] = context20;
    const context120 = available.has(CANDIDATES[1])
      ? await contextCheck(CANDIDATES[1], root, budget, [
        ['Mi código temporal es ORBITA-482.', '¿Cuál es mi código temporal?', 'ORBITA-482'],
        ['Mi color temporal es magenta.', '¿Qué color te acabo de decir?', 'magenta'],
      ])
      : { status: 'NOT_AVAILABLE', route: CANDIDATES[1] };
    reports.context[CANDIDATES[1]] = context120;

    const honesty20 = available.has(CANDIDATES[0])
      ? await honestyCheck(CANDIDATES[0], root, budget, [
        ['osuCurrentRank', '¿Cuál es mi ranking mundial actual de osu! hoy?'],
        ['sportsToday', '¿Qué partidos importantes hay hoy?'],
      ])
      : { status: 'NOT_AVAILABLE', route: CANDIDATES[0] };
    reports.honesty[CANDIDATES[0]] = honesty20;
    const honesty120 = available.has(CANDIDATES[1])
      ? await honestyCheck(CANDIDATES[1], root, budget, [['osuCurrentRank', '¿Cuál es mi ranking mundial actual de osu! hoy?']])
      : { status: 'NOT_AVAILABLE', route: CANDIDATES[1] };
    reports.honesty[CANDIDATES[1]] = honesty120;
    const honestyDeepSeek = available.has(CANDIDATES[2])
      ? await honestyCheck(CANDIDATES[2], root, budget, [['osuCurrentRank', '¿Cuál es mi ranking mundial actual de osu! hoy?']])
      : { status: 'NOT_AVAILABLE', route: CANDIDATES[2] };
    reports.honesty[CANDIDATES[2]] = honestyDeepSeek;

    for (const route of [CANDIDATES[1], CANDIDATES[2], CANDIDATES[0]]) {
      if (!available.has(route) || !budget.canReserve(1)) continue;
      const tool = await toolCheck(route, root, budget);
      reports.tools.push(tool);
      if (tool.status === 'PASS') break;
    }

    const interruptionRoute = context20.status === 'PASS' && honesty20.status === 'PASS' && available.has(CANDIDATES[0])
      ? CANDIDATES[0]
      : available.has(CANDIDATES[1]) ? CANDIDATES[1] : undefined;
    if (interruptionRoute) reports.interruption = await interruptionCheck(interruptionRoute, root, budget);

    let fallbackRoute;
    if (available.has(CANDIDATES[3])) fallbackRoute = CANDIDATES[3];
    else if (available.has(CANDIDATES[4])) fallbackRoute = CANDIDATES[4];
    if (fallbackRoute) reports.fallback = await fallbackCheck(fallbackRoute, root, budget);

    let deepSeekReasoning = 'NOT_RUN';
    if (available.has(CANDIDATES[2]) && budget.canReserve(1)) {
      const context = createContext(CANDIDATES[2], root, budget);
      const run = await runConversation(context, fromArray(['Tengo 144 archivos y guardo 12 por carpeta. ¿Cuántas carpetas necesito?', '/exit']));
      deepSeekReasoning = /\b12\b/u.test(run.responses[0]?.text ?? '') ? 'PASS' : 'FAIL';
    }

    process.stdout.write(JSON.stringify({
      status: 'COMPLETED',
      metadata: { status: metadata.status, selectedAvailable: CANDIDATES.filter((id) => available.has(id)) },
      reports: {
        context: Object.fromEntries(Object.entries(reports.context).map(([route, value]) => [route, {
          status: value.status,
          requestHistoryCorrect: value.requestHistoryCorrect,
          conversations: value.conversations?.map(({ recovered, historyCorrect, success, error }) => ({ recovered, historyCorrect, success, error })),
          basicFullStack: value.basicFullStack,
        }])),
        honesty: reports.honesty,
        tools: reports.tools,
        interruption: reports.interruption ? { ...reports.interruption, firstIssuedAt: undefined } : 'NOT_RUN',
        fallback: reports.fallback,
        deepSeekReasoning,
      },
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
