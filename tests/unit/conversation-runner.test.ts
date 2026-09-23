import assert from 'node:assert/strict';
import test from 'node:test';
import type { AIProvider } from '../../src/ai/ai-provider.js';
import type { AIRequest, AIResponse, AIStreamEvent, ProviderCallOptions } from '../../src/ai/ai-types.js';
import { MockAIProvider } from '../../src/ai/mock-ai-provider.js';
import { AssistantCore } from '../../src/core/assistant-core.js';
import { ConversationRunner, LOCAL_COMMAND_HELP } from '../../src/core/conversation-runner.js';
import { Session } from '../../src/core/session.js';
import { DEFAULT_PERSONALITY_PROFILE } from '../../src/personality/default-profile.js';
import { PersonalityCompiler } from '../../src/personality/personality-compiler.js';
import { PersonalityRegistry } from '../../src/personality/personality-registry.js';
import type { MemorySnapshot } from '../../src/memory/memory-types.js';
import {
  createLocalToolManager,
  executeLocalCalculation,
  executeLocalTime,
  formatLocalTime,
} from '../../src/tools/local-tool-manager.js';

async function* inputs(values: readonly string[]): AsyncIterable<string> {
  yield* values;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

function interruptibleProvider(): AIProvider & { readonly firstStarted: Promise<void>; readonly calls: string[] } {
  const firstStarted = deferred<void>();
  const calls: string[] = [];
  const provider: AIProvider & { readonly firstStarted: Promise<void>; readonly calls: string[] } = {
    name: 'interruptible-test',
    firstStarted: firstStarted.promise,
    calls,
    complete: async (): Promise<AIResponse> => ({
      text: 'unused', provider: 'interruptible-test', model: 'test', finishReason: 'stop',
    }),
    async *stream(request: AIRequest, options?: ProviderCallOptions): AsyncIterable<AIStreamEvent> {
      const input = request.messages.at(-1)?.content;
      if (input) calls.push(input);
      if (input?.startsWith('A')) {
        yield { type: 'text_delta', delta: 'partial-A' };
        firstStarted.resolve();
        await new Promise<void>((resolve) => {
          if (options?.signal?.aborted) { resolve(); return; }
          options?.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        throw new Error('cancelled first turn');
      }
      yield { type: 'text_delta', delta: `answer-${input}` };
      yield {
        type: 'completed',
        response: { text: `answer-${input}`, provider: 'interruptible-test', model: 'test', finishReason: 'stop' },
      };
    },
  };
  return provider;
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
  assert.deepEqual(result.responses.map(({ text }) => text), ['messages=2', 'messages=4']);
  assert.deepEqual(session.getMessages().map(({ role, content }) => ({ role, content })), [
    { role: 'user', content: 'one' },
    { role: 'assistant', content: 'messages=2' },
    { role: 'user', content: 'two' },
    { role: 'assistant', content: 'messages=4' },
  ]);
});

test('conversation runner forwards streaming deltas and completes without duplicating text', async () => {
  const output: string[] = [];
  const runner = new ConversationRunner(new AssistantCore({
    provider: new MockAIProvider({ responseText: 'Hello Yuki', streamDeltas: ['Hello', ' ', 'Yuki'] }),
  }));
  const result = await runner.run(inputs(['hello', '/exit']), {
    onDelta: (delta) => { output.push(delta); },
  });

  assert.equal(output.join(''), 'Hello Yuki');
  assert.equal(result.responses[0]?.text, 'Hello Yuki');
  assert.deepEqual(result.session.getMessages().map(({ role, content }) => ({ role, content })), [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'Hello Yuki' },
  ]);
});

test('conversation runner cooperatively cancels an in-flight stream', async () => {
  const controller = new AbortController();
  const runner = new ConversationRunner(new AssistantCore({
    provider: new MockAIProvider({ responseText: 'late', streamDeltas: ['late'], streamDelayMs: 100 }),
  }));
  const pending = runner.run(inputs(['hello']), { signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  const result = await pending;

  assert.equal(result.status, 'cancelled');
  assert.deepEqual(result.session.getMessages().map(({ role, content }) => ({ role, content })), [
    { role: 'user', content: 'hello' },
  ]);
});

test('restored Session history is sent on the next conversational turn', async () => {
  let observedMessages: readonly { role: string; content: string }[] = [];
  const provider = new MockAIProvider({
    responder: (request) => {
      observedMessages = request.messages;
      return { text: 'context received', provider: 'mock', model: 'mock-model', finishReason: 'stop' };
    },
  });
  const session = new Session('restored-session');
  session.restoreMessages([
    { role: 'user', content: 'Mi palabra es ORION-731.' },
    { role: 'assistant', content: 'Entendido.' },
  ]);
  const runner = new ConversationRunner(new AssistantCore({ provider }), session);

  const result = await runner.run(inputs(['¿Cuál es mi palabra?']));

  assert.equal(result.responses[0]?.text, 'context received');
  assert.deepEqual(observedMessages.slice(-3).map(({ role, content }) => ({ role, content })), [
    { role: 'user', content: 'Mi palabra es ORION-731.' },
    { role: 'assistant', content: 'Entendido.' },
    { role: 'user', content: '¿Cuál es mi palabra?' },
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
  assert.equal(requests[0]?.messages.filter(({ role }) => role === 'system').length, snapshot.instructions.length + 1);
  assert.equal(requests[1]?.messages.filter(({ role }) => role === 'system').length, snapshot.instructions.length + 1);
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

test('saved-session commands stay local and do not call the provider or contaminate Session', async () => {
  let providerCalls = 0;
  const provider = new MockAIProvider({
    responder: () => {
      providerCalls += 1;
      return { text: 'reply', provider: 'mock', model: 'mock-model', finishReason: 'stop' };
    },
  });
  const runner = new ConversationRunner(new AssistantCore({ provider }));
  const commands: string[] = [];
  const result = await runner.run(inputs([
    '/sessions',
    '/save-session demo',
    '/load-session demo',
    '/delete-session demo',
    'message A',
    '/exit',
  ]), {
    onCommand: async (command) => { commands.push(command); },
  });

  assert.equal(result.status, 'completed');
  assert.equal(providerCalls, 1);
  assert.deepEqual(commands, ['/sessions', '/save-session demo', '/load-session demo', '/delete-session demo']);
  assert.deepEqual(runner.session.getMessages().map(({ role, content }) => ({ role, content })), [
    { role: 'user', content: 'message A' },
    { role: 'assistant', content: 'reply' },
  ]);
});

test('/export is routed locally, appears in help, and does not become a conversation turn', async () => {
  let providerCalls = 0;
  const provider = new MockAIProvider({
    responder: () => {
      providerCalls += 1;
      return { text: 'reply', provider: 'mock', model: 'mock-model', finishReason: 'stop' };
    },
  });
  const runner = new ConversationRunner(new AssistantCore({ provider }));
  const commands: string[] = [];
  const result = await runner.run(inputs(['message A', '/export', '/export charla-yuki', 'message B']), {
    onCommand: async (command) => { commands.push(command); },
  });

  assert.equal(result.status, 'completed');
  assert.equal(providerCalls, 2);
  assert.deepEqual(commands, ['/export', '/export charla-yuki']);
  assert.match(LOCAL_COMMAND_HELP, /\/export \[nombre\]/u);
  assert.deepEqual(result.session.getMessages().map(({ role, content }) => ({ role, content })), [
    { role: 'user', content: 'message A' },
    { role: 'assistant', content: 'reply' },
    { role: 'user', content: 'message B' },
    { role: 'assistant', content: 'reply' },
  ]);
});

test('unknown slash commands stay local and do not reach the provider or Session', async () => {
  let providerCalls = 0;
  const provider = new MockAIProvider({
    responder: () => {
      providerCalls += 1;
      return { text: 'reply', provider: 'mock', model: 'mock-model', finishReason: 'stop' };
    },
  });
  const runner = new ConversationRunner(new AssistantCore({ provider }));
  const unknownCommands: string[] = [];
  const result = await runner.run(inputs(['/foo', '/time extra', 'message']), {
    onCommand: async (command) => { unknownCommands.push(command); },
  });

  assert.equal(result.status, 'completed');
  assert.equal(providerCalls, 1);
  assert.deepEqual(unknownCommands, ['/foo', '/time extra']);
  assert.deepEqual(runner.session.getMessages().map(({ role, content }) => ({ role, content })), [
    { role: 'user', content: 'message' },
    { role: 'assistant', content: 'reply' },
  ]);
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
      requests.push(request.messages.filter(({ role }) => role !== 'system').map(({ content }) => content));
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

test('memory commands are local and snapshots are requested only for conversational turns', async () => {
  let providerCalls = 0;
  let snapshots = 0;
  const provider = new MockAIProvider({
    responder: (request) => {
      providerCalls += 1;
      assert.equal(request.messages.at(-1)?.content, 'Hello');
      assert.match(request.messages.find(({ content }) => content.includes('memory-data'))?.content ?? '', /Jhon/);
      return { text: 'reply', provider: 'mock', model: 'mock-model', finishReason: 'stop' };
    },
  });
  const runner = new ConversationRunner(new AssistantCore({ provider }));
  const memory: MemorySnapshot = Object.freeze({
    version: 1,
    entries: Object.freeze([{ key: 'name', value: 'Jhon' }]),
  });
  const localCommands: string[] = [];
  const result = await runner.run(inputs(['/remember name Jhon', '/memory', 'Hello', '/forget name', '/clear', '/exit']), {
    memory: () => {
      snapshots += 1;
      return memory;
    },
    onCommand: async (command) => { localCommands.push(command); },
  });

  assert.equal(result.status, 'completed');
  assert.equal(providerCalls, 1);
  assert.equal(snapshots, 1);
  assert.deepEqual(localCommands, ['/remember name Jhon', '/memory', '/forget name', '/clear']);
  assert.deepEqual(result.session.getMessages().map(({ content }) => content), ['Hello', 'reply']);
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

test('conversation runner interrupts a streaming turn with the latest normal input', async () => {
  const provider = interruptibleProvider();
  const nextInput = deferred<string>();
  const output: string[] = [];
  const interruptions: number[] = [];
  const source = (async function* (): AsyncIterable<string> {
    yield 'A';
    yield await nextInput.promise;
  }());
  const runner = new ConversationRunner(new AssistantCore({ provider }));
  const pending = runner.run(source, {
    interruptible: true,
    onDelta: (delta) => { output.push(delta); },
    onInterruption: () => { interruptions.push(1); },
  });

  await provider.firstStarted;
  nextInput.resolve('B');
  const result = await pending;

  assert.equal(result.status, 'completed');
  assert.deepEqual(output, ['partial-A', 'answer-B']);
  assert.equal(interruptions.length, 1);
  assert.deepEqual(result.session.getMessages().map(({ role, content }) => ({ role, content })), [
    { role: 'user', content: 'A' },
    { role: 'user', content: 'B' },
    { role: 'assistant', content: 'answer-B' },
  ]);
});

test('conversation runner latest-input-wins replaces pending B with C', async () => {
  const provider = interruptibleProvider();
  const output: string[] = [];
  const source = (async function* (): AsyncIterable<string> {
    yield 'A';
    yield 'B';
    yield 'C';
  }());
  const runner = new ConversationRunner(new AssistantCore({ provider }));
  const resultPromise = runner.run(source, { interruptible: true, onDelta: (delta) => { output.push(delta); } });
  await provider.firstStarted;
  const result = await resultPromise;

  assert.equal(result.status, 'completed');
  assert.deepEqual(output, ['answer-C']);
  assert.deepEqual(result.session.getMessages().map(({ role, content }) => ({ role, content })), [
    { role: 'user', content: 'A' },
    { role: 'user', content: 'C' },
    { role: 'assistant', content: 'answer-C' },
  ]);
});

test('conversation runner handles /cancel during a response and then continues', async () => {
  const provider = interruptibleProvider();
  const commands: Array<{ command: string; active: boolean }> = [];
  const source = (async function* (): AsyncIterable<string> {
    yield 'A';
    yield '/cancel';
    yield 'B';
  }());
  const runner = new ConversationRunner(new AssistantCore({ provider }));
  const resultPromise = runner.run(source, {
    interruptible: true,
    onCommand: (command, context) => { commands.push({ command, active: context.active }); },
  });
  await provider.firstStarted;
  const result = await resultPromise;

  assert.equal(result.status, 'completed');
  assert.deepEqual(commands, [{ command: '/cancel', active: true }]);
  assert.deepEqual(result.session.getMessages().map(({ role, content }) => ({ role, content })), [
    { role: 'user', content: 'A' },
    { role: 'user', content: 'B' },
    { role: 'assistant', content: 'answer-B' },
  ]);
});

test('conversation runner cancels before executing /clear and prevents stale repopulation', async () => {
  const provider = interruptibleProvider();
  const source = (async function* (): AsyncIterable<string> {
    yield 'A';
    yield '/clear';
    yield 'B';
  }());
  const runner = new ConversationRunner(new AssistantCore({ provider }));
  const resultPromise = runner.run(source, {
    interruptible: true,
    onCommand: (command) => {
      assert.equal(command, '/clear');
      runner.session.clear();
    },
  });
  await provider.firstStarted;
  const result = await resultPromise;

  assert.equal(result.status, 'completed');
  assert.deepEqual(result.session.getMessages().map(({ role, content }) => ({ role, content })), [
    { role: 'user', content: 'B' },
    { role: 'assistant', content: 'answer-B' },
  ]);
});

test('conversation runner /exit during a response cancels without persisting partial output', async () => {
  const provider = interruptibleProvider();
  const interruptions: number[] = [];
  const source = (async function* (): AsyncIterable<string> {
    yield 'A';
    yield '/exit';
  }());
  const runner = new ConversationRunner(new AssistantCore({ provider }));
  const resultPromise = runner.run(source, { interruptible: true, onInterruption: () => { interruptions.push(1); } });
  await provider.firstStarted;
  const result = await resultPromise;

  assert.equal(result.status, 'completed');
  assert.equal(result.responses.length, 0);
  assert.equal(interruptions.length, 1);
  assert.deepEqual(result.session.getMessages().map(({ role, content }) => ({ role, content })), [
    { role: 'user', content: 'A' },
  ]);
});

test('conversation runner survives 100 deterministic interruption cycles', async () => {
  for (let index = 0; index < 100; index += 1) {
    const provider = interruptibleProvider();
    const runner = new ConversationRunner(new AssistantCore({ provider }));
    const result = await runner.run((async function* (): AsyncIterable<string> {
      yield `A-${index}`;
      yield `B-${index}`;
    }()), { interruptible: true });

    assert.equal(result.status, 'completed');
    assert.deepEqual(provider.calls, [`A-${index}`, `B-${index}`]);
    assert.deepEqual(result.session.getMessages().map(({ role, content }) => ({ role, content })), [
      { role: 'user', content: `A-${index}` },
      { role: 'user', content: `B-${index}` },
      { role: 'assistant', content: `answer-B-${index}` },
    ]);
  }
});

test('conversation runner bounds 50 rapid inputs to one active and one final turn', async () => {
  const firstStarted = deferred<void>();
  const allInputsConsumed = deferred<void>();
  const cancelRelease = deferred<void>();
  const calls: string[] = [];
  const provider: AIProvider = {
    name: 'rapid-interrupt-test',
    complete: async () => ({ text: 'unused', provider: 'rapid-interrupt-test', model: 'test', finishReason: 'stop' }),
    async *stream(request, options) {
      const input = request.messages.at(-1)?.content ?? '';
      calls.push(input);
      if (input === 'A') {
        yield { type: 'text_delta', delta: 'partial-A' };
        firstStarted.resolve();
        await cancelRelease.promise;
        if (options?.signal?.aborted) throw new Error('cancelled first turn');
      }
      yield { type: 'text_delta', delta: `answer-${input}` };
      yield { type: 'completed', response: { text: `answer-${input}`, provider: 'rapid-interrupt-test', model: 'test', finishReason: 'stop' } };
    },
  };
  const rapidInputs = Array.from({ length: 50 }, (_, index) => `input-${index}`);
  const runner = new ConversationRunner(new AssistantCore({ provider }));
  const resultPromise = runner.run((async function* (): AsyncIterable<string> {
    yield 'A';
    for (const input of rapidInputs) {
      yield input;
      if (input === 'input-49') allInputsConsumed.resolve();
    }
  }()), { interruptible: true });
  await firstStarted.promise;
  await allInputsConsumed.promise;
  cancelRelease.resolve();
  const result = await resultPromise;
  assert.equal(result.status, 'completed');
  assert.deepEqual(calls, ['A', 'input-49']);
  assert.equal(result.session.getMessages().at(-1)?.content, 'answer-input-49');
  assert.equal(result.session.getMessages().filter(({ role }) => role === 'assistant').length, 1);
});
