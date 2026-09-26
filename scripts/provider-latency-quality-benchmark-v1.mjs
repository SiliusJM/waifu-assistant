import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { DirectAIProvider } from '../dist/ai/direct-ai-provider.js';
import { classifyBenchmarkError } from './benchmark-ai-core.mjs';
import {
  BENCHMARK_CALL_BUDGET,
  evaluateScenario,
  loadScenarioSet,
  parseRetryAfterMs,
  parseBenchmarkArgs,
  providerPacingDelayMs,
  providerPacingIntervalMs,
  resolveBenchmarkConfig,
  summarizeBenchmark,
  warmupGate,
} from './provider-benchmark-v1-core.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scenarioPath = resolve(dirname(fileURLToPath(import.meta.url)), 'provider-benchmark-v1-scenarios.json');
const RUN_ID = `provider-benchmark-v1-${new Date().toISOString().replace(/[:.]/gu, '-')}`;

function modelOverrides(value) {
  if (!value) return undefined;
  const separator = value.indexOf('=');
  if (separator < 1 || separator === value.length - 1) throw new Error('--model must use profile=model syntax.');
  return { profile: value.slice(0, separator).toLowerCase(), model: value.slice(separator + 1) };
}

function outputPath(value) {
  if (!value || !isAbsolute(value)) throw new Error('--output must be an absolute directory outside the repository.');
  const resolved = resolve(value);
  const rel = relative(root, resolved);
  if (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel)) {
    throw new Error('Raw benchmark artifacts must be stored outside the repository.');
  }
  return resolved;
}

function safeErrorFields(error) {
  const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : undefined;
  return {
    errorCategory: classifyBenchmarkError(error),
    ...(typeof error?.code === 'string' ? { errorCode: error.code } : {}),
    ...(statusCode !== undefined ? { httpStatus: statusCode } : {}),
    ...(Number.isFinite(error?.retryAfterMs) ? { retryAfterMs: error.retryAfterMs } : {}),
    retryable: error?.retryable === true,
  };
}

function createProvider(config, timeoutMs, state) {
  return new DirectAIProvider({
    baseURL: config.baseURL,
    apiKey: config.apiKey,
    model: config.model,
    timeoutMs,
    retryPolicy: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
    fetchImpl: async (input, init) => {
      const response = await fetch(input, init);
      state.httpStatus = response.status;
      state.retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
      state.responseHeadersMs ??= performance.now() - state.started;
      if (!response.body || [204, 205, 304].includes(response.status)) return response;
      const observedBody = response.body.pipeThrough(new TransformStream({
        transform(chunk, controller) {
          state.timeToFirstByteMs ??= performance.now() - state.started;
          controller.enqueue(chunk);
        },
      }));
      return new Response(observedBody, { status: response.status, statusText: response.statusText, headers: response.headers });
    },
  });
}

async function streamAttempt(config, request, timeoutMs, signal, kind) {
  const started = performance.now();
  const startedAt = new Date().toISOString();
  const state = { started, httpStatus: undefined };
  const provider = createProvider(config, timeoutMs, state);
  let ttftMs;
  let firstNonEmptyTextMs;
  let deltaCount = 0;
  let text = '';
  let response;
  try {
    for await (const event of provider.stream(request, { signal })) {
      if (event.type === 'text_delta' && event.delta.length > 0) {
        ttftMs ??= performance.now() - started;
        firstNonEmptyTextMs ??= performance.now() - started;
        deltaCount += 1;
        text += event.delta;
      } else if (event.type === 'completed') {
        response = event.response;
      }
    }
    const totalMs = performance.now() - started;
    const generationMs = ttftMs === undefined ? undefined : totalMs - ttftMs;
    return {
      profile: config.profile,
      kind,
      startedAt,
      success: Boolean(response && (text.trim() || response.toolCalls?.length)),
      provider: response?.provider,
      httpStatus: state.httpStatus,
      timeToFirstByteMs: state.timeToFirstByteMs,
      responseHeadersMs: state.responseHeadersMs,
      ttftMs,
      firstNonEmptyTextMs,
      totalMs,
      deltaCount,
      responseChars: text.length,
      charsPerSecondAfterTtft: generationMs > 0 ? text.length / (generationMs / 1000) : undefined,
      finishReason: response?.finishReason,
      model: response?.model,
      text,
      ...(response ? {} : { errorCategory: 'EMPTY_RESPONSE', errorCode: 'INVALID_RESPONSE_ERROR' }),
    };
  } catch (error) {
    const totalMs = performance.now() - started;
    return {
      profile: config.profile,
      kind,
      startedAt,
      success: false,
      httpStatus: state.httpStatus ?? (Number.isInteger(error?.statusCode) ? error.statusCode : undefined),
      timeToFirstByteMs: state.timeToFirstByteMs,
      responseHeadersMs: state.responseHeadersMs,
      ttftMs,
      firstNonEmptyTextMs,
      totalMs,
      deltaCount,
      responseChars: text.length,
      ...safeErrorFields(error),
      ...(Number.isFinite(state.retryAfterMs) ? { retryAfterMs: state.retryAfterMs } : {}),
    };
  }
}

function safeText(text, apiKey) {
  if (typeof text !== 'string') return text;
  let output = text;
  if (apiKey) output = output.split(apiKey).join('[REDACTED]');
  return output.replace(/(Bearer\s+)[A-Za-z0-9._~+/-]{12,}/giu, '$1[REDACTED]');
}

function userMessage(content) {
  return { role: 'user', content };
}

function requestFor(sessionId, messages, config) {
  return { sessionId, messages, model: config.model };
}

async function retryableAttempt(config, request, timeoutMs, ledger, kind, state) {
  let last;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (ledger.httpAttempts >= BENCHMARK_CALL_BUDGET) {
      state.callBudgetExhausted = true;
      break;
    }
    await waitForProviderSlot(state);
    ledger.httpAttempts += 1;
    last = await streamAttempt(config, request, timeoutMs, undefined, kind);
    ledger.records.push({ ...last, attempt, isRetry: attempt > 1 });
    if (last.success) return last;

    if (last.errorCategory === 'HTTP_429') {
      state.rateLimitCount += 1;
      if (state.rateLimitCount >= 2) {
        state.paused = true;
        state.pauseReason = 'RATE_LIMIT_PRESSURE';
        break;
      }
    }
    const recoverable = last.retryable === true || ['HTTP_429', 'HTTP_5XX', 'NETWORK'].includes(last.errorCategory);
    if (!recoverable || attempt === 3) break;
    const retryAfter = Number.isFinite(last.retryAfterMs) ? last.retryAfterMs : undefined;
    const delayMs = retryAfter ?? Math.min(1000 * (2 ** (attempt - 1)), 5000);
    if (delayMs > 60000) {
      state.paused = last.errorCategory === 'HTTP_429';
      state.pauseReason = state.paused ? 'RETRY_AFTER_EXCEEDS_SAFE_WAIT' : undefined;
      break;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
  }
  return last;
}

async function waitForProviderSlot(state) {
  const waitMs = providerPacingDelayMs(state.nextRequestAt);
  if (waitMs > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, waitMs));
  state.nextRequestAt = Date.now() + state.minimumRequestIntervalMs;
}

async function cancellationProbe(config, timeoutMs, ledger, providerState) {
  if (ledger.httpAttempts >= BENCHMARK_CALL_BUDGET) return { profile: config.profile, kind: 'cancellation', status: 'NOT RUN_CALL_BUDGET' };
  await waitForProviderSlot(providerState);
  ledger.httpAttempts += 1;
  const controller = new AbortController();
  const state = { started: performance.now(), httpStatus: undefined };
  const provider = createProvider(config, timeoutMs, state);
  const iterator = provider.stream({
    sessionId: `${RUN_ID}-${config.profile}-cancel`,
    model: config.model,
    messages: [
      { role: 'system', content: 'Responde en español con una explicación algo larga y sin enumerar.' },
      userMessage('Explica en varios párrafos cómo planear una tarea compleja, con ejemplos concretos y una conclusión.'),
    ],
  }, { signal: controller.signal })[Symbol.asyncIterator]();
  let sawDelta = false;
  let eventsAfterAbort = 0;
  let errorCategory;
  const startedAt = new Date().toISOString();
  try {
    while (true) {
      const item = await iterator.next();
      if (item.done) break;
      if (controller.signal.aborted) eventsAfterAbort += 1;
      if (item.value?.type === 'text_delta' && item.value.delta.length > 0 && !sawDelta) {
        sawDelta = true;
        controller.abort();
      }
    }
  } catch (error) {
    errorCategory = classifyBenchmarkError(error);
  } finally {
    controller.abort();
    await iterator.return?.().catch?.(() => undefined);
  }
  const elapsedMs = performance.now() - state.started;
  const record = {
    profile: config.profile,
    kind: 'cancellation',
    startedAt,
    status: sawDelta && errorCategory === 'CANCELLED' && eventsAfterAbort === 0 ? 'PASS' : 'PARTIAL',
    httpStatus: state.httpStatus,
    timeToFirstByteMs: state.timeToFirstByteMs,
    responseHeadersMs: state.responseHeadersMs,
    firstDeltaObserved: sawDelta,
    streamStoppedByAbort: errorCategory === 'CANCELLED',
    eventsAfterAbort,
    elapsedMs,
    partialTextPersisted: false,
  };
  ledger.records.push(record);
  return record;
}

function finalRecord(attempt, apiKey) {
  return {
    ...attempt,
    text: safeText(attempt.text, apiKey),
    retryable: undefined,
  };
}

async function run() {
  const args = parseBenchmarkArgs(process.argv.slice(2));
  const parsedOverride = modelOverrides(args.model);
  if (parsedOverride && !args.profiles.includes(parsedOverride.profile)) throw new Error('--model profile is not in --profiles.');
  const destination = outputPath(args.output);
  const scenarioSet = await loadScenarioSet(args.scenarioSet ?? scenarioPath);
  const scenarioSetSha256 = createHash('sha256').update(await readFile(args.scenarioSet ?? scenarioPath)).digest('hex');
  const configs = args.profiles.map((profile) => resolveBenchmarkConfig(
    profile,
    process.env,
    parsedOverride?.profile === profile ? parsedOverride.model : undefined,
  ));
  const ready = configs.filter((config) => !config.blockedReason);
  const blocked = configs.filter((config) => config.blockedReason).map(({ profile, blockedReason }) => ({ profile, status: 'BLOCKED', reason: blockedReason }));
  if (!ready.length) throw new Error('All requested provider profiles are blocked; no provider request was sent.');

  await mkdir(destination, { recursive: true });
  const ledger = { httpAttempts: 0, records: [], blocked };
  const providerStates = new Map(ready.map((config) => [config.profile, {
    rateLimitCount: 0,
    paused: false,
    minimumRequestIntervalMs: providerPacingIntervalMs(config.profile, process.env.YUKI_BENCHMARK_GEMINI_MIN_INTERVAL_MS),
  }]));
  const configSummary = ready.map(({ profile, model, baseHost }) => ({ profile, model, baseHost, accessClass: profile === 'omniroute' && model.includes('best-free') ? 'FREE_ROUTE_LABEL' : 'EXISTING_ACCESS_UNVERIFIED' }));

  // One bounded warmup per ready provider. Never included in latency/quality summaries.
  for (const config of ready) {
    const warmup = await retryableAttempt(config, {
      sessionId: `${RUN_ID}-${config.profile}-warmup`,
      model: config.model,
      messages: [{ role: 'system', content: scenarioSet.systemPrompt }, userMessage('Responde exactamente PONG.')],
    }, args.timeoutMs, ledger, 'warmup', providerStates.get(config.profile));
    const gate = warmupGate(warmup);
    if (!gate.ready) {
      const providerState = providerStates.get(config.profile);
      providerState.paused = true;
      providerState.pauseReason = gate.reason;
    }
  }

  // Separate, single cancellation probe per ready provider; normal measured calls follow it.
  for (const config of ready) {
    if (!providerStates.get(config.profile).paused) await cancellationProbe(config, args.timeoutMs, ledger, providerStates.get(config.profile));
  }

  const singles = scenarioSet.singleTurnScenarios;
  for (let iteration = 0; iteration < args.iterations; iteration += 1) {
    for (let index = 0; index < singles.length; index += 1) {
      const scenario = singles[index];
      const rotated = [...ready.slice((iteration + index) % ready.length), ...ready.slice(0, (iteration + index) % ready.length)];
      for (const config of rotated) {
        const providerState = providerStates.get(config.profile);
        if (providerState.paused || ledger.httpAttempts >= BENCHMARK_CALL_BUDGET) continue;
        const sessionId = `${RUN_ID}-${config.profile}-${scenario.id}-${iteration + 1}`;
        const attempt = await retryableAttempt(config, {
          sessionId,
          model: config.model,
          messages: [{ role: 'system', content: scenarioSet.systemPrompt }, userMessage(scenario.prompt)],
        }, args.timeoutMs, ledger, 'evaluation', providerState);
        const quality = attempt?.success ? evaluateScenario(scenario.checks, attempt.text) : undefined;
        const final = ledger.records.at(-1);
        if (final?.profile === config.profile && final?.kind === 'evaluation') {
          final.scenarioId = scenario.id;
          final.category = scenario.category;
          final.iteration = iteration + 1;
          if (quality) final.quality = quality;
        }
      }
    }
  }

  const multi = scenarioSet.multiTurn;
  for (let sessionIndex = 0; sessionIndex < multi.sessions.length; sessionIndex += 1) {
    const rotated = [...ready.slice(sessionIndex % ready.length), ...ready.slice(0, sessionIndex % ready.length)];
    for (const config of rotated) {
      const providerState = providerStates.get(config.profile);
      if (providerState.paused || ledger.httpAttempts >= BENCHMARK_CALL_BUDGET) continue;
      const code = multi.sessions[sessionIndex].code;
      const sessionId = `${RUN_ID}-${config.profile}-multi-${sessionIndex + 1}`;
      const firstPrompt = multi.firstTurnTemplate.replace('{code}', code);
      const first = await retryableAttempt(config, {
        sessionId,
        model: config.model,
        messages: [{ role: 'system', content: scenarioSet.systemPrompt }, userMessage(firstPrompt)],
      }, args.timeoutMs, ledger, 'evaluation', providerState);
      const firstRecord = ledger.records.at(-1);
      if (firstRecord?.profile === config.profile && firstRecord?.kind === 'evaluation') {
        firstRecord.scenarioId = multi.id;
        firstRecord.category = multi.category;
        firstRecord.iteration = sessionIndex + 1;
        firstRecord.turn = 1;
        if (first?.success) firstRecord.quality = { flags: { nonEmptyAcknowledgment: true }, pass: true };
      }
      if (!first?.success || providerState.paused || ledger.httpAttempts >= BENCHMARK_CALL_BUDGET) continue;
      const history = [
        { role: 'system', content: scenarioSet.systemPrompt },
        userMessage(firstPrompt),
        { role: 'assistant', content: first.text },
        userMessage(multi.secondTurn),
      ];
      const second = await retryableAttempt(config, { sessionId, model: config.model, messages: history }, args.timeoutMs, ledger, 'evaluation', providerState);
      const secondRecord = ledger.records.at(-1);
      if (secondRecord?.profile === config.profile && secondRecord?.kind === 'evaluation') {
        secondRecord.scenarioId = multi.id;
        secondRecord.category = multi.category;
        secondRecord.iteration = sessionIndex + 1;
        secondRecord.turn = 2;
        secondRecord.sessionIsolation = true;
        if (second?.success) secondRecord.quality = evaluateScenario(multi.checks, second.text, code);
      }
    }
  }

  const summaries = summarizeBenchmark(ready.map((config) => config.profile), ledger.records);
  const hasSuccessfulEvaluation = summaries.some((provider) => provider.successful > 0);
  const raw = {
    schemaVersion: 1,
    runId: RUN_ID,
    status: hasSuccessfulEvaluation ? 'PROPOSED_BENCHMARK_EVIDENCE' : 'NO_PROVIDER_SUCCEEDED',
    generatedAt: new Date().toISOString(),
    configuration: { timeoutMs: args.timeoutMs, iterations: args.iterations, callBudget: BENCHMARK_CALL_BUDGET, profiles: configSummary, blocked },
    scenarioSet: 'provider-benchmark-v1-scenarios.json',
    scenarioSetSha256,
    httpAttempts: ledger.httpAttempts,
    results: ledger.records.map((record) => finalRecord(record, configs.find((entry) => entry.profile === record.profile)?.apiKey)),
  };
  const summary = {
    schemaVersion: 1,
    runId: RUN_ID,
    status: hasSuccessfulEvaluation ? 'COMPLETED_WITH_LIMITATIONS' : 'NO_PROVIDER_SUCCEEDED',
    generatedAt: new Date().toISOString(),
    totalHttpAttempts: ledger.httpAttempts,
    callBudget: BENCHMARK_CALL_BUDGET,
    scenarioSetSha256,
    providers: [...summaries, ...blocked.map((entry) => ({ profile: entry.profile, status: entry.status, reason: entry.reason }))],
    cancellation: ledger.records.filter((record) => record.kind === 'cancellation'),
    rateLimitPressure: [...providerStates.entries()].map(([profile, state]) => ({ profile, pressure: state.rateLimitCount >= 2, paused: state.paused, reason: state.pauseReason })),
    latencyIncludesAllEvaluationSamples: true,
    outlierPolicy: 'No latency samples removed; aggregate uses every recorded evaluation attempt.',
    httpStatusAndTtfb: 'HTTP status, response-header arrival, and first body-byte timing are observed by a transparent fetch wrapper.',
  };
  const summaryMarkdown = [
    '# Provider Latency + Quality Benchmark V1',
    '',
    `Run: ${RUN_ID}`,
    `Status: ${summary.status}`,
    `HTTP attempts: ${ledger.httpAttempts}/${BENCHMARK_CALL_BUDGET}`,
    '',
    ...summary.providers.flatMap((provider) => provider.status === 'BLOCKED'
      ? [`## ${provider.profile}`, '', `BLOCKED: ${provider.reason}`, '']
      : [`## ${provider.profile} (${provider.model ?? 'model not observed'})`, '',
        `Attempts: ${provider.attempts}; successes: ${provider.successful}; failures: ${provider.failures}; success rate: ${(provider.successRate * 100).toFixed(1)}%.`,
        `TTFT median/p90: ${provider.ttftMs.median?.toFixed(0) ?? 'n/a'}/${provider.ttftMs.p90?.toFixed(0) ?? 'n/a'} ms.`,
        `Total median/p90 (all samples): ${provider.totalMs.median?.toFixed(0) ?? 'n/a'}/${provider.totalMs.p90?.toFixed(0) ?? 'n/a'} ms.`,
        `Timeouts: ${provider.timeouts}; rate limits: ${provider.rateLimits}; streaming multi-delta rate: ${(provider.streaming.multiDeltaRate * 100).toFixed(1)}%.`,
        `Quality by category: ${JSON.stringify(provider.qualityByCategory)}.`, '']),
    '## Limitations', '',
    'Provider labels and available credentials do not prove account billing tier. Paid-route usage was not authorized.',
  ].join('\n');

  await writeFile(resolve(destination, 'raw-results.json'), JSON.stringify(raw, null, 2) + '\n', { flag: 'wx' });
  await writeFile(resolve(destination, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' });
  await writeFile(resolve(destination, 'summary.md'), summaryMarkdown + '\n', { flag: 'wx' });
  process.stdout.write(JSON.stringify({ status: summary.status, runId: RUN_ID, totalHttpAttempts: ledger.httpAttempts, providers: summary.providers.map(({ profile, model, status, reason, attempts, successful, failures }) => ({ profile, model, status, reason, attempts, successful, failures })), outputDirectory: destination, secretsPrinted: false }) + '\n');
}

run().catch((error) => {
  process.stderr.write(JSON.stringify({ status: 'FAIL', errorType: error?.name ?? 'Error', message: error instanceof Error ? error.message : 'benchmark failed', secretsPrinted: false }) + '\n');
  process.exitCode = 1;
});
