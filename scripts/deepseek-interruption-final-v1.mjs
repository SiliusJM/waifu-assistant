import { performance } from 'node:perf_hooks';
import {
  AssistantCore,
  ConversationRunner,
  DirectAIProvider,
  createLogger,
} from '../dist/index.js';
import { createCountingFetch, ProviderRequestBudget } from './provider-call-budget.mjs';

const ROUTE = 'kr/deepseek-3.2';
const MAX_PROVIDER_REQUESTS = 8;
const DEFAULT_TIMEOUT_MS = 30_000;
const A_PROMPT = 'Explícame en detalle qué es una API, cómo funciona y dame varios ejemplos.';
const B_PROMPT = 'Detente. Responde únicamente con: 81';
const SECOND_A_PROMPT = 'Explícame ampliamente cómo funciona una memoria persistente.';
const SECOND_B_PROMPT = 'Detente. Responde únicamente: 144';

function safeError(error) {
  return {
    code: error?.code ?? 'UNKNOWN_ERROR',
    statusCode: typeof error?.statusCode === 'number' ? error.statusCode : undefined,
  };
}

function silentLogger() {
  return createLogger({ sink: { info: () => {}, warn: () => {}, error: () => {} } });
}

async function* values(items) {
  yield* items;
}

function requestPrompt(body) {
  if (!Array.isArray(body?.messages)) return undefined;
  return [...body.messages].reverse().find((message) => message?.role === 'user')?.content;
}

function createRealContext(budget, route = ROUTE) {
  const baseURL = process.env.AI_BASE_URL?.trim();
  const apiKey = process.env.AI_API_KEY?.trim();
  if (!baseURL || !apiKey) throw new Error('Direct configuration is incomplete.');

  const observations = {
    requests: [],
    active: 0,
    maxActive: 0,
  };

  const trackedFetch = async (input, init = {}) => {
    let body;
    try { body = JSON.parse(String(init.body ?? '{}')); } catch { body = undefined; }
    const prompt = requestPrompt(body);
    const request = {
      prompt,
      startedAt: performance.now(),
      abortedAt: undefined,
      completedAt: undefined,
    };
    observations.requests.push(request);
    observations.active += 1;
    observations.maxActive = Math.max(observations.maxActive, observations.active);
    const onAbort = () => {
      if (request.abortedAt === undefined) request.abortedAt = performance.now();
    };
    init.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return await fetch(input, init);
    } finally {
      request.completedAt = performance.now();
      observations.active -= 1;
    }
  };

  const fetchImpl = createCountingFetch({ budget, fetchImpl: trackedFetch });
  const provider = new DirectAIProvider({
    baseURL,
    apiKey,
    model: route,
    timeoutMs: Number(process.env.AI_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS),
    retryPolicy: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
    fetchImpl,
  });
  return {
    budget,
    observations,
    core: new AssistantCore({ provider, logger: silentLogger() }),
  };
}

async function listModels(baseURL, apiKey, budget) {
  budget.countMetadataRequest();
  const response = await fetch(`${baseURL.replace(/\/+$/u, '')}/models`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) return { status: 'FAIL', ids: [], statusCode: response.status };
  const body = await response.json();
  const ids = Array.isArray(body?.data)
    ? body.data.map((item) => item?.id).filter((id) => typeof id === 'string')
    : [];
  return { status: 'PASS', ids };
}

function safeTiming(request, startedAt) {
  if (!request) return undefined;
  return {
    requestStartMs: Math.round(request.startedAt - startedAt),
    ...(request.abortedAt === undefined ? {} : { abortObservedMs: Math.round(request.abortedAt - startedAt) }),
    ...(request.completedAt === undefined ? {} : { requestEndMs: Math.round(request.completedAt - startedAt) }),
  };
}

async function runInterruption(context, firstPrompt, secondPrompt, expected) {
  const startedAt = performance.now();
  let releaseSecond;
  let releaseExit;
  const secondReady = new Promise((resolve) => { releaseSecond = resolve; });
  const exitReady = new Promise((resolve) => { releaseExit = resolve; });
  let secondAcceptedAt;
  let firstTtftAt;
  let secondTtftAt;
  let secondResponseAt;
  let firstDeltaCount = 0;
  let secondDeltaCount = 0;
  const visible = [];

  const run = await new Promise((resolve) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Number(process.env.AI_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS) + 5_000);
    const source = (async function* () {
      yield firstPrompt;
      await secondReady;
      secondAcceptedAt = performance.now();
      yield secondPrompt;
      await exitReady;
      yield '/exit';
    }());
    const runner = new ConversationRunner(context.core);
    void runner.run(source, {
      signal: controller.signal,
      interruptible: true,
      onDelta: (delta) => {
        const now = performance.now();
        visible.push({ delta, at: now });
        if (firstTtftAt === undefined) {
          firstTtftAt = now;
          firstDeltaCount += 1;
          releaseSecond?.();
        } else if (secondAcceptedAt !== undefined && secondTtftAt === undefined) {
          secondTtftAt = now;
          secondDeltaCount += 1;
        } else if (secondAcceptedAt === undefined) {
          firstDeltaCount += 1;
        } else {
          secondDeltaCount += 1;
        }
      },
      onResponse: (response) => {
        if (response.text.trim() === expected) {
          secondResponseAt = performance.now();
          releaseExit?.();
        }
      },
    }).then((result) => {
      clearTimeout(timeout);
      resolve({ result });
    }).catch((error) => {
      clearTimeout(timeout);
      resolve({ error });
    });
  });

  const messages = run.result?.session.getMessages() ?? [];
  const requests = context.observations.requests;
  const firstRequest = requests.find(({ prompt }) => prompt === firstPrompt);
  const secondRequest = requests.find(({ prompt }) => prompt === secondPrompt);
  const assistantMessages = messages.filter(({ role }) => role === 'assistant');
  const staleAfterInterrupt = visible.some(({ at, delta }) => secondAcceptedAt !== undefined
    && at >= secondAcceptedAt && /API|memoria persistente/iu.test(delta));
  const exact = assistantMessages.some(({ content }) => content.trim() === expected);
  const firstAborted = firstRequest?.abortedAt !== undefined;

  return {
    status: run.error === undefined && run.result?.status === 'completed' && exact && firstAborted
      && !staleAfterInterrupt && assistantMessages.every(({ content }) => content.trim() === expected)
      ? 'PASS' : 'FAIL',
    error: run.error ? safeError(run.error) : undefined,
    expected,
    exactResponse: exact,
    firstAborted,
    staleAfterInterrupt,
    partialFirstPersisted: assistantMessages.some(({ content }) => /API|memoria persistente/iu.test(content)),
    sessionMessageRoles: messages.map(({ role }) => role),
    maxActive: context.observations.maxActive,
    timing: {
      first: safeTiming(firstRequest, startedAt),
      second: safeTiming(secondRequest, startedAt),
      firstTtftMs: firstTtftAt === undefined ? undefined : Math.round(firstTtftAt - startedAt),
      secondAcceptedMs: secondAcceptedAt === undefined ? undefined : Math.round(secondAcceptedAt - startedAt),
      firstDeltaCount,
      secondDeltaCount,
      abortObservedMs: firstRequest?.abortedAt === undefined ? undefined : Math.round(firstRequest.abortedAt - startedAt),
      interruptionLatencyMs: firstRequest?.abortedAt === undefined || secondAcceptedAt === undefined
        ? undefined : Math.round(firstRequest.abortedAt - secondAcceptedAt),
      secondTtftMs: secondTtftAt === undefined ? undefined : Math.round(secondTtftAt - startedAt),
      secondTotalMs: secondResponseAt === undefined ? undefined : Math.round(secondResponseAt - startedAt),
    },
  };
}

export async function runFinalGate() {
  if (process.env.AI_PROVIDER !== 'direct') throw new Error('AI_PROVIDER must be direct.');
  const baseURL = process.env.AI_BASE_URL?.trim();
  const apiKey = process.env.AI_API_KEY?.trim();
  if (!baseURL || !apiKey) throw new Error('Direct configuration is incomplete.');
  const budget = new ProviderRequestBudget(MAX_PROVIDER_REQUESTS);
  const metadata = await listModels(baseURL, apiKey, budget);
  const available = metadata.ids.includes(ROUTE);
  const report = {
    status: 'BLOCKED',
    route: ROUTE,
    metadata: { status: metadata.status, available, ids: metadata.ids.filter((id) => id === ROUTE) },
    run1: 'NOT_RUN',
    run2: 'NOT_RUN',
    accounting: undefined,
    secretsPrinted: false,
    rawTranscriptsPersisted: false,
  };
  if (!available) {
    report.accounting = budget.snapshot();
    return report;
  }

  const context1 = createRealContext(budget);
  report.run1 = await runInterruption(context1, A_PROMPT, B_PROMPT, '81');
  if (report.run1.status === 'PASS' && budget.canReserve(2)) {
    const context2 = createRealContext(budget);
    report.run2 = await runInterruption(context2, SECOND_A_PROMPT, SECOND_B_PROMPT, '144');
  }
  report.status = report.run1.status === 'PASS'
    && (report.run2 === 'NOT_RUN' || report.run2.status === 'PASS') ? 'PASS' : 'FAIL';
  report.accounting = budget.snapshot();
  return report;
}

runFinalGate().then((report) => {
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (report.status !== 'PASS') process.exitCode = 1;
}).catch((error) => {
  process.stderr.write(`${JSON.stringify({ status: 'FAIL', error: safeError(error), secretsPrinted: false })}\n`);
  process.exitCode = 1;
});
