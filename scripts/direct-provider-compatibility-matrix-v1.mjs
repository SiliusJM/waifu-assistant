import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import {
  AssistantCore,
  ConversationRunner,
  DirectAIProvider,
  LOCAL_TOOL_ALLOWLIST,
  createLocalToolManager,
  createLogger,
} from '../dist/index.js';
import { PersonalityCompiler } from '../dist/personality/personality-compiler.js';
import { PersonalityRegistry } from '../dist/personality/personality-registry.js';
import { ProviderRequestBudget } from './provider-call-budget.mjs';

export const MAX_TOTAL_INFERENCE_REQUESTS = 30;
export const MAX_PROVIDER_INFERENCE_REQUESTS = 10;
export const ROUTER_FREE_MODEL = 'openrouter/free';
export const MATRIX_TIMEOUT_MS = 30_000;
export const FREE_MODE_STRATEGIES = Object.freeze({
  groq: 'ACCOUNT_FREE_QUOTA',
  gemini: 'ACCOUNT_FREE_TIER',
  openrouter: 'ZERO_PRICE_MODEL',
});
export const TOOL_CLASSIFICATIONS = Object.freeze([
  'TOOL_PASS', 'TOOL_MODEL_UNSUPPORTED', 'TOOL_FORMAT_INCOMPATIBLE',
  'TOOL_INVALID_RESPONSE', 'TOOL_NOT_VERIFIED',
]);
export const HISTORICAL_OPENROUTER_TOOL_OBSERVATION = Object.freeze({
  httpStatus: 200,
  providerErrorCode: 'INVALID_RESPONSE_ERROR',
  rawResponseAvailable: false,
  classification: 'TOOL_NOT_VERIFIED',
});

export const PROVIDER_DEFINITIONS = Object.freeze({
  groq: Object.freeze({
    name: 'Groq', baseUrlEnv: 'GROQ_BASE_URL', apiKeyEnv: 'GROQ_API_KEY',
    expectedBaseURL: 'https://api.groq.com/openai/v1', modelOverrideEnv: 'GROQ_TEST_MODEL',
  }),
  gemini: Object.freeze({
    name: 'Google Gemini', baseUrlEnv: 'GEMINI_BASE_URL', apiKeyEnv: 'GEMINI_API_KEY',
    expectedBaseURL: 'https://generativelanguage.googleapis.com/v1beta/openai', modelOverrideEnv: 'GEMINI_TEST_MODEL',
  }),
  openrouter: Object.freeze({
    name: 'OpenRouter', baseUrlEnv: 'OPENROUTER_BASE_URL', apiKeyEnv: 'OPENROUTER_API_KEY',
    expectedBaseURL: 'https://openrouter.ai/api/v1', modelOverrideEnv: 'OPENROUTER_TEST_MODEL',
  }),
});

const TAXONOMY = new Set([
  'PROVIDER_COMPATIBLE', 'PROVIDER_COMPATIBLE_WITH_LIMITATIONS', 'AUTH_FAILURE',
  'MODEL_UNAVAILABLE', 'MODEL_UNSUPPORTED_CAPABILITY', 'FREE_QUOTA_EXHAUSTED',
  'RATE_LIMITED', 'PAID_ONLY_OR_NOT_FREE', 'PROTOCOL_INCOMPATIBLE', 'TRANSPORT_LIMITATION', 'INCONCLUSIVE',
]);

function normalizeURL(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return undefined;
    return `${url.origin}${url.pathname.replace(/\/+$/u, '')}`;
  } catch {
    return undefined;
  }
}

function safeModel(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,150}$/u.test(value)
    && !/^[a-f0-9]{24,}$/iu.test(value) && !value.includes('@') ? value : undefined;
}

function safeName(value) {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(value) ? value : 'Error';
}

function safeCode(value) {
  return typeof value === 'string' && /^[A-Z0-9_-]{1,80}$/iu.test(value) ? value : 'UNKNOWN_ERROR';
}

export function safeFailure(error, stage = 'provider') {
  const cause = error?.cause;
  const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : undefined;
  return {
    stage,
    name: safeName(error?.name),
    code: safeCode(error?.code),
    ...(statusCode === undefined ? {} : { statusCode }),
    ...(cause === undefined ? {} : { cause: { name: safeName(cause?.name), code: safeCode(cause?.code) } }),
  };
}

function zeroPrice(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value === 0;
  if (typeof value === 'string') return /^0+(?:\.0+)?$/u.test(value.trim());
  return false;
}

export function explicitFreeEvidence(model) {
  if (!model || typeof model !== 'object') return false;
  const pricing = model.pricing;
  if (pricing && typeof pricing === 'object') {
    const prompt = pricing.prompt ?? pricing.input;
    const completion = pricing.completion ?? pricing.output;
    const request = pricing.request;
    if (zeroPrice(prompt) && zeroPrice(completion) && (request === undefined || zeroPrice(request))) return true;
  }
  return false;
}

function explicitPaidEvidence(model) {
  const pricing = model?.pricing;
  if (!pricing || typeof pricing !== 'object') return false;
  return [pricing.prompt ?? pricing.input, pricing.completion ?? pricing.output, pricing.request].some((price) => {
    if (typeof price === 'number') return Number.isFinite(price) && price > 0;
    if (typeof price === 'string') return Number(price) > 0;
    return false;
  });
}

function chatTextEligible(model) {
  const id = typeof model?.id === 'string' ? model.id.toLowerCase() : '';
  if (!id || /(embedding|embed|audio|whisper|transcri|moderation|rerank|image|vision|text-to-speech|tts)/u.test(id)) return false;
  const outputs = model.architecture?.output_modalities;
  if (Array.isArray(outputs) && (!outputs.includes('text') || outputs.some((modality) => modality !== 'text'))) return false;
  const inputs = model.architecture?.input_modalities;
  if (Array.isArray(inputs) && (!inputs.includes('text') || inputs.some((modality) => modality !== 'text'))) return false;
  const methods = model.supportedGenerationMethods ?? model.supported_generation_methods;
  if (Array.isArray(methods) && !methods.some((method) => /generateContent|chat|completion/iu.test(method))) return false;
  return true;
}

function accountEligible(providerKey, model) {
  if (!['groq', 'gemini'].includes(providerKey)
    || !chatTextEligible(model) || modelIsDeprecated(model) || model?.active === false) return false;
  if (providerKey === 'gemini') {
    const methods = model.supportedGenerationMethods ?? model.supported_generation_methods;
    const label = `${model.id ?? ''} ${model.displayName ?? ''}`;
    return Array.isArray(methods)
      ? methods.some((method) => /generateContent/iu.test(method))
      : /gemini|flash|text|chat/iu.test(label);
  }
  return true;
}

function geminiEfficiencyRank(model) {
  const label = `${model.id ?? ''} ${model.displayName ?? ''}`.toLowerCase();
  return /flash(?:[- ]lite)?/u.test(label) ? 0 : 1;
}

function candidateEvidence(providerKey) {
  if (providerKey === 'groq') return 'ACCOUNT_FREE_QUOTA';
  if (providerKey === 'gemini') return 'ACCOUNT_FREE_TIER';
  return 'CATALOG_ZERO_PRICE';
}

export function modelIsDeprecated(model, now = Date.now()) {
  if (model?.deprecated === true || model?.status === 'deprecated') return true;
  const expiry = model?.expiration_date ?? model?.deprecation_date ?? model?.expires_at;
  if (typeof expiry !== 'string' || !expiry) return false;
  const timestamp = Date.parse(expiry);
  return Number.isFinite(timestamp) && timestamp <= now;
}

function modelList(payload) {
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.models)) return payload.models;
  return undefined;
}

export function selectCandidate(providerKey, models, override) {
  if (!Object.hasOwn(PROVIDER_DEFINITIONS, providerKey)) throw new TypeError('Unknown provider key.');
  const catalog = Array.isArray(models) ? models.filter((model) => safeModel(model?.id)) : [];
  const eligible = providerKey === 'openrouter'
    ? (model) => chatTextEligible(model) && !modelIsDeprecated(model) && explicitFreeEvidence(model)
    : (model) => accountEligible(providerKey, model);
  if (override) {
    if (providerKey === 'openrouter' && override === ROUTER_FREE_MODEL) {
      const listedRouter = catalog.find((model) => model.id === ROUTER_FREE_MODEL);
      if (listedRouter && listedRouter.active !== false && chatTextEligible(listedRouter) && !modelIsDeprecated(listedRouter)
        && !explicitPaidEvidence(listedRouter)) {
        return { status: 'SELECTED', selectedModel: ROUTER_FREE_MODEL, selectionSource: 'OVERRIDE', freeEvidence: 'OPENROUTER_FREE_ROUTER' };
      }
      return { status: 'MODEL_UNAVAILABLE', selectedModel: undefined, selectionSource: 'OVERRIDE' };
    }
    const selected = catalog.find((model) => model.id === override);
    if (!selected) return { status: 'MODEL_UNAVAILABLE', selectedModel: undefined, selectionSource: 'OVERRIDE' };
    if (modelIsDeprecated(selected)) {
      const replacement = catalog.find((model) => model.id !== selected.id && eligible(model));
      if (replacement) return { status: 'MODEL_UNAVAILABLE', selectedModel: undefined, selectionSource: 'OVERRIDE', reason: 'OVERRIDE_DEPRECATED' };
    }
    if (!chatTextEligible(selected)) return { status: 'MODEL_UNSUPPORTED_CAPABILITY', selectedModel: undefined, selectionSource: 'OVERRIDE' };
    if (modelIsDeprecated(selected) || selected.active === false) return { status: 'MODEL_UNAVAILABLE', selectedModel: undefined, selectionSource: 'OVERRIDE' };
    if (!eligible(selected)) return {
      status: providerKey === 'openrouter' && explicitPaidEvidence(selected) ? 'PAID_ONLY_OR_NOT_FREE' : 'INCONCLUSIVE',
      selectedModel: undefined, selectionSource: 'OVERRIDE',
    };
    return { status: 'SELECTED', selectedModel: selected.id, selectionSource: 'OVERRIDE', freeEvidence: candidateEvidence(providerKey) };
  }

  if (providerKey === 'openrouter') {
    const listedRouter = catalog.find((model) => model.id === ROUTER_FREE_MODEL);
    if (listedRouter && listedRouter.active !== false && !modelIsDeprecated(listedRouter)
      && chatTextEligible(listedRouter) && !explicitPaidEvidence(listedRouter)) return {
      status: 'SELECTED', selectedModel: ROUTER_FREE_MODEL, selectionSource: 'FREE_ROUTER_POLICY', freeEvidence: 'OPENROUTER_FREE_ROUTER',
    };
  }

  const candidates = catalog.filter(eligible);
  candidates.sort((left, right) => {
    if (providerKey === 'gemini') {
      const rankDifference = geminiEfficiencyRank(left) - geminiEfficiencyRank(right);
      if (rankDifference !== 0) return rankDifference;
    }
    const leftCreated = Number(left.created ?? 0);
    const rightCreated = Number(right.created ?? 0);
    if (leftCreated !== rightCreated) return rightCreated - leftCreated;
    return left.id.localeCompare(right.id);
  });
  if (candidates.length) {
    return { status: 'SELECTED', selectedModel: candidates[0].id, selectionSource: 'AUTO', freeEvidence: candidateEvidence(providerKey) };
  }
  const usable = catalog.filter((model) => chatTextEligible(model) && !modelIsDeprecated(model) && model.active !== false);
  return {
    status: providerKey === 'openrouter' && usable.some(explicitPaidEvidence)
      ? 'PAID_ONLY_OR_NOT_FREE' : usable.length ? 'INCONCLUSIVE' : 'MODEL_UNAVAILABLE',
    selectedModel: undefined, selectionSource: 'AUTO',
  };
}

export function readProviderConfig(providerKey, env = process.env) {
  const definition = PROVIDER_DEFINITIONS[providerKey];
  if (!definition) throw new TypeError('Unknown provider key.');
  const apiKey = env[definition.apiKeyEnv]?.trim() ?? '';
  const baseURL = env[definition.baseUrlEnv]?.trim() ?? '';
  const override = env[definition.modelOverrideEnv]?.trim() ?? '';
  const expected = normalizeURL(definition.expectedBaseURL);
  const supplied = normalizeURL(baseURL);
  return {
    providerKey,
    name: definition.name,
    configured: Boolean(apiKey && baseURL),
    baseURLMatches: Boolean(supplied && supplied === expected),
    ...(apiKey && baseURL && supplied === expected ? { baseURL, apiKey } : {}),
    ...(override ? { modelOverride: safeModel(override) } : {}),
    overrideConfigured: Boolean(override),
    overrideInvalid: Boolean(override && !safeModel(override)),
  };
}

export function classifyProviderFailure({ statusCode, code, detail = '' } = {}) {
  const normalized = `${String(code ?? '')} ${String(detail ?? '')}`.toLowerCase();
  if (statusCode === 402 || /billing required|payment required|paid tier/iu.test(normalized)) return 'PAID_ONLY_OR_NOT_FREE';
  if (/tools?[^\n]{0,80}(?:not supported|unsupported|does not support)|(?:not supported|unsupported)[^\n]{0,80}tools?/iu.test(normalized)) return 'MODEL_UNSUPPORTED_CAPABILITY';
  if (statusCode === 401 || statusCode === 403 || /invalid[_ -]?api[_ -]?key|unauthori[sz]ed|authentication/iu.test(normalized)) return 'AUTH_FAILURE';
  if (statusCode === 429) return /quota|resource[_ -]?exhausted|daily limit|free tier exhausted/iu.test(normalized)
    ? 'FREE_QUOTA_EXHAUSTED' : 'RATE_LIMITED';
  if (statusCode === 404 || /model[_ -]?(not[_ -]?found|unavailable)/iu.test(normalized)) return 'MODEL_UNAVAILABLE';
  if (statusCode === 400 || /unsupported[_ -]?(parameter|capability)|invalid[_ -]?(request|response)|protocol/iu.test(normalized)) return 'PROTOCOL_INCOMPATIBLE';
  if (statusCode >= 500 || /network|socket|transport|timeout|cancellation/iu.test(normalized)) return 'TRANSPORT_LIMITATION';
  return 'INCONCLUSIVE';
}

export function classifyToolFormatOutcome({ protocolCompatible, parserAccepted, responseWellFormed = true } = {}) {
  if (protocolCompatible !== true) return 'TOOL_NOT_VERIFIED';
  if (parserAccepted === true) return 'TOOL_PASS';
  return responseWellFormed ? 'TOOL_FORMAT_INCOMPATIBLE' : 'TOOL_INVALID_RESPONSE';
}

export function classifyToolCapability({ toolDefinitionSent, toolCallEmitted, localToolExecuted, secondRound, finalAnswer } = {}) {
  if (toolDefinitionSent && toolCallEmitted && localToolExecuted && secondRound && finalAnswer) return 'TOOL_PASS';
  return 'TOOL_NOT_VERIFIED';
}

export function classifyToolRun({ requestFailed, failureClass, ...evidence } = {}) {
  if (failureClass === 'MODEL_UNSUPPORTED_CAPABILITY') return 'TOOL_MODEL_UNSUPPORTED';
  if (requestFailed && ['PROTOCOL_INCOMPATIBLE', 'INVALID_RESPONSE_ERROR'].includes(failureClass)) return 'TOOL_INVALID_RESPONSE';
  if (requestFailed) return 'TOOL_NOT_VERIFIED';
  return classifyToolCapability(evidence);
}

function safeErrorNameFromResponse(status) {
  return status === 429 ? 'RateLimitError' : status === 401 || status === 403 ? 'AuthenticationError' : 'ProviderHTTPError';
}

async function responseErrorDetail(response) {
  try {
    const body = await response.clone().json();
    return [body?.error?.code, body?.error?.type, body?.error?.message, body?.message]
      .filter((value) => typeof value === 'string').join(' ').slice(0, 2000);
  } catch {
    return '';
  }
}

export async function discoverProviderModels(config, { fetchImpl = fetch, timeoutMs = 10_000, budget } = {}) {
  if (!config?.configured) return { status: 'INCONCLUSIVE', reason: 'CREDENTIALS_NOT_CONFIGURED', metadataRequests: 0 };
  if (!config.baseURLMatches || !config.baseURL || !config.apiKey) {
    return { status: 'INCONCLUSIVE', reason: 'BASE_URL_MISMATCH', metadataRequests: 0 };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    budget?.countMetadataRequest();
    const response = await fetchImpl(`${config.baseURL.replace(/\/+$/u, '')}/models`, {
      headers: { authorization: `Bearer ${config.apiKey}`, accept: 'application/json' },
      signal: controller.signal,
      redirect: 'error',
    });
    if (!response.ok) {
      const detail = await responseErrorDetail(response);
      const result = classifyProviderFailure({ statusCode: response.status, detail });
      return { status: result, statusCode: response.status, metadataRequests: 1 };
    }
    const payload = await response.json();
    const models = modelList(payload);
    if (!models) return { status: 'PROTOCOL_INCOMPATIBLE', metadataRequests: 1, modelCount: 0 };
    const safeModels = models.filter((model) => safeModel(model?.id)).map((model) => ({
      id: model.id,
      ...(model.created !== undefined ? { created: model.created } : {}),
      ...(model.pricing && typeof model.pricing === 'object' ? { pricing: model.pricing } : {}),
      ...(model.architecture && typeof model.architecture === 'object' ? { architecture: model.architecture } : {}),
      ...(Array.isArray(model.supported_parameters) ? { supported_parameters: model.supported_parameters } : {}),
      ...(Array.isArray(model.supportedGenerationMethods) ? { supportedGenerationMethods: model.supportedGenerationMethods } : {}),
      ...(model.deprecated === true ? { deprecated: true } : {}),
      ...(typeof model.active === 'boolean' ? { active: model.active } : {}),
      ...(typeof model.displayName === 'string' ? { displayName: model.displayName.slice(0, 160) } : {}),
      ...(typeof model.status === 'string' ? { status: model.status } : {}),
      ...(typeof model.expiration_date === 'string' ? { expiration_date: model.expiration_date } : {}),
      ...(model.free === true ? { free: true } : {}),
      ...(model.is_free === true ? { is_free: true } : {}),
      ...(model.isFree === true ? { isFree: true } : {}),
    }));
    return { status: 'PASS', metadataRequests: 1, modelCount: safeModels.length, models: safeModels };
  } catch (error) {
    return { status: controller.signal.aborted ? 'TRANSPORT_LIMITATION' : 'TRANSPORT_LIMITATION', metadataRequests: 1,
      error: safeFailure(error, 'discovery') };
  } finally {
    clearTimeout(timer);
  }
}

function requestKind(body) {
  if (!body || !Array.isArray(body.messages)) return 'normal';
  return body.messages.some((message) => message?.role === 'tool' || Array.isArray(message?.tool_calls))
    ? 'tool-second-round' : 'normal';
}

function hasSuccessfulCalculatorResult(body) {
  if (!Array.isArray(body?.messages)) return false;
  return body.messages.some((message) => {
    if (message?.role !== 'tool' || message?.name !== 'local_calculate' || typeof message.content !== 'string') return false;
    try { return JSON.parse(message.content)?.status === 'success'; } catch { return false; }
  });
}

function budgetError() {
  const error = new Error('Provider request budget exhausted.');
  error.code = 'BUDGET_EXHAUSTED';
  return error;
}

function hasInferenceCapacity(globalBudget, perProviderBudget, count = 1) {
  return globalBudget.providerRequests + count <= MAX_TOTAL_INFERENCE_REQUESTS
    && perProviderBudget.providerRequests + count <= MAX_PROVIDER_INFERENCE_REQUESTS
    && globalBudget.canReserve(count) && perProviderBudget.canReserve(count);
}

function quietLogger() {
  return createLogger({ sink: {
    info() {}, warn() {}, error() {},
  } });
}

function createProviderContext(config, model, globalBudget, perProviderBudget, fetchImpl = fetch, timeoutMs = MATRIX_TIMEOUT_MS) {
  const requests = [];
  const active = new Set();
  let maxActiveRequests = 0;
  let requestSequence = 0;
  const responseModels = new Set();
  let context;

  const observedFetch = async (input, init = {}) => {
    let body;
    try { body = JSON.parse(String(init.body ?? '{}')); } catch { body = undefined; }
    const id = `${config.providerKey}-${++requestSequence}`;
    const request = {
      requestId: id, startedAt: performance.now(), statusCode: undefined, ttftMs: undefined,
      finishedAt: undefined, abortedAt: undefined, model: safeModel(body?.model), kind: requestKind(body),
      toolsSent: Array.isArray(body?.tools) && body.tools.length > 0,
      localCalculatorSucceeded: hasSuccessfulCalculatorResult(body),
      fetchError: undefined, streamError: undefined,
    };
    let downstreamCancelled = false;
    requests.push(request);
    active.add(id);
    maxActiveRequests = Math.max(maxActiveRequests, active.size);
    const settle = () => { request.finishedAt ??= performance.now(); active.delete(id); };
    let abortCounted = false;
    const onAbort = () => {
      request.abortedAt ??= performance.now();
      if (!abortCounted) {
        abortCounted = true;
        globalBudget.noteIssuedRequestAborted();
        perProviderBudget.noteIssuedRequestAborted();
      }
    };
    init.signal?.addEventListener('abort', onAbort, { once: true });
    let response;
    try {
      response = await fetchImpl(input, init);
      request.statusCode = response.status;
      if (!response.ok) {
        const detail = await responseErrorDetail(response);
        request.failureClass = classifyProviderFailure({ statusCode: response.status, detail });
        request.safeError = {
          stage: 'http', name: safeErrorNameFromResponse(response.status),
          code: safeCode(String(response.status)), statusCode: response.status,
        };
        context?.onProviderError?.(request.failureClass);
      }
    } catch (error) {
      settle();
      init.signal?.removeEventListener('abort', onAbort);
      request.fetchError = safeFailure(error, 'fetch');
      request.failureClass = classifyProviderFailure({ code: error?.code, detail: error?.name });
      if (request.abortedAt !== undefined || init.signal?.aborted) request.failureClass = 'TRANSPORT_LIMITATION';
      context?.onProviderError?.(request.failureClass);
      throw error;
    }
    if (!response.body) {
      settle();
      init.signal?.removeEventListener('abort', onAbort);
      return response;
    }
    const reader = response.body.getReader();
    const wrapped = new ReadableStream({
      async pull(controller) {
        try {
          const part = await reader.read();
          if (downstreamCancelled) return;
          if (part.done) {
            settle();
            init.signal?.removeEventListener('abort', onAbort);
            controller.close();
          } else {
            request.ttftMs ??= Math.round(performance.now() - request.startedAt);
            controller.enqueue(part.value);
          }
        } catch (error) {
          settle();
          init.signal?.removeEventListener('abort', onAbort);
          if (downstreamCancelled) return;
          request.streamError = safeFailure(error, 'stream');
          request.failureClass = classifyProviderFailure({ code: error?.code, detail: error?.name });
          context?.onProviderError?.(request.failureClass);
          controller.error(error);
        }
      },
      async cancel(reason) {
        downstreamCancelled = true;
        try { await reader.cancel(reason); } finally { settle(); init.signal?.removeEventListener('abort', onAbort); }
      },
    });
    return new Response(wrapped, { status: response.status, statusText: response.statusText, headers: response.headers });
  };

  const countedFetch = async (input, init = {}) => {
    let body;
    try { body = JSON.parse(String(init.body ?? '{}')); } catch { body = undefined; }
    const kind = requestKind(body);
    if (!hasInferenceCapacity(globalBudget, perProviderBudget)) throw budgetError();
    globalBudget.countProviderRequest({ kind });
    perProviderBudget.countProviderRequest({ kind });
    return observedFetch(input, { ...init, redirect: 'error' });
  };

  const provider = new DirectAIProvider({
    baseURL: config.baseURL, apiKey: config.apiKey, model,
    timeoutMs, retryPolicy: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 }, fetchImpl: countedFetch,
  });
  const core = new AssistantCore({
    provider,
    logger: quietLogger(),
    toolManager: createLocalToolManager(),
    toolAllowlist: LOCAL_TOOL_ALLOWLIST,
  });
  const personality = new PersonalityCompiler().compile({ profile: new PersonalityRegistry().defaultProfile });
  context = { provider, core, personality, requests, active, responseModels, globalBudget, perProviderBudget,
    get maxActiveRequests() { return maxActiveRequests; }, onProviderError: undefined };
  return context;
}

function arrayInput(values) {
  return (async function* input() { yield* values; }());
}

function contentFromMessages(session) {
  return session.getMessages().map((message) => ({ role: message.role, content: message.content }));
}

async function runTurn(context, runner, prompt) {
  const start = context.requests.length;
  const deltas = [];
  const responses = [];
  let run;
  try {
    run = await runner.run(arrayInput([prompt, '/exit']), {
      personality: context.personality,
      onDelta(delta) { deltas.push(delta); },
      onResponse(response) { responses.push(response); context.responseModels.add(response.model); },
    });
  } catch (error) {
    const request = context.requests.at(-1);
    if (request) {
      request.providerError = safeFailure(error);
      request.failureClass = classifyProviderFailure({
        statusCode: error?.statusCode,
        code: error?.code,
        detail: error?.name,
      });
      context.onProviderError?.(request.failureClass);
    }
    run = { status: 'failed', error: safeFailure(error) };
  }
  return { run, deltas, responses, requests: context.requests.slice(start), sessionMessages: contentFromMessages(runner.session) };
}

function summarizeRequest(request) {
  return {
    requestId: request.requestId,
    httpStatus: request.statusCode ?? null,
    ttftMs: request.ttftMs ?? null,
    durationMs: request.finishedAt === undefined ? null : Math.round(request.finishedAt - request.startedAt),
    aborted: request.abortedAt !== undefined,
    toolsSent: request.toolsSent,
    localCalculatorSucceeded: request.localCalculatorSucceeded,
    ...(request.failureClass ? { classification: request.failureClass } : {}),
    ...(request.fetchError ? { fetchError: request.fetchError } : {}),
    ...(request.streamError ? { streamError: request.streamError } : {}),
    ...(request.providerError ? { providerError: request.providerError } : {}),
    ...(request.safeError ? { error: request.safeError } : {}),
  };
}

function streamingLabel(turn) {
  if (turn.run.status !== 'completed' || turn.run.status === 'failed') return 'BROKEN';
  if (!turn.deltas.length) return turn.responses.length ? 'BUFFERED' : 'BROKEN';
  return turn.deltas.length > 1 ? 'PROGRESSIVE' : 'BUFFERED';
}

function hasSemanticInteger(text, expected) {
  return new RegExp(`(?<!\\d)${expected}(?!\\d)`, 'u').test(String(text ?? ''));
}

function summarizeLatency(requests) {
  const values = requests.filter((request) => Number.isFinite(request.ttftMs)).map((request) => request.ttftMs);
  const totals = requests.filter((request) => Number.isFinite(request.finishedAt)).map((request) => request.finishedAt - request.startedAt);
  const mean = (items) => items.length ? Math.round(items.reduce((sum, value) => sum + value, 0) / items.length) : null;
  return {
    ttftMinMs: values.length ? Math.min(...values) : null,
    ttftAvgMs: mean(values),
    ttftMaxMs: values.length ? Math.max(...values) : null,
    totalAvgMs: mean(totals),
  };
}

async function runInterruption(context, graceMs = 5000) {
  if (!hasInferenceCapacity(context.globalBudget, context.perProviderBudget, 2)) return { status: 'NOT RUN', reason: 'BUDGET' };
  const runner = new ConversationRunner(context.core);
  const initialRequestIndex = context.requests.length;
  let aId;
  let bId;
  let bOwnershipAt;
  let aCharacters = 0;
  let aCompletedBeforeB = false;
  let bText = '';
  let completedA = false;
  let providerFailure;
  let timer;
  let releaseB;
  let releaseEnd;
  const bGate = new Promise((resolve) => { releaseB = resolve; });
  const endGate = new Promise((resolve) => { releaseEnd = resolve; });
  const run = runner.run((async function* inputs() {
    yield 'Explícame con cierto detalle cómo funciona una API.';
    await bGate;
    if (aCompletedBeforeB || providerFailure) {
      yield '/exit';
      return;
    }
    bOwnershipAt ??= performance.now();
    yield 'Detente. ¿Cuánto es 64 + 64? Responde brevemente.';
    await endGate;
    yield '/exit';
  }()), {
    interruptible: true,
    personality: context.personality,
    onDelta(delta) {
      const request = [...context.active].map((id) => context.requests.find((item) => item.requestId === id)).find(Boolean);
      if (!bOwnershipAt && request) {
        aId ??= request.requestId;
        aCharacters += delta.trim().length;
        request.lastDeltaAt = performance.now();
        if (aCharacters >= 32) releaseB();
      } else if (bOwnershipAt && request && request.requestId !== aId) {
        bId ??= request.requestId;
        request.lastDeltaAt = performance.now();
      } else if (bOwnershipAt && request?.requestId === aId) {
        request.lastDeltaAt = performance.now();
      }
      if (request?.requestId === bId && bOwnershipAt) bText += delta;
    },
    onResponse(response) {
      const matching = context.requests.slice(initialRequestIndex).find((request) => request.requestId !== aId
        && request.model === response.model && request.startedAt >= (bOwnershipAt ?? Number.POSITIVE_INFINITY));
      if (matching) {
        bId ??= matching.requestId;
        bText = response.text;
        releaseEnd();
      } else if (!bOwnershipAt) {
        completedA = true;
        aCompletedBeforeB = true;
        releaseB();
      }
    },
    onInterruption() {
      bOwnershipAt ??= performance.now();
      const newRequest = context.requests.slice(initialRequestIndex).find((request) => request.requestId !== aId);
      bId ??= newRequest?.requestId;
    },
  });
  const previousProviderError = context.onProviderError;
  context.onProviderError = (classification) => {
    providerFailure = classification;
    releaseB();
    releaseEnd();
    previousProviderError?.(classification);
  };
  timer = setTimeout(() => { releaseB(); releaseEnd(); }, context.timeoutMs + graceMs);
  try { await run; } catch (error) {
    const request = context.requests.at(-1);
    if (request) {
      request.providerError = safeFailure(error);
      request.failureClass = classifyProviderFailure({ statusCode: error?.statusCode, code: error?.code, detail: error?.name });
      context.onProviderError?.(request.failureClass);
    }
  }
  finally {
    clearTimeout(timer);
    releaseB();
    releaseEnd();
    context.onProviderError = previousProviderError;
  }

  const requests = context.requests.slice(initialRequestIndex);
  aId ??= requests[0]?.requestId;
  bId ??= requests.find((request) => request.requestId !== aId)?.requestId;
  const requestA = requests.find((request) => request.requestId === aId);
  const requestB = requests.find((request) => request.requestId === bId);
  const messages = contentFromMessages(runner.session);
  const assistantText = messages.filter((message) => message.role === 'assistant').map((message) => message.content);
  const staleDelta = context.requests.slice(initialRequestIndex).some((request) => request.requestId === aId
    && (request.lastDeltaAt ?? 0) >= (bOwnershipAt ?? Number.POSITIVE_INFINITY));
  const partialA = assistantText.some((text) => text !== bText && text.length > 0);
  return {
    status: requestA?.abortedAt !== undefined && requestB?.finishedAt !== undefined && hasSemanticInteger(bText, 128)
      && !partialA && !staleDelta && context.maxActiveRequests === 1 ? 'PASS' : 'FAIL',
    aIssued: Boolean(requestA), aMeaningfulOutput: aCharacters >= 32,
    aAborted: requestA?.abortedAt !== undefined,
    aExpectedAbort: requestA?.abortedAt !== undefined,
    aCompletedBeforeB,
    bIssued: Boolean(requestB), bCompleted: Boolean(requestB?.finishedAt) && assistantText.includes(bText),
    bSemantic128: hasSemanticInteger(bText, 128),
    partialAPersisted: partialA,
    staleADelta: staleDelta,
    staleACompletion: completedA && Boolean(bOwnershipAt),
    maxActive: context.maxActiveRequests,
    requestErrors: requests.map(summarizeRequest).filter((request) => request.fetchError || request.streamError || request.providerError || request.error),
  };
}

function newProviderReport(config) {
  return {
    provider: config.name,
    freeModeStrategy: FREE_MODE_STRATEGIES[config.providerKey],
    ...(config.providerKey === 'openrouter' ? {
      historicalToolObservation: HISTORICAL_OPENROUTER_TOOL_OBSERVATION,
    } : {}),
    credentialsConfigured: config.configured,
    baseURLMatchesExpected: config.baseURLMatches,
    discovery: 'NOT RUN', modelsDiscovered: 0, selectedModel: undefined, selectionSource: undefined,
    basicCompletion: 'NOT RUN', unicode: 'NOT RUN', context: 'NOT RUN', streaming: 'NOT RUN',
    toolCalling: 'TOOL_NOT_VERIFIED', fullStackYuki: 'NOT RUN', currentDataHonesty: 'NOT RUN', interruption: 'NOT RUN',
    metadataRequests: 0, inferenceCalls: 0, toolSecondRounds: 0, aborts: 0, retries: 0, errors: [],
    latency: { ttftMinMs: null, ttftAvgMs: null, ttftMaxMs: null, totalAvgMs: null },
    result: 'INCONCLUSIVE', limitations: [], upstreamModels: [], freePriceVerified: false, freeEvidence: undefined,
  };
}

function responseText(turn) {
  return turn.responses.at(-1)?.text ?? '';
}

function completionStatus(turn, expected) {
  if (turn.run.status !== 'completed' || !turn.responses.length) return 'FAIL';
  const text = responseText(turn).trim();
  return typeof expected === 'function' ? (expected(text) ? 'PASS' : 'FAIL') : (text.includes(expected) ? 'PASS' : 'FAIL');
}

function fullStackIdentity(text) {
  const normalized = String(text ?? '').toLowerCase();
  return /yuki|disponible|aquí|lista|encantada|hola/iu.test(normalized)
    && !/^(?:soy|me llamo|como)\s+(?:chatgpt|google gemini|gemini|groq|openrouter|deepseek)\b/imu.test(String(text ?? '').trim());
}

function currentDataHonest(text) {
  const value = String(text ?? '');
  const declaresLimitation = /no (?:tengo|dispongo) de acceso|no puedo (?:verificar|consultar)|no cuento con datos|sin acceso a datos actuales|no tengo datos en tiempo real/iu.test(value);
  const givesExactPrice = /(?:USD|US\$|\$)\s?\d[\d,.]*/u.test(value);
  return declaresLimitation && !givesExactPrice;
}

async function runProviderValidationInternal(providerKey, {
  env = process.env,
  globalBudget = new ProviderRequestBudget(MAX_TOTAL_INFERENCE_REQUESTS),
  fetchImpl = fetch,
  timeoutMs = MATRIX_TIMEOUT_MS,
  interruptionGraceMs = 5000,
  priorInferenceRequests = 0,
} = {}) {
  if (!Number.isInteger(priorInferenceRequests) || priorInferenceRequests < 0 || priorInferenceRequests > MAX_PROVIDER_INFERENCE_REQUESTS) {
    throw new TypeError('Invalid prior provider inference usage.');
  }
  const config = readProviderConfig(providerKey, env);
  const report = newProviderReport(config);
  report.inferenceCalls = priorInferenceRequests;
  if (!config.configured) {
    report.result = 'INCONCLUSIVE';
    report.limitations.push('Provider credentials/base URL are not configured.');
    return { report, globalBudget };
  }
  if (!config.baseURLMatches) {
    report.result = 'INCONCLUSIVE';
    report.limitations.push('Configured base URL does not match the provider endpoint allowlist; no request was sent.');
    return { report, globalBudget };
  }

  if (config.overrideInvalid) {
    report.result = 'MODEL_UNAVAILABLE';
    report.limitations.push('Configured model override is malformed; no inference was sent.');
    return { report, globalBudget };
  }
  const perProviderBudget = new ProviderRequestBudget(MAX_PROVIDER_INFERENCE_REQUESTS);
  perProviderBudget.providerRequests = priorInferenceRequests;
  const discovery = await discoverProviderModels(config, { fetchImpl, budget: perProviderBudget });
  report.metadataRequests = perProviderBudget.metadataRequests;
  report.discovery = discovery.status;
  if (discovery.status !== 'PASS') {
    report.result = discovery.status;
    report.errors.push({ classification: discovery.status, ...(discovery.error ?? { stage: 'discovery', statusCode: discovery.statusCode ?? null }) });
    return { report, globalBudget };
  }
  report.modelsDiscovered = discovery.modelCount;
  const selection = selectCandidate(providerKey, discovery.models, config.modelOverride);
  report.selectedModel = selection.selectedModel;
  report.selectionSource = selection.selectionSource;
  report.freeEvidence = selection.freeEvidence;
  report.freePriceVerified = FREE_MODE_STRATEGIES[providerKey] === 'ZERO_PRICE_MODEL'
    && (selection.freeEvidence === 'OPENROUTER_FREE_ROUTER' || selection.freeEvidence === 'CATALOG_ZERO_PRICE');
  if (selection.status !== 'SELECTED') {
    report.result = selection.status;
    const reason = selection.status === 'INCONCLUSIVE'
      ? FREE_MODE_STRATEGIES[providerKey] === 'ZERO_PRICE_MODEL'
        ? 'No discovered OpenRouter candidate carried explicit zero-price/free evidence; inference skipped.'
        : 'No usable chat/text candidate was available under the declared account free-tier strategy; inference skipped.'
      : selection.status === 'PAID_ONLY_OR_NOT_FREE'
        ? 'Eligible catalog candidates carried explicit positive-price metadata; inference skipped to enforce FREE ONLY.'
        : selection.reason ?? 'No eligible model candidate was available.';
    report.limitations.push(reason);
    return { report, globalBudget };
  }

  const context = createProviderContext(config, selection.selectedModel, globalBudget, perProviderBudget, fetchImpl, timeoutMs);
  context.timeoutMs = timeoutMs;
  const runner = new ConversationRunner(context.core);
  const stop = { value: false };
  const invoke = async (prompt, targetRunner = runner) => {
    if (stop.value || !hasInferenceCapacity(globalBudget, perProviderBudget)) return undefined;
    const result = await runTurn(context, targetRunner, prompt);
    const lastRequest = result.requests.at(-1);
    if (lastRequest?.failureClass && ['AUTH_FAILURE', 'MODEL_UNAVAILABLE', 'MODEL_UNSUPPORTED_CAPABILITY', 'PROTOCOL_INCOMPATIBLE', 'PAID_ONLY_OR_NOT_FREE'].includes(lastRequest.failureClass)) {
      stop.value = true;
      report.errors.push({ classification: lastRequest.failureClass, ...summarizeRequest(lastRequest) });
    } else if (lastRequest?.failureClass && ['FREE_QUOTA_EXHAUSTED', 'RATE_LIMITED'].includes(lastRequest.failureClass)) {
      stop.value = true;
      report.errors.push({ classification: lastRequest.failureClass, ...summarizeRequest(lastRequest) });
    } else if (lastRequest?.fetchError || lastRequest?.streamError) {
      report.errors.push(summarizeRequest(lastRequest));
      stop.value = true;
    } else if (result.run.status !== 'completed') {
      stop.value = true;
    }
    return result;
  };

  const basic = await invoke('Responde únicamente: DIRECT-OK');
  if (basic) {
    report.basicCompletion = completionStatus(basic, 'DIRECT-OK');
    report.streaming = streamingLabel(basic);
    if (basic.run.status !== 'completed' || basic.responses.length === 0) stop.value = true;
  }
  if (!stop.value) {
    const unicode = await invoke('Responde exactamente: ñ á ü 🌸');
    if (unicode) {
      const normalized = responseText(unicode).trim();
      report.unicode = normalized === 'ñ á ü 🌸' ? 'PASS'
        : /[�]|(?:ÃƒÂ±|ÃƒÂ¡|ÃƒÂ¼|Ã°Å¸)/u.test(normalized) ? 'UTF8_TRANSPORT_FAILURE' : 'FAIL';
    }
  }
  if (!stop.value && hasInferenceCapacity(globalBudget, perProviderBudget, 3)) {
    const sessionRunner = new ConversationRunner(context.core);
    const first = await invoke('Mi código temporal es NEBULA-731. Confírmalo brevemente.', sessionRunner);
    const second = !stop.value ? await invoke('Responde brevemente: ¿qué es una API?', sessionRunner) : undefined;
    const third = !stop.value ? await invoke('¿Cuál era mi código temporal?', sessionRunner) : undefined;
    const thirdText = third ? responseText(third) : '';
    report.context = first?.run.status === 'completed' && second?.run.status === 'completed'
      && third?.run.status === 'completed' && hasSemanticInteger(thirdText, 'NEBULA-731') ? 'PASS' : 'FAIL';
    if (third?.run.status !== 'completed' || !hasSemanticInteger(thirdText, 'NEBULA-731')) stop.value = true;
  } else if (!stop.value) report.context = 'NOT RUN';

  if (!stop.value && hasInferenceCapacity(globalBudget, perProviderBudget)) {
    const fullStack = await invoke(
      'Hola Yuki. Responde brevemente en español, confirma que estás disponible. Además, ¿cuál es el precio actual de Bitcoin? Si no puedes verificar datos actuales, dilo claramente y no inventes una cifra.',
    );
    if (fullStack) {
      const text = responseText(fullStack);
      report.fullStackYuki = fullStack.run.status === 'completed' && fullStackIdentity(text) ? 'PASS' : 'FAIL';
      report.currentDataHonesty = fullStack.run.status === 'completed' && currentDataHonest(text) ? 'PASS' : 'FAIL';
    }
  }

  if (!stop.value && hasInferenceCapacity(globalBudget, perProviderBudget)) {
    const toolStart = context.requests.length;
    const toolTurn = await invoke('Usa la calculadora disponible para calcular: (27 * 13) + 4.');
    const toolRequests = context.requests.slice(toolStart);
    const toolExecuted = toolRequests.some((request) => request.localCalculatorSucceeded);
    const toolCallEmitted = toolRequests.some((request) => request.kind === 'tool-second-round') || toolExecuted;
    const failedToolRequest = toolRequests.find((request) => request.fetchError || request.streamError || request.providerError);
    report.toolCalling = classifyToolRun({
      requestFailed: Boolean(failedToolRequest || toolTurn?.run.status !== 'completed'),
      failureClass: failedToolRequest?.failureClass,
      toolDefinitionSent: toolRequests.some((request) => request.toolsSent),
      toolCallEmitted,
      localToolExecuted: toolExecuted,
      secondRound: toolRequests.some((request) => request.kind === 'tool-second-round'),
      finalAnswer: Boolean(toolTurn && toolTurn.run.status === 'completed' && hasSemanticInteger(responseText(toolTurn), 355)),
    });
  }

  if (!stop.value && hasInferenceCapacity(globalBudget, perProviderBudget, 2)) {
    report.interruption = await runInterruption(context, interruptionGraceMs);
    if (report.interruption.status === 'FAIL' && report.interruption.requestErrors?.length) {
      const last = report.interruption.requestErrors.at(-1);
      const failureClass = last.classification;
      if (failureClass && TAXONOMY.has(failureClass)) report.errors.push({ classification: failureClass, ...last });
    }
  }

  report.inferenceCalls = perProviderBudget.providerRequests;
  report.toolSecondRounds = perProviderBudget.toolSecondRoundRequests;
  report.aborts = perProviderBudget.abortedIssuedRequests;
  report.retries = perProviderBudget.retryRequests;
  report.latency = summarizeLatency(context.requests);
  report.upstreamModels = [...context.responseModels].filter((model) => safeModel(model));
  const hasTransportError = context.requests.some((request) => request.fetchError || request.streamError);
  const anyFailedStatus = [report.basicCompletion, report.unicode, report.context, report.fullStackYuki, report.currentDataHonesty]
    .some((value) => value === 'FAIL' || value === 'UTF8_TRANSPORT_FAILURE') || report.streaming === 'BROKEN';
  const allCore = report.basicCompletion === 'PASS' && report.context === 'PASS'
    && report.fullStackYuki === 'PASS' && report.currentDataHonesty === 'PASS';
  const fullyCompatible = allCore && report.unicode === 'PASS' && report.toolCalling === 'TOOL_PASS' && report.interruption?.status === 'PASS';
  report.result = fullyCompatible ? 'PROVIDER_COMPATIBLE'
    : allCore && !anyFailedStatus ? 'PROVIDER_COMPATIBLE_WITH_LIMITATIONS'
      : report.errors.at(-1)?.classification ?? (hasTransportError ? 'TRANSPORT_LIMITATION'
        : report.basicCompletion === 'FAIL' ? 'PROTOCOL_INCOMPATIBLE' : 'INCONCLUSIVE');
  if (report.toolCalling === 'TOOL_NOT_VERIFIED' || report.toolCalling === 'TOOL_MODEL_UNSUPPORTED'
    || report.toolCalling === 'TOOL_FORMAT_INCOMPATIBLE' || report.toolCalling === 'TOOL_INVALID_RESPONSE') {
    report.limitations.push(`tool_calling=${report.toolCalling}`);
  }
  if (report.interruption?.status === 'FAIL') report.limitations.push('A→B interruption did not satisfy all acceptance conditions; request-level telemetry is retained.');
  if (report.interruption === 'NOT RUN') report.limitations.push('interruption=NOT RUN (provider stopped after an earlier capability failure or budget limit).');
  return { report, globalBudget, requestSummary: context.requests.map(summarizeRequest) };
}

export async function runProviderValidation(providerKey, options = {}) {
  const original = { info: console.info, warn: console.warn, error: console.error };
  console.info = () => {};
  console.warn = () => {};
  console.error = () => {};
  try {
    return await runProviderValidationInternal(providerKey, options);
  } finally {
    console.info = original.info;
    console.warn = original.warn;
    console.error = original.error;
  }
}

export async function runCompatibilityMatrix({
  env = process.env,
  fetchImpl = fetch,
  priorInferenceRequests = {},
  priorMetadataRequests = 0,
} = {}) {
  const configuredResults = {};
  const globalBudget = new ProviderRequestBudget(MAX_TOTAL_INFERENCE_REQUESTS);
  const priorTotal = Object.entries(priorInferenceRequests).reduce((sum, [providerKey, count]) => {
    if (!Object.hasOwn(PROVIDER_DEFINITIONS, providerKey) || !Number.isInteger(count) || count < 0 || count > MAX_PROVIDER_INFERENCE_REQUESTS) {
      throw new TypeError('Invalid prior provider inference usage.');
    }
    return sum + count;
  }, 0);
  if (priorTotal > MAX_TOTAL_INFERENCE_REQUESTS || !Number.isInteger(priorMetadataRequests) || priorMetadataRequests < 0) {
    throw new TypeError('Invalid prior matrix usage.');
  }
  globalBudget.providerRequests = priorTotal;
  globalBudget.metadataRequests = priorMetadataRequests;
  let metadataRequests = priorMetadataRequests;
  for (const providerKey of Object.keys(PROVIDER_DEFINITIONS)) {
    const result = await runProviderValidation(providerKey, {
      env, globalBudget, fetchImpl, priorInferenceRequests: priorInferenceRequests[providerKey] ?? 0,
    });
    configuredResults[providerKey] = result.report;
    metadataRequests += result.report.metadataRequests;
  }
  return {
    status: 'COMPLETED', costMode: 'FREE ONLY', billingEnabledByTask: false, creditsPurchased: false,
    totalInferenceRequests: globalBudget.providerRequests,
    inferenceBudget: `${globalBudget.providerRequests}/${MAX_TOTAL_INFERENCE_REQUESTS}`,
    metadataRequests,
    secretExposure: false,
    providers: configuredResults,
    modelChurn: {
      permanentProductionModelIdsAdded: false,
      modelOverrideSupported: true,
      discoveryDrivenReplacementSupported: true,
      deprecatedUnavailableHandling: true,
      modelRetirementRequiresCodeChange: false,
    },
  };
}

export function assertSafeReport(report, env = process.env) {
  const serialized = JSON.stringify(report);
  const secretValues = Object.values(PROVIDER_DEFINITIONS).map(({ apiKeyEnv }) => env[apiKeyEnv])
    .filter((value) => typeof value === 'string' && value.length > 0);
  if (serialized.includes('apiKey') || serialized.includes('Authorization')
    || secretValues.some((secret) => serialized.includes(secret))) {
    throw new Error('Unsafe report projection.');
  }
}

export async function main() {
  const report = await runCompatibilityMatrix();
  assertSafeReport(report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.totalInferenceRequests > MAX_TOTAL_INFERENCE_REQUESTS) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write('{"status":"FAIL","reason":"SAFE_MATRIX_RUNNER_ERROR","secretExposure":false}\n');
    process.exitCode = 1;
  });
}
