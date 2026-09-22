import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../../src/config/config.js';
import { createAIProvider } from '../../src/config/provider-factory.js';
import { AssistantError } from '../../src/shared/errors.js';

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
