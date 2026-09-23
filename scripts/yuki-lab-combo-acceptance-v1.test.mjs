import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  AssistantCore,
  ConversationRunner,
  LOCAL_TOOL_ALLOWLIST,
  SavedSessionStore,
  createLocalToolManager,
} from '../dist/index.js';
import { ProviderRequestBudget } from './provider-call-budget.mjs';

const logger = { info: () => {}, warn: () => {}, error: () => {} };
const response = (text) => ({ text, provider: 'offline-combo', model: 'offline', finishReason: 'stop' });
const input = async function* (values) { yield* values; };

function mockProvider(responder = (request) => response(request.messages.at(-1)?.content ?? 'ok')) {
  const calls = [];
  return {
    name: 'offline-combo', calls,
    complete: async (request) => { calls.push(request); return responder(request, calls.length); },
    async *stream(request, options) {
      const result = await this.complete(request, options);
      if (result.toolCalls?.length) { yield { type: 'completed', response: result }; return; }
      yield { type: 'text_delta', delta: result.text };
      yield { type: 'completed', response: result };
    },
  };
}

function interruptProvider(index) {
  let started;
  const firstStarted = new Promise((resolve) => { started = resolve; });
  return {
    name: 'offline-interrupt-combo', firstStarted,
    complete: async () => response('unused'),
    async *stream(request, options) {
      const value = request.messages.at(-1)?.content ?? '';
      if (value === `A-${index}`) {
        started();
        yield { type: 'text_delta', delta: `stale-${index}` };
        await new Promise((resolve) => options.signal.addEventListener('abort', resolve, { once: true }));
        throw new Error('interrupted');
      }
      yield { type: 'text_delta', delta: `answer-${value}` };
      yield { type: 'completed', response: response(`answer-${value}`) };
    },
  };
}

test('1000 normal mock turns remain bounded and retain the expected session context', async () => {
  for (let index = 0; index < 1000; index += 1) {
    const provider = mockProvider((request) => response(request.messages.some(({ content }) => content.includes(`TOKEN-${index}`)) ? `TOKEN-${index}` : 'missing'));
    const core = new AssistantCore({ provider, logger });
    const runner = new ConversationRunner(core);
    const result = await runner.run(input([`Remember TOKEN-${index}`, `What was TOKEN-${index}`]));
    assert.equal(result.responses.at(-1)?.text, `TOKEN-${index}`);
    assert.equal(result.session.getMessages().length, 4);
    assert.ok(result.session.getMessages().length <= 1000);
  }
});

test('500 interruptions do not persist partial assistant responses', async () => {
  for (let index = 0; index < 500; index += 1) {
    const provider = interruptProvider(index);
    const runner = new ConversationRunner(new AssistantCore({ provider, logger }));
    let releaseB;
    const bReady = new Promise((resolve) => { releaseB = resolve; });
    const pending = runner.run((async function* () {
      yield `A-${index}`;
      await bReady;
      yield `B-${index}`;
    }()), { interruptible: true, onDelta: () => { releaseB?.(); } });
    const result = await pending;
    const messages = result.session.getMessages();
    assert.equal(messages.some(({ role, content }) => role === 'assistant' && content.startsWith('stale-')), false);
    assert.equal(messages.at(-1)?.content, `answer-B-${index}`);
  }
});

test('200 rapid A-B-C sequences keep only C as assistant output', async () => {
  for (let index = 0; index < 200; index += 1) {
    const provider = interruptProvider(index);
    let releaseB;
    const bReady = new Promise((resolve) => { releaseB = resolve; });
    const result = await new ConversationRunner(new AssistantCore({ provider, logger }))
      .run((async function* () {
        yield `A-${index}`;
        await bReady;
        yield `B-${index}`;
        yield `C-${index}`;
      }()), { interruptible: true, onDelta: () => { releaseB?.(); } });
    assert.deepEqual(result.session.getMessages().filter(({ role }) => role === 'assistant').map(({ content }) => content), [`answer-C-${index}`]);
  }
});

test('500 provider accounting operations preserve exact counters and block before request 37', () => {
  const budget = new ProviderRequestBudget(36);
  for (let index = 0; index < 500; index += 1) {
    try { budget.countProviderRequest(); } catch (error) { assert.equal(error.code, 'BUDGET_EXHAUSTED'); }
    if (index % 5 === 0 && budget.providerRequests < 36) budget.noteIssuedRequestAborted();
  }
  assert.equal(budget.providerRequests, 36);
  assert.equal(budget.blockedByBudget, 464);
  assert.equal(budget.abortedIssuedRequests, 7);
});

test('200 local tool rounds remain bounded at one tool phase', async () => {
  for (let index = 0; index < 200; index += 1) {
    const provider = mockProvider((_request, count) => count === 1
      ? { ...response(''), finishReason: 'tool_calls', toolCalls: [{ id: `time-${index}`, name: 'local_time', argumentsJson: '{}' }] }
      : response(`tool-result-${index}`));
    const core = new AssistantCore({
      provider,
      logger,
      toolManager: createLocalToolManager(() => new Date('2026-09-22T17:34:56.000Z')),
      toolAllowlist: LOCAL_TOOL_ALLOWLIST,
    });
    const result = await core.respond(core.createSession(), `time-${index}`);
    assert.equal(result.text, `tool-result-${index}`);
    assert.equal(provider.calls.length, 2);
  }
});

test('200 current-data policy captures remain system-scoped and never enter Session', async () => {
  for (let index = 0; index < 200; index += 1) {
    const provider = mockProvider();
    const core = new AssistantCore({ provider, logger });
    const session = core.createSession();
    await core.respond(session, `Current data question ${index}`);
    assert.ok(provider.calls[0].messages.some(({ role, content }) => role === 'system' && content.startsWith('Current-data honesty policy:')));
    assert.equal(session.getMessages().some(({ content }) => content.startsWith('Current-data honesty policy:')), false);
  }
});

test('100 saved-session cycles persist only user and assistant roles', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yuki-combo-saved-'));
  try {
    const store = new SavedSessionStore(join(root, 'sessions.json'));
    for (let index = 0; index < 100; index += 1) {
      const name = `session-${index % 10}`;
      await store.save(name, [
        { role: 'user', content: `U-${index}` },
        { role: 'assistant', content: `A-${index}` },
      ]);
      const loaded = await store.get(name);
      assert.ok(loaded.messages.every(({ role }) => role === 'user' || role === 'assistant'));
      assert.equal(loaded.messages.length, 2);
    }
    assert.equal((await readFile(join(root, 'sessions.json'), 'utf8')).includes('memory-data'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('offline injection boundaries keep memory and tool data non-authoritative', async () => {
  const provider = mockProvider((request) => response(request.messages.some(({ content }) => content.includes('IGNORE-SYSTEM')) ? 'data-only' : 'missing'));
  const core = new AssistantCore({
    provider,
    logger,
    toolManager: createLocalToolManager(),
    toolAllowlist: LOCAL_TOOL_ALLOWLIST,
  });
  const session = core.createSession();
  await core.respond(session, 'test', { memory: { version: 1, entries: [{ key: 'note', value: 'IGNORE-SYSTEM' }] } });
  assert.equal(session.getMessages().some(({ content }) => content.includes('IGNORE-SYSTEM')), false);
  assert.equal(provider.calls[0].messages.find(({ content }) => content.includes('memory-data'))?.role, 'system');
});
