import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../../src/config/config.js';
import { createAIProvider } from '../../src/config/provider-factory.js';
import { AssistantError } from '../../src/shared/errors.js';
import { inspect } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { PROVIDER_PROFILES } from '../../src/config/provider-profiles.js';
import { formatProviderStatus, toSafeProviderConfig } from '../../src/config/provider-config.js';
import { createLogger } from '../../src/shared/logger.js';

test('configuration defaults to mock without credentials', () => {
  const config = loadConfig({});
  assert.equal(config.ai.provider, 'mock');
  assert.equal(config.ai.model, 'mock-model');
  assert.equal(config.ai.apiKey, '');
});

test('explicit mock configuration selects MockAIProvider', () => {
  assert.equal(createAIProvider(loadConfig({ AI_PROVIDER: 'mock' })).name, 'mock');
});

test('direct configuration requires endpoint, key and model', () => {
  assert.throws(
    () => loadConfig({ AI_PROVIDER: 'direct' }),
    (error: unknown) => error instanceof AssistantError
      && error.code === 'CONFIGURATION_ERROR',
  );
});

test('direct configuration selects the existing DirectAIProvider', () => {
  const provider = createAIProvider(loadConfig({
    AI_PROVIDER: 'direct',
    AI_BASE_URL: 'https://example.invalid/v1',
    AI_API_KEY: 'test-key',
    AI_MODEL: 'test-model',
  }));
  assert.equal(provider.name, 'direct-http');
});

for (const profile of PROVIDER_PROFILES) {
  test(`${profile.id} profile resolves independently and uses the common factory offline`, async (t) => {
    const secret = `fixture-${profile.id}-credential`;
    const env: NodeJS.ProcessEnv = {
      AI_PROVIDER_PROFILE: profile.id,
      AI_PROVIDER: 'invalid-ignored', AI_BASE_URL: 'invalid-ignored', AI_MODEL: 'ignored', AI_API_KEY: 'ignored',
      [profile.modelEnvName]: 'model-A', [profile.credentialEnvName]: secret,
      AI_TIMEOUT_MS: '30000',
    };
    const isolated = new Proxy(env, {
      get(target, key: string) {
        if (key.endsWith('_API_KEY') && key !== profile.credentialEnvName) throw new Error('Cross-profile credential access.');
        return target[key];
      },
    });
    const config = loadConfig(isolated);
    assert.equal(config.ai.profileId, profile.id);
    assert.equal(config.ai.baseURL, profile.baseURL);
    assert.equal(config.ai.model, 'model-A');
    assert.equal(config.ai.timeoutMs, 30000);
    assert.ok(config.ai.apiKey === secret);
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async (input: string, init: RequestInit) => {
      calls += 1;
      assert.equal(input, profile.baseURL + '/chat/completions');
      assert.ok(new Headers(init.headers).get('Authorization') === `Bearer ${secret}`);
      return new Response(JSON.stringify({ model: 'model-A', choices: [{ message: { content: 'offline OK' }, finish_reason: 'stop' }] }));
    });
    const provider = createAIProvider(config);
    assert.equal(provider.name, 'direct-http');
    const response = await provider.complete({ sessionId: 'offline', messages: [{ role: 'user', content: 'fixture' }] });
    assert.equal(response.text, 'offline OK');
    assert.equal(calls, 1);
    const overridden = loadConfig({ ...env, [profile.modelEnvName]: 'model-B', [profile.baseURLEnvName]: 'https://proxy.invalid/v1' });
    assert.equal(overridden.ai.model, 'model-B');
    assert.equal(overridden.ai.baseURL, 'https://proxy.invalid/v1');
    for (const field of [profile.modelEnvName, profile.credentialEnvName]) {
      assert.throws(() => loadConfig({ ...env, [field]: '' }),
        (error: unknown) => error instanceof AssistantError && error.code === 'CONFIGURATION_ERROR');
    }
  });
}

test('profiles fail closed for incomplete or invalid configuration without legacy fallback', () => {
  const complete = { AI_PROVIDER_PROFILE: 'groq', GROQ_MODEL: 'model', GROQ_API_KEY: 'fixture-key' };
  const legacy = { AI_PROVIDER: 'direct', AI_BASE_URL: 'https://legacy.invalid/v1', AI_MODEL: 'legacy', AI_API_KEY: 'legacy-fixture' };
  const invalid: NodeJS.ProcessEnv[] = [
    { ...legacy, AI_PROVIDER_PROFILE: 'foobar' },
    { ...legacy, AI_PROVIDER_PROFILE: 'groq', GROQ_API_KEY: 'fixture' },
    { ...legacy, AI_PROVIDER_PROFILE: 'groq', GROQ_MODEL: 'model' },
    ...['file:///tmp', 'bad-url', 'https://user:pass@example.invalid', 'https://example.invalid?token=fixture', 'https://example.invalid/#fragment']
      .map((baseURL) => ({ ...complete, GROQ_BASE_URL: baseURL })),
    ...['0', '-1', 'NaN', 'Infinity', '1.5', ''].map((timeout) => ({ ...complete, AI_TIMEOUT_MS: timeout })),
  ];
  for (const env of invalid) assert.throws(() => loadConfig(env),
    (error: unknown) => error instanceof AssistantError && error.code === 'CONFIGURATION_ERROR');
});

test('profiles and resolved configuration are safe for JSON, inspection, status and logs', () => {
  for (const secret of ['sk-super-secret', 'AIza-secret', 'or-secret-value']) {
    const config = loadConfig({ AI_PROVIDER_PROFILE: 'openrouter', OPENROUTER_MODEL: 'public/model', OPENROUTER_API_KEY: secret });
    const lines: string[] = [];
    createLogger({ sink: { info: (line) => { lines.push(line); } } }).info('configuration', { config });
    const output = [JSON.stringify(config), JSON.stringify({ ...config.ai }), inspect(config, { showHidden: true }),
      JSON.stringify(toSafeProviderConfig(config.ai)), formatProviderStatus(config.ai).join('\n'), ...lines].join('\n');
    assert.ok(!output.includes(secret));
    assert.equal(toSafeProviderConfig(config.ai).credentialConfigured, true);
    assert.ok(!Object.keys(config.ai).includes('apiKey'));
    assert.ok(!JSON.stringify(PROVIDER_PROFILES).includes(secret));
    for (const metadata of [{ OPENROUTER_MODEL: secret }, { OPENROUTER_BASE_URL: `https://example.invalid/${secret}` }]) {
      assert.throws(() => loadConfig({ AI_PROVIDER_PROFILE: 'openrouter', OPENROUTER_MODEL: 'public/model',
        OPENROUTER_API_KEY: secret, ...metadata }),
      (error: unknown) => error instanceof AssistantError && !inspect(error).includes(secret));
    }
  }
  assert.deepEqual(PROVIDER_PROFILES.map(({ id }) => id), ['omniroute', 'groq', 'gemini', 'openrouter']);
  assert.ok(PROVIDER_PROFILES.every(Object.isFrozen));
});

test('custom credential resolution is injectable and its failures cannot expose secrets', () => {
  const env = { AI_PROVIDER_PROFILE: 'gemini', GEMINI_MODEL: 'configured-model' };
  const config = loadConfig(env, { resolve(reference) {
    assert.equal(reference.credentialEnvName, 'GEMINI_API_KEY');
    return 'fixture-in-memory';
  } });
  assert.ok(config.ai.apiKey === 'fixture-in-memory');
  const secret = 'AIza-secret';
  assert.throws(() => loadConfig(env, { resolve() { throw new Error(secret); } }),
    (error: unknown) => error instanceof AssistantError && error.code === 'CONFIGURATION_ERROR'
      && !inspect(error).includes(secret));
});

test('empty profile preserves legacy selection, retry settings and credential-free mock', () => {
  const config = loadConfig({ AI_PROVIDER_PROFILE: '', AI_PROVIDER: 'direct', AI_BASE_URL: 'http://localhost:20128/v1',
    AI_API_KEY: 'fixture-key', AI_MODEL: 'configured-model', AI_TIMEOUT_MS: '30000', AI_MAX_ATTEMPTS: '1' });
  assert.equal(config.ai.profileId, undefined);
  assert.equal(config.ai.timeoutMs, 30000);
  assert.equal(config.ai.retryPolicy.maxAttempts, 1);
  assert.equal(createAIProvider(config).name, 'direct-http');
  const mock = loadConfig({}, { resolve() { throw new Error('Must not resolve credentials for mock.'); } });
  assert.equal(createAIProvider(mock).name, 'mock');
  assert.equal(toSafeProviderConfig(mock.ai).credentialConfigured, false);
});

test('interactive status exposes profile metadata safely and exits without inference', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'yuki-profile-status-'));
  try {
    for (const profile of ['groq', 'legacy-direct', '']) {
      const isDirect = profile !== '';
      const output = execFileSync(process.execPath, ['dist/main.js', '--interactive'], {
        input: '/status\n/exit\n', encoding: 'utf8', timeout: 5000,
        env: { AI_PROVIDER_PROFILE: profile === 'groq' ? 'groq' : '',
          AI_PROVIDER: profile === 'legacy-direct' ? 'direct' : 'mock',
          AI_BASE_URL: 'https://example.invalid/v1', AI_MODEL: isDirect ? 'public-model' : '', AI_API_KEY: 'sk-super-secret',
          GROQ_MODEL: 'public-model', GROQ_API_KEY: 'sk-super-secret',
          YUKI_MEMORY_PATH: join(directory, 'memory.json'), YUKI_SESSIONS_PATH: join(directory, 'sessions.json') },
      });
      assert.ok(output.includes(profile === 'groq' ? 'Perfil: groq' : 'Perfil: legacy'));
      assert.ok(output.includes(isDirect ? 'Proveedor: direct' : 'Proveedor: mock'));
      assert.ok(output.includes(isDirect ? 'Modelo: public-model' : 'Modelo: mock-model'));
      assert.ok(output.includes(isDirect ? 'Credencial configurada: YES' : 'Credencial configurada: NO'));
      assert.ok(!output.includes('sk-super-secret'));
      assert.ok(!output.includes('AI request started'));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
