import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluateScenario,
  loadScenarioSet,
  parseBenchmarkArgs,
  percentile,
  redactRecord,
  resolveBenchmarkConfig,
  summarizeBenchmark,
  warmupGate,
} from './provider-benchmark-v1-core.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const scenariosPath = resolve(dirname(fileURLToPath(import.meta.url)), 'provider-benchmark-v1-scenarios.json');

test('V1 benchmark enforces fixed iterations, timeout bounds and known profiles', () => {
  assert.equal(parseBenchmarkArgs(['--profiles', 'omniroute,gemini']).profiles.length, 2);
  assert.throws(() => parseBenchmarkArgs(['--iterations', '4']), /exactly 3/u);
  assert.throws(() => parseBenchmarkArgs(['--profiles', 'unknown']), /subset/u);
  assert.throws(() => parseBenchmarkArgs(['--timeout-ms', '1']), /between/u);
});

test('versioned V1 scenario set has the bounded fixed structure', async () => {
  const scenarios = await loadScenarioSet(scenariosPath);
  assert.equal(scenarios.singleTurnScenarios.length, 8);
  assert.equal(scenarios.multiTurn.sessions.length, 3);
  assert.deepEqual(scenarios.multiTurn.sessions.map(({ code }) => code), ['SATURNO-418', 'LUNA-742', 'NUBE-263']);
});

test('failed warmup gates off further work for that provider', () => {
  assert.deepEqual(warmupGate({ success: true }), { ready: true });
  assert.deepEqual(warmupGate({ success: false, errorCategory: 'INVALID_RESPONSE' }), {
    ready: false,
    reason: 'WARMUP_FAILED_INVALID_RESPONSE',
  });
});

test('quality checks are explicit and evaluate the fixed scenario contract', () => {
  assert.equal(evaluateScenario(['exactJson'], '{"status":"ok","count":3}').pass, true);
  assert.equal(evaluateScenario(['exactJson'], '```json\n{"status":"ok","count":3}\n```').pass, false);
  assert.equal(evaluateScenario(['preserveTechnicalTerms'], 'Spring Boot QueryDSL GitHub VS Code streaming').pass, true);
  assert.equal(evaluateScenario(['asksForTime', 'noActionClaim'], '¿A qué hora quieres llamar?').pass, true);
  assert.equal(evaluateScenario(['recallsSessionCode'], 'El código era SATURNO-418.', 'SATURNO-418').pass, true);
});

test('percentiles use nearest-rank and summaries retain all failed-call latency samples', () => {
  assert.equal(percentile([1, 100, 2, 3], 0.5), 2);
  const summary = summarizeBenchmark(['omniroute'], [
    { profile: 'omniroute', kind: 'evaluation', success: true, totalMs: 10, ttftMs: 5, deltaCount: 2, category: 'code', quality: { pass: true } },
    { profile: 'omniroute', kind: 'evaluation', success: false, totalMs: 200, errorCategory: 'TIMEOUT', category: 'code' },
  ])[0];
  assert.equal(summary.attempts, 2);
  assert.equal(summary.totalMs.max, 200);
  assert.equal(summary.timeouts, 1);
  assert.deepEqual(summary.qualityByCategory.code, { pass: 1, fail: 0, notEvaluated: 1 });
});

test('profile config requires an explicitly available model and never embeds credentials in public config', () => {
  const blocked = resolveBenchmarkConfig('gemini', { GEMINI_API_KEY: 'sentinel-secret' });
  assert.equal(blocked.blockedReason, 'MODEL_NOT_CONFIGURED');
  const ready = resolveBenchmarkConfig('omniroute', { AI_API_KEY: 'sentinel-secret', AI_BASE_URL: 'http://localhost:20128/v1', AI_MODEL: 'auto' });
  assert.equal(ready.model, 'auto');
  assert.equal(ready.baseHost, 'localhost:20128');
  assert.equal('apiKey' in ready, true);
  assert.equal(JSON.stringify(redactRecord({ ...ready, model: ready.model })).includes('sentinel-secret'), false);
});

test('safe record projection drops secret-like fields recursively', () => {
  const safe = redactRecord({ model: 'auto/best-free', apiKey: 'secret', nested: { authorization: 'secret', status: 200 } });
  assert.deepEqual(safe, { model: 'auto/best-free', nested: { status: 200 } });
});
