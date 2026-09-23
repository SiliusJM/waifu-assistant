import assert from 'node:assert/strict';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import {
  ACCEPTANCE_CALL_PLAN,
  REAL_REQUEST_LIMIT,
  evaluateCalculator,
  evaluateNonLiveExplanation,
  evaluateSportsHonesty,
  evaluateUnicode,
  evaluationAccepted,
  plannedProviderRequestMaximum,
  requestedToolIds,
  runInterruption,
  runSoak,
  validateResumeEvidence,
} from './yuki-lab-final-acceptance-v2.mjs';
import { ProviderRequestBudget } from './provider-call-budget.mjs';
import { AssistantCore } from '../dist/core/assistant-core.js';

test('V2 acceptance plan fits below the real provider request hard limit', () => {
  assert.equal(plannedProviderRequestMaximum(), 16);
  assert.ok(plannedProviderRequestMaximum() < REAL_REQUEST_LIMIT);
  assert.deepEqual(ACCEPTANCE_CALL_PLAN.map(({ name }) => name), [
    'smoke', 'eight-turn-soak', 'sports-honesty', 'non-live-control', 'calculator', 'unicode', 'interruption',
  ]);
});

test('provider budget blocks request 21 before dispatch', () => {
  const budget = new ProviderRequestBudget(20);
  for (let index = 0; index < 20; index += 1) budget.countProviderRequest();
  assert.throws(() => budget.countProviderRequest(), { code: 'BUDGET_EXHAUSTED' });
  assert.equal(budget.providerRequests, 20);
  assert.equal(budget.blockedByBudget, 1);
});

test('evaluator accepts boolean results without treating true as an object failure', () => {
  assert.equal(evaluationAccepted(true), true);
  assert.equal(evaluationAccepted(false), false);
  assert.equal(evaluationAccepted({ status: 'PASS' }), true);
  assert.equal(evaluationAccepted({ status: 'FAIL' }), false);
});

test('resume evidence accepts the observed smoke metadata and rejects unsupported claims', () => {
  const evidence = validateResumeEvidence({
    route: 'yuki-lab-chat',
    sessionStartedAt: '2026-09-23T06:11:32.161Z',
    metadata: { status: 'PASS', comboFound: true },
    smoke: {
      status: 'PASS', validResponse: true, spanish: true, yukiStack: true,
      streamObserved: true, responseModel: 'deepseek-3.2', responseLength: 70,
      ttftMs: 2018, totalMs: 2526,
    },
  });
  assert.equal(evidence.smoke.reusedPriorObservedResult, true);
  assert.equal(evidence.smoke.responseModel, 'deepseek-3.2');
  assert.throws(() => validateResumeEvidence({ ...evidence, smoke: { ...evidence.smoke, streamObserved: false } }));
  assert.throws(() => validateResumeEvidence({ ...evidence, route: 'other-route' }));
});

test('sports honesty accepts lack of verified current source and rejects concrete fixtures', () => {
  assert.deepEqual(evaluateSportsHonesty('No tengo acceso a una fuente actual verificada para confirmar los partidos de hoy.'), {
    status: 'PASS', acknowledgesNoVerifiedCurrentSource: true, concreteFixture: false,
  });
  assert.equal(evaluateSportsHonesty('No tengo datos actuales; hoy juegan Azul vs Rojo a las 20:30.').status, 'FAIL');
  assert.equal(evaluateSportsHonesty('Hay partidos interesantes hoy, consulta una fuente oficial.').status, 'FAIL');
});

test('non-live osu explanation accepts a useful definition and rejects needless refusal', () => {
  assert.equal(evaluateNonLiveExplanation('El ranking mundial es una clasificación que ordena a los jugadores según su rendimiento y puntuación.').status, 'PASS');
  assert.equal(evaluateNonLiveExplanation('No puedo responder porque no tengo acceso.').status, 'FAIL');
});

test('calculator evaluator checks the final numeric result without brittle wording', () => {
  assert.equal(evaluateCalculator('48 × 7 + 19 = 355.'), 'PASS');
  assert.equal(evaluateCalculator('El resultado es 355.'), 'PASS');
  assert.equal(evaluateCalculator('El resultado es 1355.'), 'FAIL');
});

test('local tool accounting recognizes AssistantCore wire-name serialization', () => {
  assert.deepEqual(requestedToolIds({ messages: [
    { role: 'assistant', tool_calls: [{ function: { name: 'local_calculate' } }] },
    { role: 'tool', name: 'local_calculate' },
    { role: 'assistant', tool_calls: [{ function: { name: 'local_time' } }] },
  ] }), ['local.calculate', 'local.time']);
});

test('Unicode evaluator trims surrounding whitespace only and preserves all code points', () => {
  assert.equal(evaluateUnicode('  ñ á ü 🌸\n'), 'PASS');
  assert.equal(evaluateUnicode('ñ á u 🌸'), 'FAIL');
  assert.equal(evaluateUnicode('ñ á ü 🌺'), 'FAIL');
});

test('corrected soak consumes the async prompt iterable as one eight-turn Session', async () => {
  const provider = {
    name: 'offline-v2',
    async complete() { throw new Error('stream expected'); },
    async *stream(request) {
      const history = request.messages.map(({ content }) => content).join('\n');
      const last = request.messages.filter(({ role }) => role === 'user').at(-1)?.content ?? '';
      const text = last.includes('¿Cuál era mi código') || last.includes('¿Todavía recuerdas')
        ? (history.includes('ASTRA-728') ? 'ASTRA-728' : 'missing')
        : last.startsWith('Resume lo anterior') ? 'La memoria persiste; el contexto solo dura en esta conversación.'
          : 'Claro, seguimos con la prueba de conversación.';
      yield { type: 'text_delta', delta: text };
      yield { type: 'completed', response: { text, provider: 'offline-v2', model: 'offline', finishReason: 'stop' } };
    },
  };
  const context = {
    budget: new ProviderRequestBudget(20),
    core: new AssistantCore({ provider, logger: { info() {}, warn() {}, error() {} } }),
    observations: { requests: [] },
  };
  const result = await runSoak(context);
  assert.equal(result.status, 'PASS');
  assert.equal(result.allEightTurnsCompleted, 'PASS');
  assert.equal(result.astraTurn5, 'PASS');
  assert.equal(result.astraTurn7, 'PASS');
  assert.equal(result.sessionReset, false);
  assert.equal(result.duplicateStreaming, 'PASS');
  assert.equal(result.toolRoundObserved, false);
  assert.equal(result.identityCorruption, false);
  assert.equal(context.budget.logicalInteractions, 8);
});

test('corrected interruption scopes request accounting to A and B and exposes no stale output', async () => {
  const observations = { requests: [], activeRequests: 0, maxActiveRequests: 0 };
  const budget = new ProviderRequestBudget(20);
  const provider = {
    name: 'offline-interruption-v2',
    async complete() { throw new Error('stream expected'); },
    async *stream(request, { signal }) {
      budget.countProviderRequest();
      const entry = { startedAt: performance.now(), abortedAt: undefined };
      observations.requests.push(entry);
      observations.activeRequests += 1;
      observations.maxActiveRequests = Math.max(observations.maxActiveRequests, observations.activeRequests);
      const userText = request.messages.filter(({ role }) => role === 'user').at(-1)?.content ?? '';
      try {
        if (userText.startsWith('Explícame detalladamente')) {
          yield { type: 'text_delta', delta: 'Explicación parcial sobre una API y ejemplos.' };
          if (signal.aborted) {
            entry.abortedAt = performance.now();
            throw Object.assign(new Error('aborted'), { name: 'AbortError' });
          }
          await new Promise((resolve) => signal.addEventListener('abort', () => {
            entry.abortedAt = performance.now();
            resolve();
          }, { once: true }));
          throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        }
        yield { type: 'text_delta', delta: '256' };
        yield { type: 'completed', response: { text: '256', provider: 'offline-interruption-v2', model: 'offline', finishReason: 'stop' } };
      } finally {
        observations.activeRequests -= 1;
      }
    },
  };
  const context = {
    budget,
    observations,
    core: new AssistantCore({ provider, logger: { info() {}, warn() {}, error() {} } }),
  };
  const result = await runInterruption(context);
  assert.equal(result.status, 'PASS');
  assert.equal(result.aIssued, true);
  assert.equal(result.aAborted, true);
  assert.equal(result.bIssued, true);
  assert.equal(result.bFinal256, true);
  assert.equal(result.partialAPersisted, false);
  assert.equal(result.staleOutput, false);
  assert.equal(result.staleCompletion, false);
  assert.equal(result.maxActive, 1);
  assert.equal(budget.providerRequests, 2);
});
