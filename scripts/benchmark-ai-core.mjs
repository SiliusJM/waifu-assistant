export function classifyBenchmarkError(error) {
  const statusCode = error?.statusCode ?? error?.status;
  const code = error?.errorCode ?? error?.code;

  if (statusCode === 499) return 'HTTP_499';
  if (statusCode === 429) return 'HTTP_429';
  if (statusCode === 403) return 'HTTP_403';
  if (typeof statusCode === 'number' && statusCode >= 500) return 'HTTP_5XX';
  if (typeof statusCode === 'number' && statusCode >= 400) return 'HTTP_4XX';
  if (code === 'TIMEOUT_ERROR') return 'TIMEOUT';
  if (code === 'CANCELLATION_ERROR') return 'CANCELLED';
  if (code === 'NETWORK_ERROR') return 'NETWORK';
  if (code === 'INVALID_RESPONSE_ERROR') return 'INVALID_RESPONSE';
  if (code === 'PROVIDER_ERROR') return 'STREAM_ERROR';
  return 'UNKNOWN';
}

export function safeFailureRecord({ route, promptId, elapsedMs, error }) {
  return {
    route,
    promptId,
    success: false,
    totalMs: Math.max(0, Math.round(elapsedMs)),
    deltaCount: 0,
    outputCharacters: 0,
    errorCategory: classifyBenchmarkError(error),
    ...(typeof (error?.statusCode ?? error?.status) === 'number'
      ? { statusCode: error.statusCode ?? error.status }
      : {}),
  };
}

export async function executeIsolatedCall({ route, promptId, run, toRecord = (value) => value, now = () => performance.now() }) {
  const started = now();
  try {
    const raw = await run();
    const record = {
      route,
      promptId,
      ...toRecord(raw),
      totalMs: raw.totalMs ?? Math.max(0, Math.round(now() - started)),
    };
    return { raw, record };
  } catch (error) {
    const record = safeFailureRecord({
      route,
      promptId,
      elapsedMs: now() - started,
      error,
    });
    return { raw: { success: false, ...record }, record };
  }
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined;
}

export function summarizeRoutes(routes, results) {
  return routes.map((route) => {
    const records = results.filter((item) => item.route === route);
    const successful = records.filter(({ success }) => success);
    const ttft = successful.map(({ ttftMs }) => ttftMs).filter((value) => value !== undefined);
    const totals = successful.map(({ totalMs }) => totalMs).filter((value) => value !== undefined);
    return {
      route,
      attempts: records.length,
      successes: successful.length,
      failures: records.length - successful.length,
      errorCategories: [...new Set(records.filter(({ success }) => !success).map(({ errorCategory }) => errorCategory).filter(Boolean))],
      successRate: records.length ? successful.length / records.length : 0,
      ttftMinMs: ttft.length ? Math.min(...ttft) : undefined,
      ttftAvgMs: average(ttft),
      ttftMaxMs: ttft.length ? Math.max(...ttft) : undefined,
      totalMinMs: totals.length ? Math.min(...totals) : undefined,
      totalAvgMs: average(totals),
      totalMaxMs: totals.length ? Math.max(...totals) : undefined,
      deltaMin: successful.length ? Math.min(...successful.map(({ deltaCount = 0 }) => deltaCount)) : undefined,
      deltaMax: successful.length ? Math.max(...successful.map(({ deltaCount = 0 }) => deltaCount)) : undefined,
      streaming: successful.some(({ deltaCount = 0 }) => deltaCount > 1),
    };
  });
}

export function selectFinalist(routeSummary) {
  return [...routeSummary]
    .filter(({ successes }) => successes > 0)
    .sort((left, right) => (right.successRate - left.successRate)
      || ((left.ttftAvgMs ?? Infinity) - (right.ttftAvgMs ?? Infinity)))[0]?.route;
}

const FREE_CANDIDATE_PREFERENCE = [
  'free-only',
  'kc/openrouter/free',
  'kilocode/openrouter/free',
  'openrouter/nex-agi/nex-n2.5-mini:free',
  'openrouter/qwen/qwen3.8-27b:free',
  'openrouter/inclusionai/ling-3.0-flash-sante:free',
  'openrouter/nvidia/nemotron-3-super-120b-a12b:free',
  'openrouter/cohere/north-mini-code:free',
];

function modelId(model) {
  return typeof model === 'string' ? model : model?.id;
}

export function classifyModelCategory(model) {
  const id = modelId(model)?.toLowerCase() ?? '';
  if (!id) return 'UNKNOWN';
  if (/(embedding|embed|rerank)/u.test(id)) return 'EMBEDDING';
  if (/(image|flux|vision)/u.test(id)) return 'IMAGE';
  if (/(audio|speech|whisper|tts)/u.test(id)) return 'AUDIO';
  return 'CHAT/TEXT';
}

export function selectFreeChatCandidates(models, limit = 8) {
  const available = new Map(
    models
      .filter((model) => classifyModelCategory(model) === 'CHAT/TEXT')
      .map((model) => [modelId(model), model]),
  );
  const isFree = (id) => id === 'free-only'
    || id === 'kc/openrouter/free'
    || id === 'kilocode/openrouter/free'
    || id?.endsWith(':free');
  const candidates = [...available.values()]
    .filter((model) => isFree(modelId(model)) && modelId(model) !== 'fast')
    .sort((left, right) => modelId(left).localeCompare(modelId(right)));
  const preferred = FREE_CANDIDATE_PREFERENCE
    .map((id) => available.get(id))
    .filter(Boolean)
    .filter((model) => isFree(modelId(model)));
  const selected = [...new Map([...preferred, ...candidates].map((model) => [modelId(model), model])).values()];
  return selected.slice(0, limit);
}

export function rankRouteSummary(routeSummary) {
  return [...routeSummary].sort((left, right) => (right.successRate - left.successRate)
    || ((left.ttftAvgMs ?? Infinity) - (right.ttftAvgMs ?? Infinity))
    || ((left.totalAvgMs ?? Infinity) - (right.totalAvgMs ?? Infinity))
    || left.route.localeCompare(right.route));
}
