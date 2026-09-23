import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_PROVIDER_INFERENCE_REQUESTS,
  MAX_TOTAL_INFERENCE_REQUESTS,
  FREE_MODE_STRATEGIES,
  HISTORICAL_OPENROUTER_TOOL_OBSERVATION,
  TOOL_CLASSIFICATIONS,
  assertSafeReport,
  classifyProviderFailure,
  classifyToolCapability,
  classifyToolFormatOutcome,
  classifyToolRun,
  discoverProviderModels,
  explicitFreeEvidence,
  readProviderConfig,
  runCompatibilityMatrix,
  runProviderValidation,
  selectCandidate,
} from './direct-provider-compatibility-matrix-v1.mjs';
import { ProviderRequestBudget } from './provider-call-budget.mjs';
import { DirectAIProvider } from '../dist/ai/direct-ai-provider.js';

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

async function parseOfflineToolStream(chunks) {
  let fetchCalls = 0;
  const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`;
  const provider = new DirectAIProvider({
    baseURL: 'https://offline.invalid/v1', apiKey: 'offline-secret', model: 'fixture-model',
    timeoutMs: 100, retryPolicy: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
    fetchImpl: async () => {
      fetchCalls += 1;
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    },
  });
  const events = [];
  try {
    for await (const event of provider.stream({
      sessionId: 'offline-tool-format',
      messages: [{ role: 'user', content: 'fixture only' }],
      tools: [{ type: 'function', function: { name: 'lookup', description: 'fixture', parameters: { type: 'object', properties: {}, additionalProperties: false } } }],
    })) events.push(event);
    return { accepted: true, response: events.at(-1)?.response, fetchCalls };
  } catch (error) {
    return { accepted: false, code: error?.code, fetchCalls };
  }
}

function toolDelta(toolCalls, finishReason = null, extraDelta = {}) {
  return { choices: [{ delta: { ...extraDelta, tool_calls: toolCalls }, finish_reason: finishReason }] };
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
  const selection = selectCandidate('groq', [
    { id: 'provider/retired', deprecated: true },
    { id: 'provider/new-chat-v2' },
  ]);
  assert.equal(selection.selectedModel, 'provider/new-chat-v2');
  assert.equal(selection.selectionSource, 'AUTO');
  assert.equal(explicitFreeEvidence(zeroPriceModel('provider/new-free-v2')), true);
  assert.equal(selectCandidate('openrouter', [zeroPriceModel('provider/new-free-v2')], 'provider/new-free-v2').status, 'SELECTED');
});

test('provider-specific free strategies allow nominally priced Groq and unpriced Gemini candidates', () => {
  assert.deepEqual(FREE_MODE_STRATEGIES, {
    groq: 'ACCOUNT_FREE_QUOTA', gemini: 'ACCOUNT_FREE_TIER', openrouter: 'ZERO_PRICE_MODEL',
  });
  assert.deepEqual(TOOL_CLASSIFICATIONS, [
    'TOOL_PASS', 'TOOL_MODEL_UNSUPPORTED', 'TOOL_FORMAT_INCOMPATIBLE', 'TOOL_INVALID_RESPONSE', 'TOOL_NOT_VERIFIED',
  ]);
  const groq = selectCandidate('groq', [
    { id: 'audio-chat-model', pricing: { prompt: '0.01', completion: '0.02' } },
    { id: 'image-chat-model', architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] } },
    { id: 'deprecated-chat', deprecated: true, pricing: { prompt: '0.01', completion: '0.02' } },
    { id: 'chat-text-priced', pricing: { prompt: '0.01', completion: '0.02' }, architecture: { input_modalities: ['text'], output_modalities: ['text'] } },
  ]);
  assert.equal(groq.status, 'SELECTED');
  assert.equal(groq.selectedModel, 'chat-text-priced');
  assert.equal(groq.freeEvidence, 'ACCOUNT_FREE_QUOTA');

  const gemini = selectCandidate('gemini', [
    { id: 'models/gemini-text-pro', supportedGenerationMethods: ['generateContent'] },
    { id: 'models/gemini-old-flash', displayName: 'Flash', deprecated: true, supportedGenerationMethods: ['generateContent'] },
    { id: 'models/gemini-new-flash-lite', displayName: 'Flash-Lite', supportedGenerationMethods: ['generateContent'] },
    { id: 'models/gemini-embedding', supportedGenerationMethods: ['embedContent'] },
  ]);
  assert.equal(gemini.status, 'SELECTED');
  assert.equal(gemini.selectedModel, 'models/gemini-new-flash-lite');
  assert.equal(gemini.freeEvidence, 'ACCOUNT_FREE_TIER');
  assert.equal(selectCandidate('gemini', [{ id: 'models/unknown', supportedGenerationMethods: ['embedContent'] }]).status, 'MODEL_UNAVAILABLE');
});

test('Groq and Gemini overrides use account strategy while OpenRouter rejects paid override', () => {
  const priced = { id: 'model-new', pricing: { prompt: '0.1', completion: '0.2' }, supportedGenerationMethods: ['generateContent'] };
  assert.equal(selectCandidate('groq', [priced], 'model-new').status, 'SELECTED');
  assert.equal(selectCandidate('gemini', [priced], 'model-new').status, 'SELECTED');
  assert.equal(selectCandidate('gemini', [priced], 'missing-model').status, 'MODEL_UNAVAILABLE');
  assert.equal(selectCandidate('openrouter', [{ ...priced, architecture: { input_modalities: ['text'], output_modalities: ['text'] } }], 'model-new').status, 'PAID_ONLY_OR_NOT_FREE');
});

test('Gemini prefers efficient Flash/Lite class dynamically and accepts catalog churn', () => {
  const oldCatalog = [{ id: 'models/gemini-old-flash', supportedGenerationMethods: ['generateContent'] }];
  const newCatalog = [
    { id: 'models/gemini-pro-new', supportedGenerationMethods: ['generateContent'] },
    { id: 'models/gemini-flash-lite-new', supportedGenerationMethods: ['generateContent'] },
  ];
  assert.equal(selectCandidate('gemini', oldCatalog).selectedModel, 'models/gemini-old-flash');
  assert.equal(selectCandidate('gemini', newCatalog).selectedModel, 'models/gemini-flash-lite-new');
});

test('OpenRouter permits only the free router or explicit zero-price entries', () => {
  const result = selectCandidate('openrouter', [
    zeroPriceModel('catalog/zero'),
    { id: 'catalog/paid', pricing: { prompt: '0.01', completion: '0.02' }, architecture: { input_modalities: ['text'], output_modalities: ['text'] } },
  ], 'catalog/zero');
  assert.equal(result.selectedModel, 'catalog/zero');
  assert.equal(selectCandidate('openrouter', [
    { id: 'openrouter/free', architecture: { input_modalities: ['text'], output_modalities: ['text'] } },
  ], 'openrouter/free').selectedModel, 'openrouter/free');
  assert.equal(selectCandidate('openrouter', [
    { id: 'openrouter/free', active: false, architecture: { input_modalities: ['text'], output_modalities: ['text'] } },
  ], 'openrouter/free').status, 'MODEL_UNAVAILABLE');
  assert.equal(selectCandidate('openrouter', [], 'openrouter/free').status, 'MODEL_UNAVAILABLE');
  assert.equal(selectCandidate('openrouter', [
    { id: 'catalog/paid', pricing: { prompt: '0.01', completion: '0.02' }, architecture: { input_modalities: ['text'], output_modalities: ['text'] } },
  ]).status, 'PAID_ONLY_OR_NOT_FREE');
  assert.equal(selectCandidate('openrouter', [{ id: 'catalog/free-flag-only', free: true }]).status, 'INCONCLUSIVE');
  assert.equal(selectCandidate('openrouter', [{ id: 'catalog/model:free' }]).status, 'INCONCLUSIVE');
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
  assert.equal(selectCandidate('openrouter', [{ id: 'visible-chat-model' }]).status, 'INCONCLUSIVE');
  assert.equal(selectCandidate('openrouter', [{ id: 'visible-paid-model', pricing: { prompt: '0.1', completion: '0.2' } }]).status, 'PAID_ONLY_OR_NOT_FREE');
});

test('OpenRouter free router is selected only when catalog or explicit override supports it', () => {
  const selection = selectCandidate('openrouter', [zeroPriceModel('ordinary/free-catalog-model')]);
  assert.equal(selection.status, 'SELECTED');
  assert.equal(selection.selectedModel, 'ordinary/free-catalog-model');
  assert.equal(selection.freeEvidence, 'CATALOG_ZERO_PRICE');
  assert.equal(selectCandidate('openrouter', [], 'openrouter/free').status, 'MODEL_UNAVAILABLE');
});

test('deprecated models are skipped and overrides do not silently churn', () => {
  const result = selectCandidate('gemini', [
    { id: 'models/old-free', deprecated: true, supportedGenerationMethods: ['generateContent'] },
    { id: 'models/new-free', supportedGenerationMethods: ['generateContent'] },
  ]);
  assert.equal(result.selectedModel, 'models/new-free');
  assert.equal(selectCandidate('gemini', [{ id: 'models/old-free', deprecated: true, supportedGenerationMethods: ['generateContent'] }], 'models/old-free').status, 'MODEL_UNAVAILABLE');
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
  assert.equal(classifyToolCapability({ toolDefinitionSent: true, toolCallEmitted: true, localToolExecuted: true, secondRound: true, finalAnswer: true }), 'TOOL_PASS');
  assert.equal(classifyToolCapability({ toolDefinitionSent: true, toolCallEmitted: false, localToolExecuted: false, secondRound: false, finalAnswer: true }), 'TOOL_NOT_VERIFIED');
  assert.equal(classifyToolCapability({ toolDefinitionSent: true, toolCallEmitted: false, localToolExecuted: false, secondRound: false, finalAnswer: false }), 'TOOL_NOT_VERIFIED');
  assert.equal(classifyToolRun({ requestFailed: true, failureClass: 'PROTOCOL_INCOMPATIBLE', toolDefinitionSent: true }), 'TOOL_INVALID_RESPONSE');
  assert.equal(classifyToolRun({ requestFailed: true, failureClass: 'MODEL_UNSUPPORTED_CAPABILITY' }), 'TOOL_MODEL_UNSUPPORTED');
  assert.equal(classifyToolFormatOutcome({ protocolCompatible: true, parserAccepted: true }), 'TOOL_PASS');
  assert.equal(classifyToolFormatOutcome({ protocolCompatible: true, parserAccepted: false }), 'TOOL_FORMAT_INCOMPATIBLE');
  assert.equal(classifyToolFormatOutcome({ protocolCompatible: true, parserAccepted: false, responseWellFormed: false }), 'TOOL_INVALID_RESPONSE');
  assert.equal(classifyToolFormatOutcome({ protocolCompatible: false, parserAccepted: false }), 'TOOL_NOT_VERIFIED');
  assert.deepEqual(HISTORICAL_OPENROUTER_TOOL_OBSERVATION, {
    httpStatus: 200, providerErrorCode: 'INVALID_RESPONSE_ERROR', rawResponseAvailable: false,
    classification: 'TOOL_NOT_VERIFIED',
  });
});

test('offline OpenAI-compatible tool-call fixtures classify one-chunk, fragmented, indexed and multi-call streams', async () => {
  const single = await parseOfflineToolStream([
    toolDelta([{ index: 0, id: 'call-one', type: 'function', function: { name: 'lookup', arguments: '{}' } }], 'tool_calls'),
  ]);
  assert.equal(single.accepted, true);
  assert.deepEqual(single.response.toolCalls, [{ id: 'call-one', name: 'lookup', argumentsJson: '{}' }]);
  assert.equal(single.response.finishReason, 'tool_calls');
  assert.equal(classifyToolFormatOutcome({ protocolCompatible: true, parserAccepted: single.accepted }), 'TOOL_PASS');
  assert.equal(single.fetchCalls, 1);

  const fragmented = await parseOfflineToolStream([
    toolDelta([{ index: 0, id: 'call-fragmented' }]),
    toolDelta([{ index: 0, function: { name: 'look', arguments: '{"q":' } }]),
    toolDelta([{ index: 0, function: { name: 'up', arguments: '"x"}' } }], 'tool_calls'),
  ]);
  assert.equal(fragmented.accepted, true);
  assert.deepEqual(fragmented.response.toolCalls, [{ id: 'call-fragmented', name: 'lookup', argumentsJson: '{"q":"x"}' }]);

  const indexed = await parseOfflineToolStream([
    toolDelta([
      { index: 1, id: 'call-one', function: { name: 'second', arguments: '{}' } },
      { index: 0, id: 'call-zero', function: { name: 'first', arguments: '{}' } },
    ], 'tool_calls'),
  ]);
  assert.equal(indexed.accepted, true);
  assert.deepEqual(indexed.response.toolCalls.map((call) => call.name), ['first', 'second']);

  const multipleDeltas = await parseOfflineToolStream([
    toolDelta([{ index: 0, id: 'call-a', function: { name: 'alpha', arguments: '{' } }]),
    toolDelta([
      { index: 1, id: 'call-b', function: { name: 'beta', arguments: '{}' } },
      { index: 0, function: { arguments: '}' } },
    ], 'tool_calls'),
  ]);
  assert.equal(multipleDeltas.accepted, true);
  assert.deepEqual(multipleDeltas.response.toolCalls.map((call) => call.name), ['alpha', 'beta']);
});

test('empty object arguments are valid while a missing argument fragment is invalid', async () => {
  const emptyObject = await parseOfflineToolStream([
    toolDelta([{ index: 0, id: 'call-empty-object', function: { name: 'no_args', arguments: '{}' } }], 'tool_calls'),
  ]);
  assert.equal(emptyObject.accepted, true);
  assert.equal(emptyObject.response.toolCalls[0].argumentsJson, '{}');

  const missing = await parseOfflineToolStream([
    toolDelta([{ index: 0, id: 'call-missing', function: { name: 'no_args' } }], 'tool_calls'),
  ]);
  assert.equal(missing.accepted, false);
  assert.equal(missing.code, 'INVALID_RESPONSE_ERROR');
  assert.equal(classifyToolFormatOutcome({ protocolCompatible: true, parserAccepted: false, responseWellFormed: false }), 'TOOL_INVALID_RESPONSE');

  const emptyString = await parseOfflineToolStream([
    toolDelta([{ index: 0, id: 'call-empty-string', function: { name: 'no_args', arguments: '' } }], 'tool_calls'),
  ]);
  assert.equal(emptyString.accepted, false);
  assert.equal(emptyString.code, 'INVALID_RESPONSE_ERROR');
});

test('protocol-compatible null text alongside tool_calls is accepted offline', async () => {
  const result = await parseOfflineToolStream([
    toolDelta([{ index: 0, id: 'call-null-content', function: { name: 'lookup', arguments: '{}' } }], 'tool_calls', { content: null }),
  ]);
  assert.equal(result.accepted, true);
  assert.equal(result.response.text, '');
  assert.equal(result.response.finishReason, 'tool_calls');
  assert.deepEqual(result.response.toolCalls, [{ id: 'call-null-content', name: 'lookup', argumentsJson: '{}' }]);
  assert.equal(result.fetchCalls, 1);
});

test('streamed tools accept omitted, empty and fragmented null content without producing text', async () => {
  for (const content of [{}, { content: '' }, { content: null }]) {
    const result = await parseOfflineToolStream([
      toolDelta([{ index: 0, id: 'call-fragment', function: { name: 'lookup', arguments: '{' } }], null, content),
      toolDelta([{ index: 0, function: { arguments: '}' } }], 'tool_calls', content),
    ]);
    assert.equal(result.accepted, true);
    assert.equal(result.response.text, '');
    assert.equal(result.response.finishReason, 'tool_calls');
    assert.deepEqual(result.response.toolCalls, [{ id: 'call-fragment', name: 'lookup', argumentsJson: '{}' }]);
  }
});

test('streamed tools still reject invalid content and incomplete or invalid tool fields', async () => {
  const valid = { index: 0, id: 'call-safe', function: { name: 'lookup', arguments: '{}' } };
  for (const content of [0, false, [], {}]) {
    const result = await parseOfflineToolStream([toolDelta([valid], 'tool_calls', { content })]);
    assert.equal(result.accepted, false);
    assert.equal(result.code, 'INVALID_RESPONSE_ERROR');
  }
  for (const call of [
    { ...valid, id: undefined },
    { ...valid, id: 1 },
    { ...valid, function: { arguments: '{}' } },
    { ...valid, function: { name: 1, arguments: '{}' } },
    { ...valid, function: { name: 'lookup' } },
    { ...valid, function: { name: 'lookup', arguments: '' } },
    { ...valid, function: { name: 'lookup', arguments: {} } },
  ]) {
    const result = await parseOfflineToolStream([toolDelta([call], 'tool_calls', { content: null })]);
    assert.equal(result.accepted, false);
    assert.equal(result.code, 'INVALID_RESPONSE_ERROR');
  }
  const oversized = await parseOfflineToolStream([
    toolDelta([{ ...valid, function: { name: 'lookup', arguments: 'x'.repeat(4097) } }], 'tool_calls', { content: null }),
  ]);
  assert.equal(oversized.accepted, false);
  assert.equal(oversized.code, 'TOOL_ARGUMENTS_ERROR');
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
  assert.equal(report.toolCalling, 'TOOL_PASS', JSON.stringify({ toolCalling: report.toolCalling, inferenceCalls: report.inferenceCalls, errors: report.errors }));
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

test('account-based strategy remains explicit in safe report without claiming catalog price proof', async () => {
  const { report } = await runProviderValidation('groq', { env: baseEnv('groq'), fetchImpl: async () => {
    throw new Error('Synthetic offline transport failure.');
  } });
  assert.equal(report.freeModeStrategy, 'ACCOUNT_FREE_QUOTA');
  assert.equal(report.freePriceVerified, false);
  assert.equal(JSON.stringify(report).includes(baseEnv('groq').GROQ_API_KEY), false);
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

test('bounded direct live-gate configuration excludes OpenRouter and enforces 14 total / 7 per provider offline', async () => {
  const env = {
    ...baseEnv('groq'),
    ...baseEnv('gemini'),
  };
  const providerCalls = { groq: 0, gemini: 0 };
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    const providerKey = url.includes('groq.com') ? 'groq' : 'gemini';
    if (url.endsWith('/models')) {
      const model = providerKey === 'groq'
        ? { id: 'fixture-groq-model', created: 1 }
        : { id: 'gemini-2.5-flash-lite', supportedGenerationMethods: ['generateContent'] };
      return Response.json({ data: [model] });
    }
    providerCalls[providerKey] += 1;
    const body = JSON.parse(init.body);
    const prompt = String(body.messages.at(-1)?.content ?? '');
    if (prompt.includes('DIRECT-OK')) return sseResponse({ content: 'DIRECT-OK', signal: init.signal });
    if (prompt.includes('ñ á ü 🌸')) return sseResponse({ content: 'ñ á ü 🌸', signal: init.signal });
    if (prompt.includes('¿Cuál era mi código temporal?')) return sseResponse({ content: 'NEBULA-731', signal: init.signal });
    if (prompt.includes('Mi código temporal')) return sseResponse({ content: 'Hola Yuki, estoy disponible. Recordaré NEBULA-731.', signal: init.signal });
    if (prompt.includes('¿qué es una API?')) return sseResponse({ content: 'Una API conecta aplicaciones.', signal: init.signal });
    if (prompt.includes('precio actual de Bitcoin')) return sseResponse({ content: 'Hola Yuki, estoy disponible. No puedo verificar datos actuales y no inventaré el precio.', signal: init.signal });
    if (prompt.includes('Usa la calculadora')) return sseResponse({ content: '355', signal: init.signal });
    return sseResponse({ content: 'Respuesta fixture.', signal: init.signal });
  };
  const report = await runCompatibilityMatrix({
    env,
    fetchImpl,
    providerKeys: ['groq', 'gemini'],
    maxTotalInferenceRequests: 14,
    maxProviderInferenceRequests: 7,
  });
  assert.deepEqual(Object.keys(report.providers), ['groq', 'gemini']);
  assert.equal(report.totalInferenceRequests, 14);
  assert.equal(report.inferenceBudget, '14/14');
  assert.deepEqual(providerCalls, { groq: 7, gemini: 7 });
  for (const providerReport of Object.values(report.providers)) {
    assert.equal(providerReport.basicCompletion, 'PASS');
    assert.equal(providerReport.unicode, 'PASS');
    assert.equal(providerReport.context, 'PASS');
    assert.equal(providerReport.fullStackYuki, 'PASS');
    assert.equal(providerReport.currentDataHonesty, 'PASS');
    assert.equal(providerReport.toolCalling, 'TOOL_NOT_VERIFIED');
    assert.equal(providerReport.interruption.status, 'NOT RUN');
    assert.equal(providerReport.inferenceCalls, 7);
    assert.equal(providerReport.retries, 0);
  }
});
