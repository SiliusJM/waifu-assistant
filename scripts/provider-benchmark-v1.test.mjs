import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluateScenario,
  allowedRateLimitHeaders,
  boundedRateLimitCooldownMs,
  loadScenarioSet,
  planMissingEvaluations,
  validEvaluationKeys,
  parseRetryAfterMs,
  parseBenchmarkArgs,
  providerPacingDelayMs,
  providerPacingIntervalMs,
  percentile,
  observeRateLimitOutcome,
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
  assert.equal(evaluateScenario(['answersCapabilityRequest'], 'Puedo organizar tareas y responder preguntas.').pass, true);
  assert.equal(evaluateScenario(['answersCapabilityRequest'], 'Organizo tareas, explico conceptos y te ayudo a planificar.').pass, true);
  assert.equal(evaluateScenario(['answersCapabilityRequest'], 'Te ayudo con tareas, recordatorios y consultas.').pass, true);
  assert.equal(evaluateScenario(['answersCapabilityRequest'], '¡Hola! ¿En qué puedo ayudarte hoy?').pass, false);
  assert.equal(evaluateScenario(['answersCapabilityRequest'], 'Espero que estés bien.').pass, false);
});

test('Groq and Gemini pacing intervals are optional/configurable and Retry-After supports seconds and HTTP dates', () => {
  assert.equal(providerPacingDelayMs(7_000, 5_000), 2_000);
  assert.equal(providerPacingIntervalMs('gemini', '7000'), 7_000);
  assert.equal(providerPacingIntervalMs('gemini', undefined), 0);
  assert.equal(providerPacingIntervalMs('groq', '9000'), 9_000);
  assert.equal(providerPacingIntervalMs('omniroute', 'invalid'), 0);
  assert.throws(() => providerPacingIntervalMs('groq', 'invalid'));
  assert.throws(() => providerPacingIntervalMs('gemini', 'invalid'));
  assert.equal(parseRetryAfterMs('2', 1_000), 2_000);
  assert.equal(parseRetryAfterMs(new Date(6_000).toUTCString(), 1_000), 5_000);
});

test('supplemental mode requires an output directory and excludes OmniRoute', () => {
  const args = parseBenchmarkArgs(['--profiles', 'groq,gemini', '--output', 'D:\\temp\\supplement', '--supplemental-from', 'D:\\temp\\source\\raw-results.json']);
  assert.equal(args.supplementalFrom, 'D:\\temp\\source\\raw-results.json');
  assert.throws(() => parseBenchmarkArgs(['--profiles', 'omniroute,groq', '--output', 'D:\\temp\\supplement', '--supplemental-from', 'D:\\temp\\source\\raw-results.json']), /cannot include/u);
  assert.throws(() => parseBenchmarkArgs(['--profiles', 'groq,gemini', '--supplemental-from', 'D:\\temp\\source\\raw-results.json']), /requires --output/u);
});

test('rate-limit header capture is allowlisted and excludes credentials/cookies', () => {
  const captured = allowedRateLimitHeaders(new Headers({
    'retry-after': '12',
    'x-ratelimit-request-remaining': '3',
    authorization: 'Bearer sentinel-secret',
    'set-cookie': 'sid=secret',
    'content-type': 'text/event-stream',
  }).entries());
  assert.deepEqual(captured, { 'retry-after': '12', 'x-ratelimit-request-remaining': '3' });
  assert.equal(JSON.stringify(captured).includes('sentinel-secret'), false);
});

test('429 pauses only after two consecutive limits and cooldown honors a safe maximum', () => {
  const state = { rateLimitCount: 0, consecutiveRateLimits: 0 };
  assert.equal(observeRateLimitOutcome(state, 'HTTP_429').shouldPause, false);
  assert.equal(observeRateLimitOutcome(state, 'HTTP_429').shouldPause, true);
  assert.equal(observeRateLimitOutcome(state, 'HTTP_5XX').consecutiveRateLimits, 0);
  assert.equal(observeRateLimitOutcome(state, 'HTTP_429').shouldPause, false);
  assert.equal(boundedRateLimitCooldownMs(16000, 120000), 16000);
  assert.equal(boundedRateLimitCooldownMs(undefined, 120000), 120000);
  assert.equal(boundedRateLimitCooldownMs(900001, 120000), undefined);
});

test('supplement planner reuses valid tasks and schedules only the missing 28 Groq and 14 Gemini evaluations', async () => {
  const scenarios = await loadScenarioSet(scenariosPath);
  const allGroq = planMissingEvaluations(scenarios, [], ['groq']);
  const allGemini = planMissingEvaluations(scenarios, [], ['gemini']);
  const existing = [
    ...allGroq.slice(0, 2).map((task) => ({ ...task, kind: 'evaluation', success: true, quality: { pass: true } })),
    ...allGemini.slice(0, 16).map((task) => ({ ...task, kind: 'evaluation', success: true, quality: { pass: true } })),
  ];
  assert.equal(validEvaluationKeys(existing, 'groq').size, 2);
  assert.equal(validEvaluationKeys(existing, 'gemini').size, 16);
  const pending = planMissingEvaluations(scenarios, existing, ['groq', 'gemini']);
  assert.equal(pending.filter(({ profile }) => profile === 'groq').length, 28);
  assert.equal(pending.filter(({ profile }) => profile === 'gemini').length, 14);
  assert.equal(pending.some(({ profile }) => profile === 'omniroute'), false);
  assert.deepEqual(pending.slice(0, 4).map(({ profile }) => profile), ['groq', 'gemini', 'groq', 'gemini']);
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
