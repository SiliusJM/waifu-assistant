import assert from 'node:assert/strict';
import test from 'node:test';
import { createLogger } from '../../dist/shared/logger.mjs';

test('logger emits structured events and redacts sensitive keys', () => {
  const lines = [];
  const sink = {
    info(line) {
      lines.push(line);
    },
  };
  const logger = createLogger({ scope: 'test', sink });

  logger.info('safe event', {
    provider: 'direct',
    apiKey: 'must-not-appear',
    nested: { access_token: 'also-secret' },
  });

  assert.equal(lines.length, 1);
  const event = JSON.parse(lines[0]);
  assert.equal(event.scope, 'test');
  assert.equal(event.message, 'safe event');
  assert.equal(event.context.apiKey, '[REDACTED]');
  assert.equal(event.context.nested.access_token, '[REDACTED]');
  assert.equal(lines[0].includes('must-not-appear'), false);
});
