import assert from 'node:assert/strict';
import test from 'node:test';
import { createApplication } from '../../dist/core/application.mjs';

test('application starts and stops idempotently', () => {
  const events = [];
  const logger = {
    info(message, context) {
      events.push({ message, context });
    },
  };
  const application = createApplication({ logger });

  assert.equal(application.getState(), 'idle');
  assert.equal(application.start(), 'running');
  assert.equal(application.start(), 'running');
  assert.equal(application.stop(), 'stopped');
  assert.equal(application.stop(), 'stopped');
  assert.deepEqual(events.map(({ message }) => message), [
    'Application started',
    'Application stopped',
  ]);
});
