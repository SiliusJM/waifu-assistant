import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_PROVIDER_INFERENCE_REQUESTS,
  MAX_TOTAL_INFERENCE_REQUESTS,
  assertSafeReport,
  classifyProviderFailure,
  classifyToolCapability,
  classifyToolRun,
  discoverProviderModels,
  explicitFreeEvidence,
  readProviderConfig,
  runCompatibilityMatrix,
  runProviderValidation,
  selectCandidate,
} from './direct-provider-compatibility-matrix-v1.mjs';
import { ProviderRequestBudget } from './provider-call-budget.mjs';

const zeroPriceModel = (id) => ({
  id,
  pricing: { prompt: '0', completion: '0' },
  architecture: { input_modalities: ['text'], output_modalities: ['text'] },
});

function baseEnv(provider = 'openrouter') {
  const definitions = {
    groq: ['GROQ_API_KEY', 'GROQ_BASE_URL', 'https://api.groq.com/openai/v1'],
    gemini: ['GEMINI_API_KEY', 'GEMINI_BASE_URL', 'https://generativelanguage.googleapis.com/v1beta/openai'],
    openrouter: ['OPENROUTER_API_KEY', 'OPENROUTER_BASE_URL', 'https://openrouter.ai/api/v1'],
  };
  const [keyName, urlName, url] = definitions[provider];
  return { [keyName]: 'offline-secret-never-reported', [urlName]: url };
}

function eventChunk({ content, toolCall, finishReason, model = 'upstream/public-model' }) {
  const delta = {};
  if (content !== undefined) delta.content = content;
  if (toolCall) delta.tool_calls = [toolCall];
  const choice = { delta, finish_reason: finishReason ?? null };
  return `data: ${JSON.stringify({ model, choices: [choice] })}\n\n`;
}

function sseResponse({ content = '', holdUntilAbort = false, holdOpenAfterDone = false, toolCall, signal }) {
  const encoder = new TextEncoder();
  const chunks = toolCall
    ? [eventChunk({ toolCall }), eventChunk({ finishReason: 'tool_calls' }), 'data: [DONE]\n\n']
    : [eventChunk({ content }), eventChunk({ finishReason: 'stop' }), 'data: [DONE]\n\n'];
  let index = 0;
  let controllerRef;
  let abortListener;
  const stream = new ReadableStream({
    start(controller) {
      controllerRef = controller;
      controller.enqueue(encoder.encode(chunks[index++]));
      if (holdUntilAbort) {
        abortListener = () => {
          try { controller.close(); } catch { /* stream already cancelled */ }
        };
        signal?.addEventListener('abort', abortListener, { once: true });
      }
    },
    pull(controller) {
      if (holdUntilAbort) return;
      if (index < chunks.length) controller.enqueue(encoder.encode(chunks[index++]));
      else if (!holdOpenAfterDone) controller.close();
    },
    cancel() {
      if (abortListener) signal?.removeEventListener('abort', abortListener);
      controllerRef = undefined;
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

test('provider configuration is isolated and never projects credentials', () => {
  const env = { ...baseEnv('groq'), GROQ_TEST_MODEL: 'public-model-v2' };
  const config = readProviderConfig('groq', env);
  assert.equal(config.configured, true);
  assert.equal(config.baseURLMatches, true);
  assert.equal(config.modelOverride, 'public-model-v2');
  assert.equal(Object.hasOwn(config, 'apiKey'), true);
  assert.equal(JSON.stringify({ ...config, apiKey: undefined }).includes(env.GROQ_API_KEY), false);
  assert.equal(readProviderConfig('gemini', env).configured, false);
  assert.equal(readProviderConfig('openrouter', env).configured, false);
});

test('base URL mismatch and URL credentials are rejected before requests', () => {
  assert.equal(readProviderConfig('groq', { ...baseEnv('groq'), GROQ_BASE_URL: 'https://example.test/v1' }).baseURLMatches, false);
  assert.equal(readProviderConfig('groq', {
    ...baseEnv('groq'), GROQ_BASE_URL: 'https://user:password@api.groq.com/openai/v1',
  }).baseURLMatches, false);
  assert.equal(readProviderConfig('groq', {
    ...baseEnv('groq'), GROQ_BASE_URL: 'https://api.groq.com/openai/v1?token=unsafe',
  }).baseURLMatches, false);
});

test('malformed override is not silently replaced by automatic selection', () => {
  const config = readProviderConfig('groq', { ...baseEnv('groq'), GROQ_TEST_MODEL: 'bad model id' });
  assert.equal(config.overrideConfigured, true);
  assert.equal(config.overrideInvalid, true);
  assert.equal(config.modelOverride, undefined);
});

test('free-only selection supports catalog churn and zero-price evidence', () => {
  assert.equal(explicitFreeEvidence(zeroPriceModel('provider/new-free-v2')), true);
  const selection = selectCandidate('groq', [
    { id: 'provider/retired', deprecated: true, pricing: { prompt: '0', completion: '0' } },
    zeroPriceModel('provider/new-free-v2'),
  ]);
  assert.equal(selection.selectedModel, 'provider/new-free-v2');
  assert.equal(selection.selectionSource, 'AUTO');
});

test('overrides require a listed, eligible, explicitly free model', () => {
  assert.equal(selectCandidate('gemini', [zeroPriceModel('flash-free-v2')], 'flash-free-v2').status, 'SELECTED');
  assert.equal(selectCandidate('gemini', [zeroPriceModel('flash-free-v2')], 'missing-model').status, 'MODEL_UNAVAILABLE');
  assert.equal(selectCandidate('gemini', [{ id: 'flash-unknown-price' }], 'flash-unknown-price').status, 'INCONCLUSIVE');
  assert.equal(selectCandidate('gemini', [{ id: 'flash-priced', pricing: { prompt: '0.01', completion: '0.02' } }], 'flash-priced').status, 'PAID_ONLY_OR_NOT_FREE');
});

test('model discovery filters to safe catalog fields and counts metadata separately', async () => {
  const budget = new ProviderRequestBudget(10);
  const config = readProviderConfig('groq', baseEnv('groq'));
  let requested;
  const result = await discoverProviderModels(config, {
    budget,
    fetchImpl: async (url, init) => {
      requested = { url, authorization: init.headers.authorization };
      return Response.json({ data: [{ ...zeroPriceModel('provider/model-a'), owner_email: 'private@example.test', api_key: 'must-not-escape' }] });
    },
  });
  assert.equal(result.status, 'PASS');
  assert.equal(result.metadataRequests, 1);
  assert.equal(budget.metadataRequests, 1);
  assert.equal(budget.providerRequests, 0);
  assert.equal(requested.url, 'https://api.groq.com/openai/v1/models');
  assert.equal(requested.authorization, 'Bearer offline-secret-never-reported');
  assert.deepEqual(Object.keys(result.models[0]).sort(), ['architecture', 'id', 'pricing']);
  assert.equal(JSON.stringify(result).includes('offline-secret-never-reported'), false);
  assert.equal(JSON.stringify(result).includes('private@example.test'), false);
});

test('missing free-price evidence is INCONCLUSIVE, not falsely called paid', () => {
  assert.equal(selectCandidate('groq', [{ id: 'visible-chat-model' }]).status, 'INCONCLUSIVE');
  assert.equal(selectCandidate('groq', [{ id: 'visible-paid-model', pricing: { prompt: '0.1', completion: '0.2' } }]).status, 'PAID_ONLY_OR_NOT_FREE');
});

test('OpenRouter free router is the only permitted discovery fallback', () => {
  const selection = selectCandidate('openrouter', [zeroPriceModel('ordinary/free-catalog-model')]);
  assert.equal(selection.status, 'SELECTED');
  assert.equal(selection.selectedModel, 'openrouter/free');
  assert.equal(selection.freeEvidence, 'OPENROUTER_FREE_ROUTER');
  assert.equal(selectCandidate('openrouter', [], 'openrouter/free').status, 'SELECTED');
});

test('deprecated models are skipped and overrides do not silently churn', () => {
  const result = selectCandidate('gemini', [
    { ...zeroPriceModel('old-free'), deprecated: true }, zeroPriceModel('new-free'),
  ]);
  assert.equal(result.selectedModel, 'new-free');
  assert.equal(selectCandidate('gemini', [{ ...zeroPriceModel('old-free'), deprecated: true }], 'old-free').status, 'MODEL_UNAVAILABLE');
});

test('failure taxonomy separates auth, billing, free quota, rate, model and protocol', () => {
  assert.equal(classifyProviderFailure({ statusCode: 401 }), 'AUTH_FAILURE');
  assert.equal(classifyProviderFailure({ statusCode: 402 }), 'PAID_ONLY_OR_NOT_FREE');
  assert.equal(classifyProviderFailure({ statusCode: 429, detail: 'free quota exhausted' }), 'FREE_QUOTA_EXHAUSTED');
  assert.equal(classifyProviderFailure({ statusCode: 429 }), 'RATE_LIMITED');
  assert.equal(classifyProviderFailure({ statusCode: 404 }), 'MODEL_UNAVAILABLE');
  assert.equal(classifyProviderFailure({ code: 'INVALID_RESPONSE_ERROR' }), 'PROTOCOL_INCOMPATIBLE');
  assert.equal(classifyProviderFailure({ code: 'TIMEOUT_ERROR' }), 'TRANSPORT_LIMITATION');
});

test('tool capability requires emitted call, local execution and provider second round', () => {
  assert.equal(classifyToolCapability({ toolDefinitionSent: true, toolCallEmitted: true, localToolExecuted: true, secondRound: true, finalAnswer: true }), 'PASS');
  assert.equal(classifyToolCapability({ toolDefinitionSent: true, toolCallEmitted: false, localToolExecuted: false, secondRound: false, finalAnswer: true }), 'NOT_VERIFIED');
  assert.equal(classifyToolCapability({ toolDefinitionSent: true, toolCallEmitted: false, localToolExecuted: false, secondRound: false, finalAnswer: false }), 'MODEL_UNSUPPORTED_CAPABILITY');
  assert.equal(classifyToolRun({ requestFailed: true, failureClass: 'PROTOCOL_INCOMPATIBLE', toolDefinitionSent: true }), 'NOT_VERIFIED');
  assert.equal(classifyToolRun({ requestFailed: true, failureClass: 'MODEL_UNSUPPORTED_CAPABILITY' }), 'MODEL_UNSUPPORTED_CAPABILITY');
});

test('request budgets count inference separately and enforce hard maxima', () => {
  assert.equal(MAX_TOTAL_INFERENCE_REQUESTS, 30);
  assert.equal(MAX_PROVIDER_INFERENCE_REQUESTS, 10);
  const budget = new ProviderRequestBudget(2);
  budget.countMetadataRequest();
  budget.countProviderRequest();
  budget.countProviderRequest({ kind: 'tool-second-round' });
  assert.equal(budget.metadataRequests, 1);
  assert.equal(budget.providerRequests, 2);
  assert.equal(budget.toolSecondRoundRequests, 1);
  assert.equal(budget.canReserve(1), false);
});

test('safe report projection rejects known configured credentials without printing them', () => {
  assert.doesNotThrow(() => assertSafeReport({ provider: 'Groq', model: 'public/model' }, baseEnv('groq')));
  assert.throws(
    () => assertSafeReport({ provider: 'Groq', accidental: 'offline-secret-never-reported' }, baseEnv('groq')),
    /Unsafe report projection/u,
  );
});

test('full offline provider flow uses injected transport, records upstream model, tools, cancellation and <=10 calls', async () => {
  const env = { ...baseEnv('openrouter'), OPENROUTER_TEST_MODEL: 'offline/free-model' };
  let calls = 0;
  const fetchImpl = async (input, init = {}) => {
    if (String(input).endsWith('/models')) {
      return Response.json({ data: [zeroPriceModel('offline/free-model')] });
    }
    calls += 1;
    const body = JSON.parse(init.body);
    const last = body.messages.at(-1);
    if (String(last?.content).includes('Usa la calculadora')) {
      const name = body.tools?.find((tool) => tool.function?.name === 'local_calculate')?.function?.name;
      if (!name) return sseResponse({ content: '355', signal: init.signal });
      return sseResponse({ toolCall: {
        index: 0, id: 'call-1', type: 'function', function: { name, arguments: '{"expression":"(27 * 13) + 4"}' },
      }, signal: init.signal });
    }
    if (last?.role === 'tool') return sseResponse({ content: '355', signal: init.signal });
    const prompt = String(last?.content ?? '');
    if (prompt.includes('DIRECT-OK')) return sseResponse({ content: 'DIRECT-OK', holdOpenAfterDone: true, signal: init.signal });
    if (prompt.includes('ñ á ü 🌸')) return sseResponse({ content: 'ñ á ü 🌸', signal: init.signal });
    if (prompt.includes('¿Cuál era mi código temporal?')) return sseResponse({ content: 'NEBULA-731', signal: init.signal });
    if (prompt.includes('Mi código temporal')) return sseResponse({ content: 'Lo recordaré: NEBULA-731.', signal: init.signal });
    if (prompt.includes('¿qué es una API?')) return sseResponse({ content: 'Una API permite que programas se comuniquen.', signal: init.signal });
    if (prompt.includes('precio actual de Bitcoin')) return sseResponse({ content: 'Hola, estoy disponible. No puedo verificar datos actuales para ese precio.', signal: init.signal });
    if (prompt.includes('Explícame con cierto detalle')) return sseResponse({ content: 'Una API organiza solicitudes y respuestas entre programas. '.repeat(2), holdUntilAbort: true, signal: init.signal });
    if (prompt.includes('¿Cuánto es 64 + 64?')) return sseResponse({ content: '128', signal: init.signal });
    return sseResponse({ content: 'Respuesta offline.', signal: init.signal });
  };

  const { report, globalBudget } = await runProviderValidation('openrouter', {
    env, fetchImpl, timeoutMs: 500, interruptionGraceMs: 100,
  });
  assert.equal(report.discovery, 'PASS');
  assert.equal(report.selectedModel, 'offline/free-model');
  assert.equal(report.basicCompletion, 'PASS');
  assert.equal(report.unicode, 'PASS');
  assert.equal(report.context, 'PASS');
  assert.equal(report.fullStackYuki, 'PASS');
  assert.equal(report.currentDataHonesty, 'PASS');
  assert.equal(report.toolCalling, 'PASS', JSON.stringify({ toolCalling: report.toolCalling, inferenceCalls: report.inferenceCalls, errors: report.errors }));
  assert.equal(report.interruption.status, 'PASS', JSON.stringify({ interruption: report.interruption, calls }));
  assert.equal(report.result, 'PROVIDER_COMPATIBLE');
  assert.deepEqual(report.errors, []);
  assert.ok(report.inferenceCalls <= 10);
  assert.equal(report.inferenceCalls, calls);
  assert.equal(globalBudget.providerRequests, calls);
  assert.deepEqual(report.upstreamModels, ['upstream/public-model']);
  assert.equal(report.retries, 0);
  assert.equal(report.freePriceVerified, true);
  assert.equal(JSON.stringify(report).includes('offline-secret-never-reported'), false);
  assert.equal(JSON.stringify(report).includes('Authorization'), false);
});

test('provider auth and catalog failure stop before inference', async () => {
  let inferenceCalls = 0;
  const { report } = await runProviderValidation('groq', {
    env: baseEnv('groq'),
    fetchImpl: async (url) => {
      if (String(url).endsWith('/models')) return new Response('', { status: 401 });
      inferenceCalls += 1;
      return sseResponse({ content: 'should not happen' });
    },
  });
  assert.equal(report.result, 'AUTH_FAILURE');
  assert.equal(report.inferenceCalls, 0);
  assert.equal(inferenceCalls, 0);
});

test('explicitly priced catalog models are skipped in free-only mode', async () => {
  let inferenceCalls = 0;
  const { report } = await runProviderValidation('groq', {
    env: baseEnv('groq'),
    fetchImpl: async (url) => {
      if (String(url).endsWith('/models')) return Response.json({ data: [
        { id: 'listed-chat-model', pricing: { prompt: '0.01', completion: '0.02' }, architecture: { input_modalities: ['text'], output_modalities: ['text'] } },
      ] });
      inferenceCalls += 1;
      return sseResponse({ content: 'not allowed' });
    },
  });
  assert.equal(report.result, 'PAID_ONLY_OR_NOT_FREE');
  assert.equal(report.inferenceCalls, 0);
  assert.equal(inferenceCalls, 0);
  assert.match(report.limitations[0], /explicit positive-price metadata/u);
});

test('matrix continuation can account for prior real calls without resetting the hard cap', async () => {
  const report = await runCompatibilityMatrix({
    env: {},
    priorInferenceRequests: { openrouter: 1 },
    priorMetadataRequests: 3,
  });
  assert.equal(report.totalInferenceRequests, 1);
  assert.equal(report.inferenceBudget, '1/30');
  assert.equal(report.metadataRequests, 3);
  assert.equal(report.providers.openrouter.inferenceCalls, 1);
  assert.equal(report.providers.groq.inferenceCalls, 0);
  assert.equal(report.providers.gemini.inferenceCalls, 0);
});
