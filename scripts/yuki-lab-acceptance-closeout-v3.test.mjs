import assert from 'node:assert/strict';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import {
  MAX_PROVIDER_REQUESTS,
  acceptanceDecision,
  classifyInterruptionResponse,
  classifyNonLive,
  classifyUnicode,
  evaluateInterruptionWindow,
  evaluateStreamingRounds,
  runInterruption,
} from './yuki-lab-acceptance-closeout-v3.mjs';
import { ProviderRequestBudget } from './provider-call-budget.mjs';
import { evaluationAccepted, requestedToolIds } from './yuki-lab-final-acceptance-v2.mjs';
import { AssistantCore } from '../dist/core/assistant-core.js';

test('V3 provider request budget hard-blocks request 13 before dispatch', () => {
  const budget = new ProviderRequestBudget(MAX_PROVIDER_REQUESTS);
  for (let index = 0; index < MAX_PROVIDER_REQUESTS; index += 1) budget.countProviderRequest();
  assert.throws(() => budget.countProviderRequest(), { code: 'BUDGET_EXHAUSTED' });
  assert.equal(budget.providerRequests, 12);
  assert.equal(budget.blockedByBudget, 1);
});

test('non-live semantic classifier separates a valid answer, minor model behavior and evaluator failure', () => {
  const soundRequest = { promptMatches: true, policyPresent: true, sessionContaminated: false, prompt: 'Explícame qué significa el ranking mundial en osu!.' };
  assert.equal(classifyNonLive('El ranking mundial ordena a los jugadores de osu! según su rendimiento y puntuación.', soundRequest), 'PASS');
  assert.equal(classifyNonLive('Te refieres a osu!, el juego de ritmo, ¿cierto?', soundRequest), 'MINOR_MODEL_OVER_REFUSAL');
  assert.equal(classifyNonLive('Bitcoin es un activo digital descentralizado que permite transferencias entre usuarios.', { ...soundRequest, prompt: 'Explícame qué es Bitcoin.' }), 'PASS');
  assert.equal(classifyNonLive('El ranking ordena jugadores según rendimiento.', { ...soundRequest, policyPresent: false }), 'EVALUATOR_FAILURE');
});

test('Unicode classifier preserves exact code points and distinguishes transport corruption', () => {
  assert.equal(classifyUnicode(' \nñ á ü 🌸\t'), 'PASS');
  assert.equal(classifyUnicode('ñ  á ü 🌸'), 'MINOR_MODEL_INSTRUCTION_FAILURE');
  assert.equal(classifyUnicode('Ñ á ü 🌸'), 'MINOR_MODEL_INSTRUCTION_FAILURE');
  assert.equal(classifyUnicode('Ã± Ã¡ Ã¼ ðŸŒ¸'), 'UTF8_TRANSPORT_FAILURE');
});

test('stream evaluator passes a single streamed assistant round', () => {
  assert.equal(evaluateStreamingRounds({
    rounds: [{ requestId: 'r1', kind: 'final', deltas: ['Hola ', 'Yuki'], text: 'Hola Yuki' }],
    finalText: 'Hola Yuki',
  }), 'PASS');
});

test('stream evaluator excludes tool-call round content and attributes final assistant round', () => {
  assert.equal(evaluateStreamingRounds({
    rounds: [
      { requestId: 'r1', kind: 'tool', deltas: [], text: '' },
      { requestId: 'r2', kind: 'final', deltas: ['La respuesta ', 'final'], text: 'La respuesta final' },
    ],
    finalText: 'La respuesta final',
  }), 'PASS');
});

test('stream evaluator identifies a buffered response rather than claiming streaming', () => {
  assert.equal(evaluateStreamingRounds({
    rounds: [{ requestId: 'r1', kind: 'final', deltas: [], text: 'Respuesta completa' }],
    finalText: 'Respuesta completa',
  }), 'BUFFERED');
});

test('stream evaluator attributes multiple rounds to distinct request windows', () => {
  assert.equal(evaluateStreamingRounds({
    rounds: [
      { requestId: 'tool-1', kind: 'tool', deltas: ['ignored tool marker'], text: '' },
      { requestId: 'tool-2', kind: 'tool', deltas: [], text: '' },
      { requestId: 'final-3', kind: 'final', deltas: ['Astra ', 'found'], text: 'Astra found' },
    ],
    finalText: 'Astra found',
  }), 'PASS');
  assert.equal(evaluateStreamingRounds({
    rounds: [
      { requestId: 'same', kind: 'tool', deltas: [], text: '' },
      { requestId: 'same', kind: 'final', deltas: ['x'], text: 'x' },
    ], finalText: 'x',
  }), 'NOT_VERIFIED');
});

test('interruption evaluator ignores historical events and scopes stale output to this request window', () => {
  const events = [
    { interactionId: 'old', type: 'request-start', requestId: 'old-A', at: 1 },
    { interactionId: 'old', type: 'delta', requestId: 'old-A', at: 2, text: 'stale historical' },
    { interactionId: 'current', type: 'request-start', requestId: 'A', at: 10 },
    { interactionId: 'current', type: 'request-abort', requestId: 'A', at: 12 },
    { interactionId: 'current', type: 'request-start', requestId: 'B', at: 13 },
    { interactionId: 'current', type: 'response', requestId: 'B', at: 20, text: '256' },
  ];
  const result = evaluateInterruptionWindow({
    interactionId: 'current', events, requestAId: 'A', requestBId: 'B', bOwnershipAt: 11,
    assistantMessages: [{ requestId: 'B', content: '256' }], maxActive: 1,
  });
  assert.equal(result.status, 'PASS');
  assert.equal(result.staleDelta, false);
  assert.equal(result.staleCompletion, false);
});

test('interruption evaluator reports stale A output only after B ownership', () => {
  const result = evaluateInterruptionWindow({
    interactionId: 'i',
    events: [
      { interactionId: 'i', type: 'request-start', requestId: 'A' },
      { interactionId: 'i', type: 'request-abort', requestId: 'A' },
      { interactionId: 'i', type: 'request-start', requestId: 'B' },
      { interactionId: 'i', type: 'delta', requestId: 'A', at: 15, text: 'late' },
      { interactionId: 'i', type: 'response', requestId: 'B', at: 20, text: '256' },
    ],
    requestAId: 'A', requestBId: 'B', bOwnershipAt: 10,
    assistantMessages: [{ requestId: 'B', content: '256' }], maxActive: 1,
  });
  assert.equal(result.status, 'FAIL');
  assert.equal(result.staleDelta, true);
});

test('interruption semantic classifier distinguishes exact, correct-with-extra, wrong-value and wrong-task answers', () => {
  assert.equal(classifyInterruptionResponse(' 256 \n'), 'FUNCTIONAL_PASS_EXACT');
  assert.equal(classifyInterruptionResponse('La respuesta es 256.'), 'FUNCTIONAL_PASS_WITH_EXTRA_TEXT');
  assert.equal(classifyInterruptionResponse('257'), 'FUNCTIONAL_FAIL_WRONG_ANSWER');
  assert.equal(classifyInterruptionResponse('La respuesta es doscientos cincuenta y seis.'), 'FUNCTIONAL_FAIL_WRONG_TASK');
  assert.equal(classifyInterruptionResponse('1256'), 'FUNCTIONAL_FAIL_WRONG_ANSWER');
  assert.equal(classifyInterruptionResponse(''), 'FLOW_FAIL');
});

test('interruption window accepts the correct semantic answer without requiring exact-only output', () => {
  const result = evaluateInterruptionWindow({
    interactionId: 'semantic',
    events: [
      { interactionId: 'semantic', type: 'request-start', requestId: 'A', at: 1 },
      { interactionId: 'semantic', type: 'request-abort', requestId: 'A', at: 2 },
      { interactionId: 'semantic', type: 'request-start', requestId: 'B', at: 3 },
      { interactionId: 'semantic', type: 'response', requestId: 'B', at: 4, text: 'La respuesta es 256.' },
    ],
    requestAId: 'A', requestBId: 'B', bOwnershipAt: 2.5,
    assistantMessages: [{ requestId: 'B', content: 'La respuesta es 256.' }], maxActive: 1, allowExtraText: true,
  });
  assert.equal(result.status, 'PASS');
  assert.equal(result.bCompleted, true);
  assert.equal(result.bFinalExpected, false);
  assert.equal(result.bSemanticAnswer, true);
  assert.equal(result.classification, 'FUNCTIONAL_PASS_WITH_EXTRA_TEXT');
});

test('interruption lifecycle does not mistake intentional A abort for a provider error that skips B', async () => {
  const context = {
    budget: new ProviderRequestBudget(12), requests: [], events: [], active: new Set(),
    maxActiveRequests: 0, interruptionTimeoutMs: 500,
    responseModels: new Set(), models: new Set(),
    errors: { http4xx: 0, http5xx: 0, timeout: 0, transport: 0, aborted: 0 },
  };
  let nextRequest = 0;
  const provider = {
    name: 'offline-interruption-v3',
    async complete() { throw new Error('stream expected'); },
    async *stream(request, { signal }) {
      const userMessages = request.messages.filter(({ role }) => role === 'user').map(({ content }) => content);
      const requestRecord = {
        id: `fake-${++nextRequest}`, startedAt: performance.now(), abortedAt: undefined,
        userText: userMessages.at(-1), userMessages,
      };
      context.budget.countProviderRequest();
      context.requests.push(requestRecord);
      context.active.add(requestRecord.id);
      context.maxActiveRequests = Math.max(context.maxActiveRequests, context.active.size);
      const userText = request.messages.filter(({ role }) => role === 'user').at(-1)?.content ?? '';
      try {
        if (userText.startsWith('Explícame detalladamente')) {
          yield { type: 'text_delta', delta: 'Explicación parcial suficientemente larga de una API.' };
          await new Promise((resolve) => {
            if (signal.aborted) resolve();
            else signal.addEventListener('abort', resolve, { once: true });
          });
          requestRecord.abortedAt = performance.now();
          throw Object.assign(new Error('intentional abort'), { name: 'AbortError' });
        }
        yield { type: 'text_delta', delta: '256' };
        yield { type: 'completed', response: { text: '256', provider: 'offline-interruption-v3', model: 'offline', finishReason: 'stop' } };
      } finally {
        context.active.delete(requestRecord.id);
      }
    },
  };
  context.core = new AssistantCore({ provider, logger: { info() {}, warn() {}, error() {} } });
  const secondPrompt = 'Detente. ¿Cuánto es 128 + 128? Responde brevemente.';
  const result = await runInterruption(context, '256', { secondPrompt, allowExtraText: true });
  assert.equal(result.aIssued, true);
  assert.equal(result.aAborted, true);
  assert.equal(result.bIssued, true);
  assert.equal(result.bFinal256, true, JSON.stringify(result));
  assert.equal(result.bCompleted, true);
  assert.equal(result.bPromptCorrect, true);
  assert.equal(result.bHistoryContainsA, true);
  assert.equal(result.functionalClassification, 'FUNCTIONAL_PASS_EXACT');
  assert.equal(result.safeBResponse, '256');
  assert.equal(result.staleDelta, false);
  assert.equal(result.staleCompletion, false);
  assert.equal(result.maxActive, 1);
  assert.equal(result.status, 'PASS');
  assert.equal(result.error, undefined);
  assert.equal(context.budget.providerRequests, 2);
});

test('acceptance allows isolated minor quirks but requires a clean interruption and transport', () => {
  assert.equal(acceptanceDecision({
    nonLiveOsu: { status: 'MINOR_MODEL_OVER_REFUSAL' }, nonLiveBitcoin: { status: 'PASS' },
    unicode: { classification: 'MINOR_MODEL_INSTRUCTION_FAILURE' }, interruption: { status: 'PASS' },
    errors: { http4xx: 0, http5xx: 0, timeout: 0, transport: 0 },
  }).verdict, 'PASS');
  assert.equal(acceptanceDecision({
    nonLiveOsu: { status: 'PASS' }, unicode: { classification: 'PASS' },
    interruption: { status: 'NOT_VERIFIED' }, errors: { http4xx: 0, http5xx: 0, timeout: 0, transport: 0 },
  }).verdict, 'PARTIAL');
});

test('V2 smoke boolean and tool-name regressions remain covered', () => {
  assert.equal(evaluationAccepted(true), true);
  assert.deepEqual(requestedToolIds({ messages: [
    { role: 'assistant', tool_calls: [{ function: { name: 'local_calculate' } }] },
  ] }), ['local.calculate']);
});
