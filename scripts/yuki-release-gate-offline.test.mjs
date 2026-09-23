import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  AssistantCore,
  ConversationRunner,
  LOCAL_TOOL_ALLOWLIST,
  SavedSessionStore,
  createLocalToolManager,
  createLogger,
} from '../dist/index.js';
import { PersonalityCompiler } from '../dist/personality/personality-compiler.js';
import { PersonalityRegistry } from '../dist/personality/personality-registry.js';

const POLICY_PREFIX = 'Current-data honesty policy:';

function silentLogger() {
  return createLogger({
    sink: { info: () => {}, warn: () => {}, error: () => {} },
  });
}

async function* inputs(values) {
  yield* values;
}

function snapshot() {
  return new PersonalityCompiler().compile({
    profile: new PersonalityRegistry().defaultProfile,
  });
}

function response(text = 'ok') {
  return { text, provider: 'offline-gate', model: 'offline', finishReason: 'stop' };
}

function captureProvider(responder = () => response()) {
  const requests = [];
  return {
    name: 'offline-gate',
    requests,
    complete: async (request) => {
      requests.push(request);
      return responder(request, requests.length);
    },
    async *stream(request, options) {
      const result = await this.complete(request, options);
      if (result.toolCalls?.length) {
        yield { type: 'completed', response: result };
        return;
      }
      yield { type: 'text_delta', delta: result.text };
      yield { type: 'completed', response: result };
    },
  };
}

function requestText(request) {
  return request.messages.map(({ content }) => content).join('\n');
}

test('300 deterministic multi-turn captures retain turn-one context in request two', async () => {
  for (let index = 0; index < 300; index += 1) {
    const token = `OFFLINE-CONTEXT-${index}`;
    const provider = captureProvider((request) => response(
      requestText(request).includes(token) ? token : 'missing',
    ));
    const runner = new ConversationRunner(new AssistantCore({ provider, logger: silentLogger() }));
    const result = await runner.run(inputs([
      `Mi token temporal es ${token}.`,
      '¿Cuál es mi token temporal?',
    ]));

    assert.equal(result.status, 'completed');
    assert.equal(provider.requests.length, 2);
    assert.match(requestText(provider.requests[1]), new RegExp(token));
    assert.equal(result.responses[1]?.text, token);
    assert.equal(result.session.getMessages().filter(({ role }) => role === 'assistant').length, 2);
  }
});

test('200 generated current-data prompts always carry the policy system block', async () => {
  const provider = captureProvider();
  const core = new AssistantCore({ provider, logger: silentLogger() });
  const session = core.createSession();

  for (let index = 0; index < 200; index += 1) {
    await core.respond(session, `¿Cuál es el dato actual de prueba ${index}?`);
    const request = provider.requests[index];
    assert.ok(request.messages.some(({ role, content }) => role === 'system' && content.startsWith(POLICY_PREFIX)));
  }
});

test('tool second round preserves policy, personality and session context', async () => {
  const provider = captureProvider((_request, count) => count === 1
    ? {
      ...response(''),
      finishReason: 'tool_calls',
      toolCalls: [{ id: 'time-1', name: 'local_time', argumentsJson: '{}' }],
    }
    : response('tool-result'));
  const core = new AssistantCore({
    provider,
    logger: silentLogger(),
    toolManager: createLocalToolManager(() => new Date('2026-09-22T17:34:56.000Z')),
    toolAllowlist: LOCAL_TOOL_ALLOWLIST,
  });
  const session = core.createSession();
  const personality = snapshot();
  const result = await core.respond(session, '¿Qué hora es?', { personality });

  assert.equal(result.text, 'tool-result');
  assert.equal(provider.requests.length, 2);
  const second = provider.requests[1];
  assert.ok(second.messages.some(({ role, content }) => role === 'system' && content.startsWith(POLICY_PREFIX)));
  assert.ok(second.messages.some(({ role, content }) => role === 'system' && content.includes('assistant identity name is Yuki')));
  assert.ok(second.messages.some(({ role, toolCallId }) => role === 'tool' && toolCallId === 'time-1'));
  assert.equal(session.getMessages().some(({ content }) => content.includes(POLICY_PREFIX)), false);
  assert.equal(session.getMessages().some(({ content }) => content.includes('17:34:56')), false);
});

test('100 tool second-round contexts preserve policy and never start a third provider round', async () => {
  for (let index = 0; index < 100; index += 1) {
    const provider = captureProvider((_request, count) => count === 1
      ? {
        ...response(''),
        finishReason: 'tool_calls',
        toolCalls: [{ id: `time-${index}`, name: 'local_time', argumentsJson: '{}' }],
      }
      : response(`tool-result-${index}`));
    const core = new AssistantCore({
      provider,
      logger: silentLogger(),
      toolManager: createLocalToolManager(() => new Date('2026-09-22T17:34:56.000Z')),
      toolAllowlist: LOCAL_TOOL_ALLOWLIST,
    });
    const result = await core.respond(core.createSession(), `Tool context ${index}`);
    assert.equal(result.text, `tool-result-${index}`);
    assert.equal(provider.requests.length, 2);
    assert.ok(provider.requests[1].messages.some(({ role }) => role === 'tool'));
    assert.ok(provider.requests[1].messages.some(({ role, content }) => role === 'system' && content.startsWith(POLICY_PREFIX)));
  }
});

test('200 interruption ownership cases never persist stale assistant A', async () => {
  const phases = ['before-first-delta', 'after-first-delta', 'near-completion', 'before-tool', 'after-tool'];
  for (let index = 0; index < 200; index += 1) {
    const phase = phases[index % phases.length];
    let firstStarted;
    const started = new Promise((resolve) => { firstStarted = resolve; });
    const provider = {
      name: 'offline-interruption',
      complete: async () => response('unused'),
      async *stream(request, options) {
        const input = request.messages.at(-1)?.content ?? '';
        if (input === `A-${index}`) {
          firstStarted();
          if (phase !== 'before-first-delta') yield { type: 'text_delta', delta: `stale-${index}` };
          if (phase === 'near-completion') yield { type: 'text_delta', delta: 'stale-tail' };
          await new Promise((resolve) => {
            if (options?.signal?.aborted) { resolve(); return; }
            options.signal.addEventListener('abort', resolve, { once: true });
          });
          throw new Error('cancelled stale turn');
        }
        yield { type: 'text_delta', delta: `answer-${index}` };
        yield { type: 'completed', response: response(`answer-${index}`) };
      },
    };
    const runner = new ConversationRunner(new AssistantCore({ provider, logger: silentLogger() }));
    const resultPromise = runner.run(inputs([`A-${index}`, `B-${index}`]), { interruptible: true });
    await started;
    const result = await resultPromise;
    const messages = result.session.getMessages();

    assert.equal(result.status, 'completed');
    assert.equal(messages.some(({ role, content }) => role === 'assistant' && content.startsWith('stale-')), false);
    assert.equal(messages.at(-1)?.content, `answer-${index}`);
    assert.equal(messages.filter(({ role }) => role === 'assistant').length, 1);
  }
});

test('saved sessions contain conversation messages only, never policy/personality/memory blocks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yuki-release-gate-session-'));
  try {
    const store = new SavedSessionStore(join(root, 'sessions.json'));
    await store.save('safe', [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
    ]);
    const raw = await readFile(join(root, 'sessions.json'), 'utf8');
    assert.equal(raw.includes(POLICY_PREFIX), false);
    assert.equal(raw.includes('assistant identity name is Yuki'), false);
    assert.equal(raw.includes('<memory-data>'), false);
    assert.deepEqual((await store.get('safe'))?.messages.map(({ role, content }) => ({ role, content })), [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
