import assert from 'node:assert/strict';
import test from 'node:test';
import { AssistantCore } from '../../src/core/assistant-core.js';
import { MockAIProvider } from '../../src/ai/mock-ai-provider.js';

test('assistant core converts text input into a session response', async () => {
  const provider = new MockAIProvider({ responseText: 'Hello from the mock.' });
  const core = new AssistantCore({ provider });
  const session = core.createSession();

  const response = await core.respond(session, '  Hello assistant  ');

  assert.equal(response.text, 'Hello from the mock.');
  assert.equal(response.provider, 'mock');
  assert.equal(response.finishReason, 'stop');
  assert.deepEqual(session.getMessages().map(({ role, content }) => ({ role, content })), [
    { role: 'user', content: 'Hello assistant' },
    { role: 'assistant', content: 'Hello from the mock.' },
  ]);
});

test('assistant core rejects empty input', async () => {
  const core = new AssistantCore({ provider: new MockAIProvider() });
  await assert.rejects(
    () => core.respond(core.createSession(), '   '),
    (error: unknown) => error instanceof Error
      && 'code' in error
      && error.code === 'VALIDATION_ERROR',
  );
});

test('mock provider exposes the streaming-compatible contract', async () => {
  const provider = new MockAIProvider({ responseText: 'stream-compatible' });
  const events = [];
  for await (const event of provider.stream({
    sessionId: 'stream-test',
    messages: [{ role: 'user', content: 'Hello' }],
  })) {
    events.push(event);
  }

  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, 'completed');
});
