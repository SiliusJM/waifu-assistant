import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyBenchmarkError,
  executeIsolatedCall,
  selectFinalist,
  summarizeRoutes,
  classifyModelCategory,
  selectFreeChatCandidates,
  rankRouteSummary,
} from './benchmark-ai-core.mjs';

test('isolates a cancelled route and continues with the next route', async () => {
  const results = [];
  const routeRuns = [
    () => ({ success: true, totalMs: 12, deltaCount: 2 }),
    () => { throw { code: 'CANCELLATION_ERROR' }; },
    () => ({ success: true, totalMs: 8, deltaCount: 3 }),
  ];

  for (const [index, run] of routeRuns.entries()) {
    const result = await executeIsolatedCall({
      route: String.fromCharCode(65 + index),
      promptId: 'latency-01',
      run,
      now: (() => {
        let value = 100;
        return () => { value += 5; return value; };
      })(),
    });
    results.push(result.record);
  }

  assert.deepEqual(results.map(({ success }) => success), [true, false, true]);
  assert.equal(results[1].errorCategory, 'CANCELLED');
  assert.equal(results[2].deltaCount, 3);
});

test('classifies timeout, HTTP and stream failures safely', () => {
  assert.equal(classifyBenchmarkError({ code: 'TIMEOUT_ERROR' }), 'TIMEOUT');
  assert.equal(classifyBenchmarkError({ code: 'CANCELLATION_ERROR' }), 'CANCELLED');
  assert.equal(classifyBenchmarkError({ statusCode: 400 }), 'HTTP_4XX');
  assert.equal(classifyBenchmarkError({ statusCode: 429 }), 'HTTP_429');
  assert.equal(classifyBenchmarkError({ statusCode: 499 }), 'HTTP_499');
  assert.equal(classifyBenchmarkError({ statusCode: 503 }), 'HTTP_5XX');
  assert.equal(classifyBenchmarkError({ code: 'INVALID_RESPONSE_ERROR' }), 'INVALID_RESPONSE');
  assert.equal(classifyBenchmarkError({ code: 'NETWORK_ERROR' }), 'NETWORK');
});

test('summarizes all-fail and mixed route matrices without throwing', () => {
  const routes = ['auto', 'fast', 'deep'];
  const results = [
    { route: 'auto', success: false, totalMs: 30000, errorCategory: 'TIMEOUT' },
    { route: 'fast', success: true, ttftMs: 120, totalMs: 900, deltaCount: 4 },
    { route: 'fast', success: false, totalMs: 1200, errorCategory: 'HTTP_429' },
    { route: 'deep', success: false, totalMs: 30000, errorCategory: 'CANCELLED' },
  ];
  const summary = summarizeRoutes(routes, results);

  assert.equal(summary[0].failures, 1);
  assert.equal(summary[1].attempts, 2);
  assert.equal(summary[1].streaming, true);
  assert.deepEqual(summary[1].errorCategories, ['HTTP_429']);
  assert.equal(selectFinalist(summary), 'fast');
});

test('an aborted request does not contaminate the following request', async () => {
  const first = await executeIsolatedCall({
    route: 'auto',
    promptId: 'latency-01',
    run: async () => { throw { code: 'CANCELLATION_ERROR' }; },
  });
  const second = await executeIsolatedCall({
    route: 'fast',
    promptId: 'latency-01',
    run: async () => ({ success: true, totalMs: 10, deltaCount: 2 }),
  });

  assert.equal(first.record.errorCategory, 'CANCELLED');
  assert.equal(second.record.success, true);
});

test('records first, middle, last, timeout, invalid response and rate-limit failures', async () => {
  const scenarios = [
    ['first', { code: 'TIMEOUT_ERROR' }],
    ['middle', { code: 'INVALID_RESPONSE_ERROR' }],
    ['last', { statusCode: 429 }],
  ];
  const records = [];
  for (const [route, error] of scenarios) {
    const result = await executeIsolatedCall({
      route,
      promptId: 'latency-01',
      run: async () => { throw error; },
    });
    records.push(result.record);
  }

  assert.deepEqual(records.map(({ errorCategory }) => errorCategory), ['TIMEOUT', 'INVALID_RESPONSE', 'HTTP_429']);
  assert.deepEqual(summarizeRoutes(scenarios.map(([route]) => route), records).map(({ failures }) => failures), [1, 1, 1]);
  assert.equal(selectFinalist(summarizeRoutes(scenarios.map(([route]) => route), records)), undefined);
});

test('all-fail matrices still produce one safe record per attempted route', async () => {
  const routes = ['auto', 'free-only', 'fast'];
  const records = [];
  for (const route of routes) {
    const result = await executeIsolatedCall({
      route,
      promptId: 'normal-01',
      run: async () => { throw { code: 'TIMEOUT_ERROR' }; },
    });
    records.push(result.record);
  }

  assert.equal(records.length, routes.length);
  assert.deepEqual(summarizeRoutes(routes, records).map(({ attempts, successes }) => [attempts, successes]), [[1, 0], [1, 0], [1, 0]]);
});

test('classifies model catalog entries without treating image or embedding routes as chat', () => {
  assert.equal(classifyModelCategory({ id: 'openrouter/qwen/qwen3.8-27b:free' }), 'CHAT/TEXT');
  assert.equal(classifyModelCategory({ id: 'openrouter/openai/text-embedding-3-small' }), 'EMBEDDING');
  assert.equal(classifyModelCategory({ id: 'openrouter/black-forest-labs/flux.2-pro' }), 'IMAGE');
  assert.equal(classifyModelCategory({ id: 'openrouter/openai/whisper' }), 'AUDIO');
  assert.equal(classifyModelCategory({}), 'UNKNOWN');
});

test('selects deterministic free chat candidates and excludes the known image route', () => {
  const models = [
    { id: 'zeta:free' },
    { id: 'free-only' },
    { id: 'fast' },
    { id: 'openrouter/qwen/qwen3.8-27b:free' },
    { id: 'openrouter/openai/text-embedding-3-small' },
    { id: 'kc/openrouter/free' },
  ];
  assert.deepEqual(selectFreeChatCandidates(models, 4).map(({ id }) => id), [
    'free-only',
    'kc/openrouter/free',
    'openrouter/qwen/qwen3.8-27b:free',
    'zeta:free',
  ]);
});

test('ranks successful routes deterministically by success, TTFT, total time and id', () => {
  const ranked = rankRouteSummary([
    { route: 'b', successRate: 1, ttftAvgMs: 30, totalAvgMs: 100 },
    { route: 'c', successRate: 1, ttftAvgMs: 20, totalAvgMs: 200 },
    { route: 'a', successRate: 0.5, ttftAvgMs: 1, totalAvgMs: 1 },
  ]);
  assert.deepEqual(ranked.map(({ route }) => route), ['c', 'b', 'a']);
});
