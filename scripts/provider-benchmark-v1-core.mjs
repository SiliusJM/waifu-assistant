import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const BENCHMARK_CALL_BUDGET = 110;
export const BENCHMARK_PROFILE_IDS = Object.freeze(['omniroute', 'groq', 'gemini']);

export function parseBenchmarkArgs(argv) {
  const args = { profiles: ['omniroute', 'groq', 'gemini'], iterations: 3, timeoutMs: 30000 };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--profiles' || value === '--iterations' || value === '--scenario-set' || value === '--output' || value === '--timeout-ms' || value === '--model') {
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) throw new Error(`Missing value for ${value}.`);
      if (value === '--profiles') args.profiles = next.split(',').map((profile) => profile.trim().toLowerCase()).filter(Boolean);
      if (value === '--iterations') args.iterations = Number(next);
      if (value === '--timeout-ms') args.timeoutMs = Number(next);
      if (value === '--scenario-set') args.scenarioSet = next;
      if (value === '--output') args.output = next;
      if (value === '--model') args.model = next;
      index += 1;
    } else {
      throw new Error(`Unknown benchmark argument: ${value}`);
    }
  }
  if (!args.profiles.length || args.profiles.some((profile) => !BENCHMARK_PROFILE_IDS.includes(profile))) {
    throw new Error('Profiles must be a non-empty subset of omniroute,groq,gemini.');
  }
  if (new Set(args.profiles).size !== args.profiles.length) throw new Error('Duplicate provider profile.');
  if (!Number.isInteger(args.iterations) || args.iterations !== 3) throw new Error('Provider Benchmark V1 requires exactly 3 iterations.');
  if (!Number.isInteger(args.timeoutMs) || args.timeoutMs < 5000 || args.timeoutMs > 60000) {
    throw new Error('Timeout must be between 5000 and 60000 milliseconds.');
  }
  return args;
}

export async function loadScenarioSet(path) {
  const source = JSON.parse(await readFile(resolve(path), 'utf8'));
  if (source.schemaVersion !== 1 || source.suite !== 'provider-latency-quality-v1'
    || source.iterations !== 3 || !Array.isArray(source.singleTurnScenarios)
    || source.singleTurnScenarios.length !== 8 || source.multiTurn?.sessions?.length !== 3) {
    throw new Error('Scenario set does not match the V1 fixed benchmark contract.');
  }
  const ids = source.singleTurnScenarios.map(({ id }) => id);
  if (ids.some((id) => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) {
    throw new Error('Scenario set contains missing or duplicate scenario ids.');
  }
  if (source.singleTurnScenarios.some(({ prompt, checks }) => typeof prompt !== 'string' || !prompt.trim() || !Array.isArray(checks))) {
    throw new Error('Scenario set contains an invalid prompt or check list.');
  }
  return source;
}

export function evaluateScenario(checks, text, expectedCode) {
  const value = typeof text === 'string' ? text.trim() : '';
  const flags = {};
  for (const check of checks) {
    if (check === 'nonEmpty') flags.nonEmpty = value.length > 0;
    else if (check === 'spanish') flags.languageCorrect = /\b(el|la|los|las|de|que|puedes|asistente|tarea|ayuda|organizar|para|una|es)\b/iu.test(value);
    else if (check === 'oneSentence') flags.instructionFollowing = value.length > 0 && value.split(/[.!?]+/u).filter((part) => part.trim()).length <= 1;
    else if (check === 'threeNumberedLines') flags.instructionFollowing = (value.match(/^\s*[1-3][.)]\s+\S.*$/gmu) ?? []).length === 3;
    else if (check === 'codeIsEven') flags.semanticRelevance = /isEven/u.test(value) && /%\s*2/u.test(value) && /===?\s*0/u.test(value) && /boolean/u.test(value);
    else if (check === 'debugStringAccumulator') flags.semanticRelevance = /(string|cadena|texto)/iu.test(value) && /(number|n[uú]mero)/iu.test(value) && /(reduce|acumulador|inicial)/iu.test(value) && /(['"]0['"]|\b0\s*[,;)])/u.test(value);
    else if (check === 'exactJson') {
      try {
        const parsed = JSON.parse(value);
        flags.formatCorrect = Object.keys(parsed).length === 2 && parsed.status === 'ok' && parsed.count === 3;
      } catch { flags.formatCorrect = false; }
    } else if (check === 'preserveTechnicalTerms') {
      flags.entityPreservation = ['Spring Boot', 'QueryDSL', 'GitHub', 'VS Code', 'streaming'].every((term) => value.includes(term));
    } else if (check === 'asksForTime') flags.instructionFollowing = /\?/u.test(value) && /(hora|horario)/iu.test(value);
    else if (check === 'noActionClaim') flags.noActionClaim = !/(ya (lo )?(guard[eé]|program[eé])|recordatorio (creado|guardado)|he (guardado|programado))/iu.test(value);
    else if (check === 'twoParagraphs') flags.formatCorrect = value.split(/\n\s*\n/u).filter((part) => part.trim()).length === 2;
    else if (check === 'recallsSessionCode') flags.contextCorrect = typeof expectedCode === 'string' && value.includes(expectedCode);
    else flags[`unknown_${check}`] = null;
  }
  const evaluated = Object.values(flags).filter((flag) => typeof flag === 'boolean');
  const pass = evaluated.length > 0 && evaluated.every(Boolean);
  return { flags, pass };
}

export function warmupGate(warmupResult) {
  if (warmupResult?.success) return { ready: true };
  return { ready: false, reason: warmupResult?.errorCategory ? `WARMUP_FAILED_${warmupResult.errorCategory}` : 'WARMUP_FAILED' };
}

export function percentile(values, quantile) {
  if (!values.length) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(quantile * sorted.length) - 1)];
}

function stats(values) {
  if (!values.length) return { min: undefined, median: undefined, mean: undefined, p90: undefined, max: undefined };
  return {
    min: Math.min(...values),
    median: percentile(values, 0.5),
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
    p90: percentile(values, 0.9),
    max: Math.max(...values),
  };
}

export function summarizeBenchmark(profiles, records) {
  return profiles.map((profile) => {
    const rows = records.filter((record) => record.profile === profile && record.kind === 'evaluation');
    const success = rows.filter((record) => record.success);
    const ttft = rows.map((record) => record.ttftMs).filter(Number.isFinite);
    const totals = rows.map((record) => record.totalMs).filter(Number.isFinite);
    const qualities = new Map();
    const repetitions = new Map();
    for (const row of rows) {
      if (!row.category) continue;
      const category = qualities.get(row.category) ?? { pass: 0, fail: 0, notEvaluated: 0 };
      if (!row.quality) category.notEvaluated += 1;
      else category[row.quality.pass ? 'pass' : 'fail'] += 1;
      qualities.set(row.category, category);
      if (row.scenarioId) {
        const key = `${row.scenarioId}:turn-${row.turn ?? 1}`;
        const samples = repetitions.get(key) ?? { latencyMs: [], qualityPasses: 0, qualityEvaluations: 0 };
        if (Number.isFinite(row.totalMs)) samples.latencyMs.push(row.totalMs);
        if (row.quality) {
          samples.qualityEvaluations += 1;
          if (row.quality.pass) samples.qualityPasses += 1;
        }
        repetitions.set(key, samples);
      }
    }
    return {
      profile,
      model: success.find((row) => row.model)?.model,
      attempts: rows.length,
      successful: success.length,
      failures: rows.length - success.length,
      successRate: rows.length ? success.length / rows.length : 0,
      timeouts: rows.filter((row) => row.errorCategory === 'TIMEOUT').length,
      rateLimits: rows.filter((row) => row.errorCategory === 'HTTP_429').length,
      errors: rows.filter((row) => !row.success).reduce((result, row) => ({ ...result, [row.errorCategory ?? 'UNKNOWN']: (result[row.errorCategory ?? 'UNKNOWN'] ?? 0) + 1 }), {}),
      ttftMs: stats(ttft),
      totalMs: stats(totals),
      streaming: {
        medianDeltaCount: percentile(success.map((row) => row.deltaCount).filter(Number.isFinite), 0.5),
        multiDeltaRate: success.length ? success.filter((row) => row.deltaCount > 1).length / success.length : 0,
      },
      qualityByCategory: Object.fromEntries(qualities),
      repeatConsistency: Object.fromEntries([...repetitions].map(([key, samples]) => [key, {
        latencySpreadMs: samples.latencyMs.length ? Math.max(...samples.latencyMs) - Math.min(...samples.latencyMs) : undefined,
        qualityPasses: samples.qualityPasses,
        qualityEvaluations: samples.qualityEvaluations,
      }])),
    };
  });
}

export function resolveBenchmarkConfig(profile, env, modelOverride) {
  const prefix = profile.toUpperCase();
  const key = profile === 'omniroute' ? (env.OMNIROUTE_API_KEY || env.AI_API_KEY) : env[`${prefix}_API_KEY`];
  const baseURL = profile === 'omniroute'
    ? (env.OMNIROUTE_BASE_URL || env.AI_BASE_URL || 'http://localhost:20128/v1')
    : (env[`${prefix}_BASE_URL`] || (profile === 'groq' ? 'https://api.groq.com/openai/v1' : 'https://generativelanguage.googleapis.com/v1beta/openai'));
  const model = modelOverride ?? (profile === 'omniroute' ? (env.OMNIROUTE_MODEL || env.AI_MODEL) : env[`${prefix}_MODEL`]);
  let url;
  try { url = new URL(baseURL); } catch { return { profile, blockedReason: 'INVALID_BASE_URL' }; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return { profile, blockedReason: 'INVALID_BASE_URL' };
  if (typeof model !== 'string' || !model.trim()) return { profile, blockedReason: 'MODEL_NOT_CONFIGURED' };
  const keyValue = typeof key === 'string' ? key.trim() : '';
  if (!keyValue) return { profile, blockedReason: 'CREDENTIAL_MISSING' };
  return { profile, apiKey: keyValue, baseURL: url.toString().replace(/\/$/u, ''), baseHost: url.host, model: model.trim() };
}

export function redactRecord(record) {
  const forbidden = /(?:api[_-]?key|authorization|cookie|secret|token)/iu;
  const visit = (value) => {
    if (Array.isArray(value)) return value.map(visit);
    if (value && typeof value === 'object') {
      const output = {};
      for (const [key, entry] of Object.entries(value)) {
        if (forbidden.test(key)) continue;
        output[key] = visit(entry);
      }
      return output;
    }
    return value;
  };
  return visit(record);
}
