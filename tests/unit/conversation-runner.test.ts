import assert from 'node:assert/strict';
import test from 'node:test';
import { MockAIProvider } from '../../src/ai/mock-ai-provider.js';
import { AssistantCore } from '../../src/core/assistant-core.js';
import { ConversationRunner } from '../../src/core/conversation-runner.js';
import { Session } from '../../src/core/session.js';

async function* inputs(values: readonly string[]): AsyncIterable<string> {
  yield* values;
}

test('conversation runner completes one turn through AssistantCore', async () => {
  const runner = new ConversationRunner(new AssistantCore({ provider: new MockAIProvider({ responseText: 'hello' }) }));
  const result = await runner.run(inputs(['Hi', '/exit']));

  assert.equal(result.status, 'completed');
  assert.equal(result.responses.length, 1);
  assert.equal(result.responses[0]?.text, 'hello');
  assert.deepEqual(result.session.getMessages().map(({ role, content }) => ({ role, content })), [
    { role: 'user', content: 'Hi' },
    { role: 'assistant', content: 'hello' },
  ]);
});

test('conversation runner reuses one session and preserves multi-turn order', async () => {
  const provider = new MockAIProvider({
    responder: (request) => ({
      text: `messages=${request.messages.length}`,
      provider: 'mock',
      model: 'mock-model',
      finishReason: 'stop',
    }),
  });
  const session = new Session('conversation-test');
  const runner = new ConversationRunner(new AssistantCore({ provider }), session);
  const result = await runner.run(inputs(['one', 'two']));

  assert.equal(result.session, session);
  assert.deepEqual(result.responses.map(({ text }) => text), ['messages=1', 'messages=3']);
  assert.deepEqual(session.getMessages().map(({ role, content }) => ({ role, content })), [
    { role: 'user', content: 'one' },
    { role: 'assistant', content: 'messages=1' },
    { role: 'user', content: 'two' },
    { role: 'assistant', content: 'messages=3' },
  ]);
});

test('conversation runner supports EOF, explicit exit and empty input without extra turns', async () => {
  const calls: string[] = [];
  const core = new AssistantCore({
    provider: new MockAIProvider({
      responder: (request) => {
        calls.push(request.messages.at(-1)?.content ?? '');
        return { text: 'ok', provider: 'mock', model: 'mock-model', finishReason: 'stop' };
      },
    }),
  });
  const runner = new ConversationRunner(core);
  const result = await runner.run(inputs(['  ', 'accepted', '/exit', 'ignored']));

  assert.equal(result.status, 'completed');
  assert.deepEqual(calls, ['accepted']);
});

test('conversation runner cancels while waiting for input and closes the source', async () => {
  const controller = new AbortController();
  let closed = false;
  const pending: AsyncIterable<string> = {
    [Symbol.asyncIterator]() {
      return {
        next: () => new Promise<IteratorResult<string>>(() => {}),
        return: async () => {
          closed = true;
          return { done: true, value: undefined } as IteratorReturnResult<undefined>;
        },
      };
    },
  };
  const promise = new ConversationRunner(new AssistantCore({ provider: new MockAIProvider() })).run(pending, {
    signal: controller.signal,
  });
  controller.abort();
  const result = await promise;

  assert.equal(result.status, 'cancelled');
  assert.equal(closed, true);
  assert.equal(result.session.getMessages().length, 0);
});

test('conversation runner propagates provider errors without destroying the session', async () => {
  const session = new Session('error-test');
  const runner = new ConversationRunner(new AssistantCore({
    provider: new MockAIProvider({ responder: () => { throw new Error('provider failure'); } }),
  }), session);

  await assert.rejects(() => runner.run(inputs(['hello'])), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'PROVIDER_ERROR');
  assert.deepEqual(session.getMessages().map(({ role, content }) => ({ role, content })), [
    { role: 'user', content: 'hello' },
  ]);
});
