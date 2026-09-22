import assert from 'node:assert/strict';
import test from 'node:test';
import type { AIRequest } from '../../src/ai/ai-types.js';
import { AssistantCore } from '../../src/core/assistant-core.js';
import { MockAIProvider } from '../../src/ai/mock-ai-provider.js';
import { createLocalToolManager, LOCAL_TOOL_ALLOWLIST } from '../../src/tools/local-tool-manager.js';

function toolResponse(name: string, argumentsJson: string, id = 'call-1') {
  return {
    text: '',
    provider: 'mock',
    model: 'mock-model',
    finishReason: 'tool_calls' as const,
    toolCalls: [{ id, name, argumentsJson }],
  };
}

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

test('assistant core executes an allowlisted local time tool and keeps protocol messages ephemeral', async () => {
  const requests: AIRequest[] = [];
  let calls = 0;
  const provider = new MockAIProvider({
    responder: async (request) => {
      requests.push(request);
      calls += 1;
      return calls === 1
        ? toolResponse('local_time', '{}')
        : {
          text: 'It is 12:34 locally.',
          provider: 'mock',
          model: 'mock-model',
          finishReason: 'stop' as const,
        };
    },
  });
  const core = new AssistantCore({
    provider,
    toolManager: createLocalToolManager(() => new Date('2026-09-22T17:34:56.000Z')),
    toolAllowlist: LOCAL_TOOL_ALLOWLIST,
  });
  const session = core.createSession();

  const response = await core.respond(session, 'What time is it?');

  assert.equal(response.text, 'It is 12:34 locally.');
  assert.equal(calls, 2);
  assert.deepEqual(requests[0]?.tools?.map((tool) => tool.function.name), [
    'local_time',
    'local_calculate',
  ]);
  assert.equal(requests[1]?.messages.at(-1)?.role, 'tool');
  assert.match(requests[1]?.messages.at(-1)?.content ?? '', /success/);
  assert.deepEqual(session.getMessages().map(({ role, content }) => ({ role, content })), [
    { role: 'user', content: 'What time is it?' },
    { role: 'assistant', content: 'It is 12:34 locally.' },
  ]);
});

test('assistant core executes a calculator tool through the same controlled round', async () => {
  let calls = 0;
  const provider = new MockAIProvider({
    responder: async () => {
      calls += 1;
      return calls === 1
        ? toolResponse('local_calculate', JSON.stringify({ expression: '(25 + 5) * 3' }))
        : {
          text: 'The result is 90.',
          provider: 'mock',
          model: 'mock-model',
          finishReason: 'stop' as const,
        };
    },
  });
  const core = new AssistantCore({
    provider,
    toolManager: createLocalToolManager(),
    toolAllowlist: LOCAL_TOOL_ALLOWLIST,
  });

  const response = await core.respond(core.createSession(), 'Calculate this.');

  assert.equal(response.text, 'The result is 90.');
  assert.equal(calls, 2);
});

test('assistant core returns a controlled failure to the provider for an unknown tool', async () => {
  const requests: AIRequest[] = [];
  let calls = 0;
  const provider = new MockAIProvider({
    responder: async (request) => {
      requests.push(request);
      calls += 1;
      return calls === 1
        ? toolResponse('unknown_tool', '{}', 'unknown-1')
        : {
          text: 'I could not use that tool.',
          provider: 'mock',
          model: 'mock-model',
          finishReason: 'stop' as const,
        };
    },
  });
  const core = new AssistantCore({
    provider,
    toolManager: createLocalToolManager(),
    toolAllowlist: LOCAL_TOOL_ALLOWLIST,
  });

  await core.respond(core.createSession(), 'Use an unknown tool.');

  assert.equal(calls, 2);
  assert.match(requests[1]?.messages.at(-1)?.content ?? '', /TOOL_NOT_FOUND_ERROR/);
});

test('assistant core rejects invalid tool JSON without evaluating it', async () => {
  const requests: AIRequest[] = [];
  let calls = 0;
  const provider = new MockAIProvider({
    responder: async (request) => {
      requests.push(request);
      calls += 1;
      return calls === 1
        ? toolResponse('local_time', '{not-json')
        : {
          text: 'The arguments were invalid.',
          provider: 'mock',
          model: 'mock-model',
          finishReason: 'stop' as const,
        };
    },
  });
  const core = new AssistantCore({
    provider,
    toolManager: createLocalToolManager(),
    toolAllowlist: LOCAL_TOOL_ALLOWLIST,
  });

  await core.respond(core.createSession(), 'Use time.');

  assert.equal(calls, 2);
  assert.match(requests[1]?.messages.at(-1)?.content ?? '', /TOOL_ARGUMENTS_ERROR/);
});

test('assistant core permits at most two tool calls in one round and never recurses', async () => {
  let calls = 0;
  const provider = new MockAIProvider({
    responder: async () => {
      calls += 1;
      return calls === 1
        ? {
          ...toolResponse('local_time', '{}', 'call-1'),
          toolCalls: [
            { id: 'call-1', name: 'local_time', argumentsJson: '{}' },
            { id: 'call-2', name: 'local_time', argumentsJson: '{}' },
            { id: 'call-3', name: 'local_time', argumentsJson: '{}' },
          ],
        }
        : { text: 'unexpected', provider: 'mock', model: 'mock-model', finishReason: 'stop' as const };
    },
  });
  const core = new AssistantCore({
    provider,
    toolManager: createLocalToolManager(),
    toolAllowlist: LOCAL_TOOL_ALLOWLIST,
  });

  await assert.rejects(
    () => core.respond(core.createSession(), 'Too many tools.'),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'TOOL_ARGUMENTS_ERROR',
  );
  assert.equal(calls, 1);
});

test('assistant core rejects a second tool round', async () => {
  let calls = 0;
  const provider = new MockAIProvider({
    responder: async () => {
      calls += 1;
      return toolResponse('local_time', '{}', `call-${calls}`);
    },
  });
  const core = new AssistantCore({
    provider,
    toolManager: createLocalToolManager(),
    toolAllowlist: LOCAL_TOOL_ALLOWLIST,
  });

  await assert.rejects(
    () => core.respond(core.createSession(), 'Recurse.'),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'TOOL_EXECUTION_ERROR',
  );
  assert.equal(calls, 2);
});

test('assistant core stops a tool round when the caller is already cancelled', async () => {
  let calls = 0;
  const provider = new MockAIProvider({
    responder: async () => {
      calls += 1;
      return toolResponse('local_time', '{}');
    },
  });
  const core = new AssistantCore({
    provider,
    toolManager: createLocalToolManager(),
    toolAllowlist: LOCAL_TOOL_ALLOWLIST,
  });
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () => core.respond(core.createSession(), 'Cancel.', { signal: controller.signal }),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'CANCELLATION_ERROR',
  );
  assert.equal(calls, 1);
});
