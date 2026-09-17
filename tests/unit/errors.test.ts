import assert from 'node:assert/strict';
import test from 'node:test';
import { AssistantError, toAssistantError } from '../../src/shared/errors.js';

test('assistant errors preserve category and retry policy', () => {
  const error = new AssistantError('rate limited', {
    code: 'RATE_LIMIT_ERROR',
    retryable: true,
    statusCode: 429,
  });
  assert.equal(error.code, 'RATE_LIMIT_ERROR');
  assert.equal(error.retryable, true);
  assert.equal(error.statusCode, 429);
  assert.equal(toAssistantError(error), error);
});

test('unknown errors are categorized without exposing their contents', () => {
  const error = toAssistantError(new Error('private provider detail'));
  assert.equal(error.code, 'PROVIDER_ERROR');
  assert.equal(error.retryable, false);
  assert.equal(error.message.includes('private provider detail'), false);
});
