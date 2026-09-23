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
