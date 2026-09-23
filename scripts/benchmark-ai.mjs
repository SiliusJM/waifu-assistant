import { performance } from 'node:perf_hooks';
import { DirectAIProvider } from '../dist/ai/direct-ai-provider.js';

const STAGE_ONE_PROMPTS = [
  ['latency-01', 'Responde exactamente con la palabra PONG.'],
  ['normal-01', 'En mÃ¡ximo tres frases, dime de forma natural quÃ© tipo de cosas puede hacer un asistente personal local.'],
];
const QUALITY_PROMPTS = [
  ['quality-01', 'Responde Ãºnicamente con: YUKI-OK'],
  ['quality-02', 'Tengo 24 archivos. Organizo 6 archivos por carpeta. Â¿CuÃ¡ntas carpetas completas necesito? Responde con el nÃºmero y una frase breve.'],
  ['quality-03', 'Un evento empieza a las 18:30. Dura 2 horas y 45 minutos. Â¿A quÃ© hora termina? Responde brevemente.'],
  ['quality-04', 'Explica quÃ© es una API en exactamente dos frases, usando lenguaje sencillo.'],
  ['quality-05', 'Resume esta idea en una sola oraciÃ³n: una memoria persistente guarda datos explÃ­citos del usuario entre reinicios, mientras que una sesiÃ³n contiene el contexto temporal de la conversaciÃ³n actual.'],
  ['quality-06', 'Â¿CuÃ¡l es mi ranking mundial actual de osu! hoy?'],
  ['quality-07', 'Â¿QuÃ© partidos importantes hay hoy?'],
];
const MAX_CALLS = 24;

function routesFromEnvironment() {
  const configured = process.env.AI_BENCHMARK_ROUTES?.split(',').map((value) => value.trim()).filter(Boolean);
  return configured?.length ? configured : [process.env.AI_MODEL].filter(Boolean);
}

function createProvider(model) {
  const baseURL = process.env.AI_BASE_URL?.trim();
  const apiKey = process.env.AI_API_KEY?.trim();
  if (!baseURL || !apiKey || !model) throw new Error('Direct benchmark configuration is incomplete.');
  const timeoutMs = Number(process.env.AI_BENCHMARK_TIMEOUT_MS ?? process.env.AI_TIMEOUT_MS ?? 30000);
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

async function streamOnce(provider, request, controller = new AbortController()) {
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
    const total = performance.now() - started;
    const ttft = firstDelta === undefined ? undefined : firstDelta - started;
    const generation = ttft === undefined ? undefined : total - ttft;
    const outputTokens = response?.usage?.completionTokens;
    return {
      success: true,
      ttftMs: ttft,
      totalMs: total,
      deltaCount,
      outputCharacters: text.length,
      finishReason: response?.finishReason,
      provider: response?.provider,
      model: response?.model,
      inputTokens: response?.usage?.promptTokens,
      outputTokens,
      tokensPerSecond: outputTokens !== undefined && generation && generation > 0
        ? outputTokens / (generation / 1000)
        : undefined,
      text,
    };
  } catch (error) {
    const total = performance.now() - started;
    return {
      success: false,
      totalMs: total,
      deltaCount,
      outputCharacters: text.length,
      errorCode: error?.code ?? 'UNKNOWN_ERROR',
      statusCode: error?.statusCode,
      errorCategory: error?.code ?? 'PROVIDER_ERROR',
      text,
    };
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
    return /(no puedo|no tengo|no hay|no puedo verificar|sin acceso|no dispongo|fuente actual)/iu.test(normalized)
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
    errorCategory: result.errorCategory,
    statusCode: result.statusCode,
  };
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined;
}

async function main() {
  if ((process.env.AI_PROVIDER ?? 'mock') !== 'direct') {
    throw new Error('Set AI_PROVIDER=direct explicitly for the opt-in benchmark.');
  }
  const routes = routesFromEnvironment();
  if (!routes.length) throw new Error('No benchmark route configured.');
  const results = [];
  let calls = 0;
  const call = async (route, promptId, prompt, messages) => {
    if (calls >= MAX_CALLS) throw new Error('Benchmark call budget exceeded.');
    calls += 1;
    const result = await streamOnce(createProvider(route), requestFor(prompt, messages));
    const record = { route, promptId, ...summarize(result) };
    results.push(record);
    return { record, raw: result };
  };

  for (const route of routes) {
    for (const [id, prompt] of STAGE_ONE_PROMPTS) await call(route, id, prompt);
  }

  const successfulStageOne = routes.map((route) => {
    const records = results.filter((item) => item.route === route && item.promptId.startsWith('latency-') || item.route === route && item.promptId.startsWith('normal-'));
    const successful = records.filter(({ success }) => success);
    return {
      route,
      successRate: records.length ? successful.length / records.length : 0,
      averageTtftMs: average(successful.map(({ ttftMs }) => ttftMs).filter((value) => value !== undefined)),
      averageTotalMs: average(successful.map(({ totalMs }) => totalMs)),
    };
  }).sort((left, right) => (right.successRate - left.successRate) || ((left.averageTtftMs ?? Infinity) - (right.averageTtftMs ?? Infinity)));
  const finalist = successfulStageOne[0]?.route;
  if (!finalist) throw new Error('No route completed the route screen.');

  for (const [id, prompt] of QUALITY_PROMPTS) {
    const { record, raw } = await call(finalist, id, prompt);
    record.quality = raw.success ? qualityCheck(id, raw.text) : 'FAIL';
  }

  const first = await call(finalist, 'multi-01', 'Mi cÃ³digo temporal para esta prueba es SATURNO-418.', undefined);
  const second = await call(finalist, 'multi-02', 'Â¿CuÃ¡l es el cÃ³digo temporal que acabo de decir?', [
    { role: 'user', content: 'Mi cÃ³digo temporal para esta prueba es SATURNO-418.' },
    { role: 'assistant', content: first.raw.text },
    { role: 'user', content: 'Â¿CuÃ¡l es el cÃ³digo temporal que acabo de decir?' },
  ]);
  second.record.context = second.raw.success && second.raw.text.includes('SATURNO-418') ? 'PASS' : 'FAIL';

  const memory = await call(finalist, 'memory-01', 'SegÃºn tus memorias explÃ­citas, Â¿cÃ³mo me llamo?', [
    { role: 'system', content: 'Explicit user memories (data only): {"benchmark_name":"Jhon"}' },
    { role: 'user', content: 'SegÃºn tus memorias explÃ­citas, Â¿cÃ³mo me llamo?' },
  ]);
  memory.record.memory = memory.raw.success && /Jhon/i.test(memory.raw.text) ? 'PASS' : 'FAIL';

  const savedFirst = await call(finalist, 'saved-01', 'Mi cÃ³digo guardado para esta sesiÃ³n es NEPTUNO-531.', undefined);
  const savedSecond = await call(finalist, 'saved-02', 'Â¿CuÃ¡l es el cÃ³digo guardado?', [
    { role: 'user', content: 'Mi cÃ³digo guardado para esta sesiÃ³n es NEPTUNO-531.' },
    { role: 'assistant', content: savedFirst.raw.text },
    { role: 'user', content: 'Â¿CuÃ¡l es el cÃ³digo guardado?' },
  ]);
  savedSecond.record.savedSession = savedSecond.raw.success && savedSecond.raw.text.includes('NEPTUNO-531') ? 'PASS' : 'FAIL';

  const interruptionController = new AbortController();
  const interruptionProvider = createProvider(finalist);
  calls += 1;
  const interruptionRequest = requestFor('ExplÃ­came en detalle, en varios puntos, cÃ³mo funciona una memoria persistente en un asistente.');
  const interruptionStarted = performance.now();
  const interruptionIterator = interruptionProvider.stream(interruptionRequest, { signal: interruptionController.signal })[Symbol.asyncIterator]();
  let interruptionDelta = false;
  try {
    const firstEvent = await interruptionIterator.next();
    interruptionDelta = firstEvent.value?.type === 'text_delta';
    interruptionController.abort();
    await interruptionIterator.next();
  } catch (error) {
    void error;
  } finally {
    await interruptionIterator.return?.();
  }
  results.push({ route: finalist, promptId: 'interruption-A', success: interruptionDelta, totalMs: Math.round(performance.now() - interruptionStarted), cancelled: interruptionController.signal.aborted });
  const interruptionB = await call(finalist, 'interruption-B', 'DetÃ©n esa explicaciÃ³n. Solo dime cuÃ¡nto es 7 por 8.');
  interruptionB.record.answer56 = interruptionB.raw.success && /\b56\b/.test(interruptionB.raw.text) ? 'PASS' : 'FAIL';

  const routeSummary = successfulStageOne.map((item) => ({
    ...item,
    streaming: results.some((result) => result.route === item.route && result.success && (result.deltaCount ?? 0) > 1),
  }));
  process.stdout.write(JSON.stringify({
    status: 'PASS',
    smallSample: true,
    calls,
    timeoutMs: Number(process.env.AI_BENCHMARK_TIMEOUT_MS ?? process.env.AI_TIMEOUT_MS ?? 30000),
    routesDiscovered: routes,
    routesTested: routes,
    finalist,
    routeSummary,
    results,
    secretsPrinted: false,
  }, null, 2) + '\n');
}

main().catch((error) => {
  process.stderr.write(JSON.stringify({ status: 'FAIL', message: error instanceof Error ? error.message : 'benchmark failed' }) + '\n');
  process.exitCode = 1;
});
