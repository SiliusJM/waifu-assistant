import assert from 'node:assert/strict';
import test from 'node:test';
import { createContext } from '../../src/core/context.js';
import { Session } from '../../src/core/session.js';
import { AssistantError } from '../../src/shared/errors.js';

test('session owns ordered in-memory messages and context is a snapshot', () => {
  const session = new Session('session-test');
  session.addMessage('user', 'Hello');
  session.addMessage('assistant', 'Hi');

  const context = createContext(session);
  assert.equal(context.sessionId, 'session-test');
  assert.deepEqual(context.messages.map(({ role, content }) => ({ role, content })), [
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: 'Hi' },
  ]);

  session.clear();
  assert.equal(session.getMessages().length, 0);
  assert.equal(context.messages.length, 2);
});

test('session restore replaces content, preserves order and creates fresh message ids', () => {
  const session = new Session('restore-test');
  session.addMessage('user', 'old');
  const oldId = session.getMessages()[0]?.id;

  session.restoreMessages([
    { role: 'user', content: 'loaded user' },
    { role: 'assistant', content: 'loaded assistant' },
  ]);

  assert.deepEqual(session.getMessages().map(({ role, content }) => ({ role, content })), [
    { role: 'user', content: 'loaded user' },
    { role: 'assistant', content: 'loaded assistant' },
  ]);
  assert.notEqual(session.getMessages()[0]?.id, oldId);
  assert.throws(() => session.restoreMessages([
    { role: 'user', content: 'valid' },
    { role: 'system' as 'user', content: 'privileged' },
  ]), (error: unknown) => error instanceof AssistantError && error.code === 'SESSION_CORRUPT_ERROR');
  assert.deepEqual(session.getMessages().map(({ content }) => content), ['loaded user', 'loaded assistant']);
});
