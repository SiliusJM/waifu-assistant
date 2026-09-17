import assert from 'node:assert/strict';
import test from 'node:test';
import { createApplication } from '../../src/core/application.js';

test('application starts and stops idempotently', () => {
  const events: string[] = [];
  const logger = {
    info(message: string): void {
      events.push(message);
    },
    warn(): void {},
    error(): void {},
  };
  const application = createApplication({ logger });

  assert.equal(application.getState(), 'idle');
  assert.equal(application.start(), 'running');
  assert.equal(application.start(), 'running');
  assert.equal(application.stop(), 'stopped');
  assert.equal(application.stop(), 'stopped');
  assert.deepEqual(events, ['Application started', 'Application stopped']);
});
