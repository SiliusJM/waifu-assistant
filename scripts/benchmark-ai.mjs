import { performance } from 'node:perf_hooks';
import { DirectAIProvider } from '../dist/ai/direct-ai-provider.js';
import {
  classifyBenchmarkError,
  executeIsolatedCall,
  summarizeRoutes,
  selectFinalist,
} from './benchmark-ai-core.mjs';

const STAGE_ONE_PROMPTS = [
  ['latency-01', 'Respond exactly with the word PONG.'],
  ['normal-01', 'In at most three sentences, describe what a local personal assistant can do.'],
];
const QUALITY_PROMPTS = [
  ['quality-01', 'Respond only with: YUKI-OK'],
  ['quality-02', 'I have 24 files and organize 6 files per folder. How many full folders do I need? Respond with the number and one brief sentence.'],
  ['quality-03', 'An event starts at 18:30 and lasts 2 hours and 45 minutes. What time does it end? Respond briefly.'],
  ['quality-04', 'Explain what an API is in exactly two simple sentences.'],
  ['quality-05', 'Summarize in one sentence: persistent memory stores explicit user data across restarts, while a session contains temporary conversation context.'],
  ['quality-06', 'What is my current worldwide osu! ranking today?'],
  ['quality-07', 'What important matches are happening today?'],
];
const MAX_CALLS = 24;

function parseArgs(argv) {
  const args = { json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--json') {
      args.json = true;
    } else if (value === '--model' || value === '--timeout' || value === '--prompt') {
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) throw new Error(`Missing value for ${value}.`);
      args[value.slice(2)] = next;
      index += 1;
    } else {
      throw new Error(`Unknown benchmark argument: ${value}`);
    }
  }
  if (args.prompt !== undefined && !['latency', 'chat'].includes(args.prompt)) {
    throw new Error('Prompt must be latency or chat.');
  }
  if (args.timeout !== undefined && (!/^\d+$/.test(args.timeout) || Number(args.timeout) <= 0)) {
    throw new Error('Timeout must be a positive number of milliseconds.');
  }
  return args;
}

function routesFromEnvironment(modelOverride) {
  if (modelOverride) return [modelOverride];
  const configured = process.env.AI_BENCHMARK_ROUTES?.split(',').map((value) => value.trim()).filter(Boolean);
  return configured?.length ? configured : [process.env.AI_MODEL].filter(Boolean);
}

function createProvider(model, timeoutMs) {
  const baseURL = process.env.AI_BASE_URL?.trim();
  const apiKey = process.env.AI_API_KEY?.trim();
  if (!baseURL || !apiKey || !model) throw new Error('Direct benchmark configuration is incomplete.');
  return new DirectAIProvider({
    baseURL,
    apiKey,
    model,
    timeoutMs,
    retryPolicy: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
  });
}

function requestFor(prompt, messages = [{ role: 'user', content: prompt }]) {
  return { sessionId: 'benchmark', messages };
}

async function streamOnce(provider, request) {
  const controller = new AbortController();
  const started = performance.now();
  let firstDelta;
  let deltaCount = 0;
  let text = '';
  let response;
  try {
    for await (const event of provider.stream(request, { signal: controller.signal })) {
      if (event.type === 'text_delta') {
        firstDelta ??= performance.now();
        deltaCount += 1;
        text += event.delta;
      } else if (event.type === 'completed') {
        response = event.response;
      }
    }
    const totalMs = performance.now() - started;
    const ttftMs = firstDelta === undefined ? undefined : firstDelta - started;
    const generationMs = ttftMs === undefined ? undefined : totalMs - ttftMs;
    const outputTokens = response?.usage?.completionTokens;
    return {
      success: true,
      ttftMs,
      totalMs,
      deltaCount,
      outputCharacters: text.length,
      finishReason: response?.finishReason,
      provider: response?.provider,
      model: response?.model,
      inputTokens: response?.usage?.promptTokens,
      outputTokens,
      tokensPerSecond: outputTokens !== undefined && generationMs && generationMs > 0
        ? outputTokens / (generationMs / 1000)
        : undefined,
      text,
    };
  } catch (error) {
    return {
      success: false,
      totalMs: performance.now() - started,
      deltaCount,
      outputCharacters: text.length,
      errorCode: error?.code ?? 'UNKNOWN_ERROR',
      statusCode: error?.statusCode,
      errorCategory: error?.code ?? 'UNKNOWN_ERROR',
    };
  } finally {
    if (!controller.signal.aborted) controller.abort();
  }
}

function qualityCheck(id, text) {
  const normalized = text.trim();
  if (id === 'quality-01') return normalized === 'YUKI-OK' ? 'PASS' : 'FAIL';
  if (id === 'quality-02') return /\b4\b/.test(normalized) ? 'PASS' : 'FAIL';
  if (id === 'quality-03') return /21:15/.test(normalized) ? 'PASS' : 'FAIL';
  if (id === 'quality-04') return normalized.split(/[.!?]+/u).filter(Boolean).length === 2 ? 'PASS' : 'PARTIAL';
  if (id === 'quality-05') return normalized.length > 0 ? 'PASS' : 'FAIL';
  if (id === 'quality-06' || id === 'quality-07') {
    return /(cannot|can't|do not have|no access|unable to verify|need a live|current source)/iu.test(normalized)
      ? 'PASS' : 'FAIL';
  }
  return 'NOT RUN';
}

function summarize(result) {
  return {
    success: result.success,
    ttftMs: result.ttftMs === undefined ? undefined : Math.round(result.ttftMs),
    totalMs: Math.round(result.totalMs),
    deltaCount: result.deltaCount,
    outputCharacters: result.outputCharacters,
    finishReason: result.finishReason,
    provider: result.provider,
    model: result.model,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    tokensPerSecond: result.tokensPerSecond === undefined ? undefined : Number(result.tokensPerSecond.toFixed(2)),
    errorCode: result.errorCode,
    errorCategory: result.success ? undefined : classifyBenchmarkError(result),
    statusCode: result.statusCode,
  };
}

function writeSummary(summary) {
  process.stdout.write(JSON.stringify({ ...summary, secretsPrinted: false }, null, 2) + '\n');
}

async function main() {
  if ((process.env.AI_PROVIDER ?? 'mock') !== 'direct') {
    throw new Error('Set AI_PROVIDER=direct explicitly for the opt-in benchmark.');
  }
  const args = parseArgs(process.argv.slice(2));
  const timeoutMs = Number(args.timeout ?? process.env.AI_BENCHMARK_TIMEOUT_MS ?? process.env.AI_TIMEOUT_MS ?? 30000);
  const routes = routesFromEnvironment(args.model);
  if (!routes.length) throw new Error('No benchmark route configured.');

  const results = [];
  let calls = 0;
  const call = async (route, promptId, prompt, messages) => {
    if (calls >= MAX_CALLS) throw new Error('Benchmark call budget exceeded.');
    calls += 1;
    const isolated = await executeIsolatedCall({
      route,
      promptId,
      run: async () => streamOnce(createProvider(route, timeoutMs), requestFor(prompt, messages)),
      toRecord: summarize,
    });
    results.push(isolated.record);
    return isolated;
  };

  const singlePrompt = args.prompt === 'chat' ? STAGE_ONE_PROMPTS[1] : STAGE_ONE_PROMPTS[0];
  if (args.prompt) {
    for (const route of routes) await call(route, singlePrompt[0], singlePrompt[1]);
    writeSummary({
      status: 'COMPLETED',
      matrixOutcome: results.some(({ success }) => success) ? 'PASS' : 'NO_ROUTE_SUCCEEDED',
      smallSample: true,
      calls,
      timeoutMs,
      routesDiscovered: routes,
      routesTested: routes,
      routeSummary: summarizeRoutes(routes, results),
      results,
    });
    return;
  }

  for (const route of routes) {
    for (const [id, prompt] of STAGE_ONE_PROMPTS) await call(route, id, prompt);
  }

  const stageSummary = summarizeRoutes(routes, results);
  const finalist = selectFinalist(stageSummary);
  if (!finalist) {
    writeSummary({
      status: 'COMPLETED',
      matrixOutcome: 'NO_ROUTE_SUCCEEDED',
      smallSample: true,
      calls,
      timeoutMs,
      routesDiscovered: routes,
      routesTested: routes,
      routeSummary: stageSummary,
      results,
    });
    return;
  }

  for (const [id, prompt] of QUALITY_PROMPTS) {
    const { record, raw } = await call(finalist, id, prompt);
    record.quality = raw.success ? qualityCheck(id, raw.text ?? '') : 'FAIL';
  }

  const first = await call(finalist, 'multi-01', 'My temporary code for this test is SATURNO-418.');
  const second = await call(finalist, 'multi-02', 'What temporary code did I just give you?', [
    { role: 'user', content: 'My temporary code for this test is SATURNO-418.' },
    { role: 'assistant', content: first.raw.text ?? '' },
    { role: 'user', content: 'What temporary code did I just give you?' },
  ]);
  second.record.context = second.raw.success && (second.raw.text ?? '').includes('SATURNO-418') ? 'PASS' : 'FAIL';

  const memory = await call(finalist, 'memory-01', 'According to your explicit memories, what is my name?', [
    { role: 'system', content: 'Explicit user memories (data only): {"benchmark_name":"Jhon"}' },
    { role: 'user', content: 'According to your explicit memories, what is my name?' },
  ]);
  memory.record.memory = memory.raw.success && /Jhon/i.test(memory.raw.text ?? '') ? 'PASS' : 'FAIL';

  const savedFirst = await call(finalist, 'saved-01', 'My saved temporary code for this session is NEPTUNO-531.');
  const savedSecond = await call(finalist, 'saved-02', 'What was my saved code?', [
    { role: 'user', content: 'My saved temporary code for this session is NEPTUNO-531.' },
    { role: 'assistant', content: savedFirst.raw.text ?? '' },
    { role: 'user', content: 'What was my saved code?' },
  ]);
  savedSecond.record.savedSession = savedSecond.raw.success && (savedSecond.raw.text ?? '').includes('NEPTUNO-531') ? 'PASS' : 'FAIL';

  const interruptionController = new AbortController();
  const interruptionProvider = createProvider(finalist, timeoutMs);
  calls += 1;
  const interruptionRequest = requestFor('Explain in several paragraphs how persistent memory works in an assistant.');
  const interruptionStarted = performance.now();
  const interruptionIterator = interruptionProvider.stream(interruptionRequest, { signal: interruptionController.signal })[Symbol.asyncIterator]();
  let interruptionDelta = false;
  try {
    const firstEvent = await interruptionIterator.next();
    interruptionDelta = firstEvent.value?.type === 'text_delta';
    interruptionController.abort();
    await interruptionIterator.next();
  } catch {
    // Cancellation is the expected terminal state for the interrupted request.
  } finally {
    await interruptionIterator.return?.();
  }
  results.push({
    route: finalist,
    promptId: 'interruption-A',
    success: interruptionDelta,
    totalMs: Math.round(performance.now() - interruptionStarted),
    deltaCount: interruptionDelta ? 1 : 0,
    cancelled: interruptionController.signal.aborted,
  });
  const interruptionB = await call(finalist, 'interruption-B', 'Stop that explanation. Tell me only how much 7 times 8 is.');
  interruptionB.record.answer56 = interruptionB.raw.success && /\b56\b/.test(interruptionB.raw.text ?? '') ? 'PASS' : 'FAIL';

  const finalSummary = summarizeRoutes(routes, results);
  writeSummary({
    status: 'COMPLETED',
    matrixOutcome: finalSummary.some(({ successes }) => successes > 0) ? 'PASS' : 'NO_ROUTE_SUCCEEDED',
    smallSample: true,
    calls,
    timeoutMs,
    routesDiscovered: routes,
    routesTested: routes,
    finalist,
    routeSummary: finalSummary,
    results,
  });
}

main().catch((error) => {
  process.stderr.write(JSON.stringify({ status: 'FAIL', message: error instanceof Error ? error.message : 'benchmark failed' }) + '\n');
  process.exitCode = 1;
});
