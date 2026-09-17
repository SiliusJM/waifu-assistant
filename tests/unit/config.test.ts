import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../../src/config/config.js';
import { AssistantError } from '../../src/shared/errors.js';

test('configuration defaults to mock without credentials', () => {
  const config = loadConfig({});
  assert.equal(config.ai.provider, 'mock');
  assert.equal(config.ai.model, 'mock-model');
  assert.equal(config.ai.apiKey, '');
});

test('direct configuration requires endpoint, key and model', () => {
  assert.throws(
    () => loadConfig({ AI_PROVIDER: 'direct' }),
    (error: unknown) => error instanceof AssistantError
      && error.code === 'CONFIGURATION_ERROR',
  );
});
