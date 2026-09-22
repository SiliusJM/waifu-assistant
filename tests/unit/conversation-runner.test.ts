import assert from 'node:assert/strict';
import test from 'node:test';
import { MockAIProvider } from '../../src/ai/mock-ai-provider.js';
import { AssistantCore } from '../../src/core/assistant-core.js';
import { ConversationRunner, LOCAL_COMMAND_HELP } from '../../src/core/conversation-runner.js';
import { Session } from '../../src/core/session.js';
import { DEFAULT_PERSONALITY_PROFILE } from '../../src/personality/default-profile.js';
import { PersonalityCompiler } from '../../src/personality/personality-compiler.js';
import { PersonalityRegistry } from '../../src/personality/personality-registry.js';
import {
  createLocalToolManager,
  executeLocalCalculation,
  executeLocalTime,
  formatLocalTime,
} from '../../src/tools/local-tool-manager.js';

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

test('conversation runner reuses one compiled default personality snapshot across turns', async () => {
  const requests: Array<{ messages: readonly { role: string; content: string }[] }> = [];
  const provider = new MockAIProvider({
    responder: (request) => {
      requests.push(request);
      return { text: 'ok', provider: 'mock', model: 'mock-model', finishReason: 'stop' };
    },
  });
  const snapshot = new PersonalityCompiler().compile({ profile: new PersonalityRegistry().defaultProfile });
  const runner = new ConversationRunner(new AssistantCore({ provider }));
  const result = await runner.run(inputs(['one', 'two']), { personality: snapshot });

  assert.equal(result.status, 'completed');
  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.messages[0]?.content, snapshot.instructions[0]?.text);
  assert.equal(requests[1]?.messages[0]?.content, snapshot.instructions[0]?.text);
  assert.equal(requests[0]?.messages.filter(({ role }) => role === 'system').length, snapshot.instructions.length);
  assert.equal(requests[1]?.messages.filter(({ role }) => role === 'system').length, snapshot.instructions.length);
  assert.equal(snapshot.personalityId, DEFAULT_PERSONALITY_PROFILE.personalityId);
  assert.equal(snapshot.identity.displayName, 'Yuki');
  assert.ok(Object.isFrozen(snapshot));
  assert.deepEqual(result.session.getMessages().map(({ role }) => role), ['user', 'assistant', 'user', 'assistant']);
});

test('default personality registry and compiler produce one immutable application snapshot', () => {
  const registry = new PersonalityRegistry();
  const snapshot = new PersonalityCompiler().compile({ profile: registry.defaultProfile });

  assert.equal(snapshot.personalityId, DEFAULT_PERSONALITY_PROFILE.personalityId);
  assert.equal(snapshot.profileVersion, DEFAULT_PERSONALITY_PROFILE.profileVersion);
  assert.equal(snapshot.identity.displayName, 'Yuki');
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.instructions));
  assert.throws(() => {
    (snapshot.instructions as unknown as { push: (value: unknown) => void }).push({});
  }, TypeError);
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

test('local help is deterministic, does not call the provider or change Session', async () => {
  let providerCalls = 0;
  const provider = new MockAIProvider({
    responder: () => {
      providerCalls += 1;
      return { text: 'ok', provider: 'mock', model: 'mock-model', finishReason: 'stop' };
    },
  });
  const outputs: string[] = [];
  const runner = new ConversationRunner(new AssistantCore({ provider }));
  const result = await runner.run(inputs(['message A', '/help', 'message B', '/exit']), {
    onCommand: async (command) => {
      assert.equal(command, '/help');
      outputs.push(LOCAL_COMMAND_HELP);
    },
  });

  assert.equal(result.status, 'completed');
  assert.equal(providerCalls, 2);
  assert.deepEqual(outputs, [LOCAL_COMMAND_HELP]);
  assert.deepEqual(result.session.getMessages().map(({ content }) => content), ['message A', 'ok', 'message B', 'ok']);
});

test('local command without a handler reports a generic unavailable error', async () => {
  const runner = new ConversationRunner(new AssistantCore({ provider: new MockAIProvider() }));

  await assert.rejects(() => runner.run(inputs(['/help'])), (error: unknown) => (
    error instanceof Error
    && error.message === 'The local command is unavailable.'
    && 'code' in error
    && error.code === 'TOOL_UNAVAILABLE_ERROR'
  ));
});

test('explicit /time uses ToolManager without calling the provider or changing Session', async () => {
  let providerCalls = 0;
  const requests: string[][] = [];
  const provider = new MockAIProvider({
    responder: (request) => {
      providerCalls += 1;
      requests.push(request.messages.map(({ content }) => content));
      return { text: `reply-${providerCalls}`, provider: 'mock', model: 'mock-model', finishReason: 'stop' };
    },
  });
  const manager = createLocalToolManager(() => new Date('2026-09-22T18:30:04.000Z'));
  const output: string[] = [];
  const runner = new ConversationRunner(new AssistantCore({ provider }));

  const result = await runner.run(inputs(['message A', '/time', 'message B']), {
    onCommand: async (_command, context) => {
      const timeResult = await executeLocalTime(manager, context);
      assert.equal(timeResult.status, 'success');
      if (timeResult.status === 'success') output.push(formatLocalTime(timeResult.value));
    },
  });

  assert.equal(result.status, 'completed');
  assert.equal(providerCalls, 2);
  assert.equal(output.length, 1);
  assert.match(output[0] ?? '', /^Hora local:/);
  assert.deepEqual(result.session.getMessages().map(({ role, content }) => ({ role, content })), [
    { role: 'user', content: 'message A' },
    { role: 'assistant', content: 'reply-1' },
    { role: 'user', content: 'message B' },
    { role: 'assistant', content: 'reply-2' },
  ]);
  assert.equal(requests[1]?.includes('/time'), false);
  assert.equal(requests[1]?.includes(output[0] ?? ''), false);
  assert.equal(requests[1]?.includes('message A'), true);
});

test('explicit /calc uses ToolManager without calling the provider or changing Session', async () => {
  let providerCalls = 0;
  const requests: string[][] = [];
  const provider = new MockAIProvider({
    responder: (request) => {
      providerCalls += 1;
      requests.push(request.messages.map(({ content }) => content));
      return { text: `reply-${providerCalls}`, provider: 'mock', model: 'mock-model', finishReason: 'stop' };
    },
  });
  const manager = createLocalToolManager();
  const runner = new ConversationRunner(new AssistantCore({ provider }));
  const results: string[] = [];

  const result = await runner.run(inputs(['message A', '/calc 2 + 2', 'message B']), {
    onCommand: async (command, context) => {
      const calculation = await executeLocalCalculation(manager, command.slice('/calc'.length).trim(), context);
      assert.equal(calculation.status, 'success');
      if (calculation.status === 'success') results.push(String(calculation.value.result));
    },
  });

  assert.equal(result.status, 'completed');
  assert.equal(providerCalls, 2);
  assert.deepEqual(results, ['4']);
  assert.equal(requests[1]?.includes('/calc 2 + 2'), false);
  assert.equal(requests[1]?.includes('4'), false);
  assert.equal(requests[1]?.includes('message A'), true);
  assert.deepEqual(result.session.getMessages().map(({ content }) => content), [
    'message A', 'reply-1', 'message B', 'reply-2',
  ]);
});

test('local commands can coexist without entering Session and exit cleanly', async () => {
  let providerCalls = 0;
  const provider = new MockAIProvider({
    responder: () => {
      providerCalls += 1;
      return { text: 'reply', provider: 'mock', model: 'mock-model', finishReason: 'stop' };
    },
  });
  const manager = createLocalToolManager();
  const runner = new ConversationRunner(new AssistantCore({ provider }));
  const outputs: string[] = [];

  const result = await runner.run(inputs(['message A', '/time', '/calc 2 + 2', '/help', 'message B', '/exit']), {
    onCommand: async (command, context) => {
      if (command === '/time') {
        const time = await executeLocalTime(manager, context);
        if (time.status === 'success') outputs.push(formatLocalTime(time.value));
      } else if (command === '/calc 2 + 2') {
        const calculation = await executeLocalCalculation(manager, '2 + 2', context);
        if (calculation.status === 'success') outputs.push(String(calculation.value.result));
      } else {
        outputs.push(LOCAL_COMMAND_HELP);
      }
    },
  });

  assert.equal(result.status, 'completed');
  assert.equal(providerCalls, 2);
  assert.equal(outputs.length, 3);
  assert.deepEqual(result.session.getMessages().map(({ content }) => content), ['message A', 'reply', 'message B', 'reply']);
});

test('session status and history commands are local and do not call the provider', async () => {
  let providerCalls = 0;
  const provider = new MockAIProvider({
    responder: () => {
      providerCalls += 1;
      return { text: 'reply', provider: 'mock', model: 'mock-model', finishReason: 'stop' };
    },
  });
  const runner = new ConversationRunner(new AssistantCore({ provider }));
  const outputs: string[] = [];

  const result = await runner.run(inputs(['/status', 'message A', '/history', '/exit']), {
    onCommand: async (command) => {
      if (command === '/status') outputs.push(`Messages: ${runner.session.getMessages().length}`);
      if (command === '/history') outputs.push(runner.session.getMessages().map(({ role, content }) => `${role}: ${content}`).join('\n'));
    },
  });

  assert.equal(result.status, 'completed');
  assert.equal(providerCalls, 1);
  assert.deepEqual(outputs, ['Messages: 0', 'user: message A\nassistant: reply']);
});

test('clear command resets only the current in-memory Session', async () => {
  let providerCalls = 0;
  const requests: string[][] = [];
  const provider = new MockAIProvider({
    responder: (request) => {
      providerCalls += 1;
      requests.push(request.messages.map(({ content }) => content));
      return { text: `reply-${providerCalls}`, provider: 'mock', model: 'mock-model', finishReason: 'stop' };
    },
  });
  const runner = new ConversationRunner(new AssistantCore({ provider }));

  const result = await runner.run(inputs(['message A', '/clear', '/status', 'message B']), {
    onCommand: async (command) => {
      if (command === '/clear') runner.session.clear();
      if (command === '/status') assert.equal(runner.session.getMessages().length, 0);
    },
  });

  assert.equal(result.status, 'completed');
  assert.equal(providerCalls, 2);
  assert.deepEqual(requests[1], ['message B']);
  assert.deepEqual(runner.session.getMessages().map(({ content }) => content), ['message B', 'reply-2']);
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
