import assert from 'node:assert/strict';
import test from 'node:test';
import { createContext } from '../../src/core/context.js';
import { Session } from '../../src/core/session.js';

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
