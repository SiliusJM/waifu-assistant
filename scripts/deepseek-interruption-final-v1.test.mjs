import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AssistantCore,
  ConversationRunner,
  LOCAL_TOOL_ALLOWLIST,
  SavedSessionStore,
  createLocalToolManager,
} from '../dist/index.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCountingFetch, ProviderRequestBudget } from './provider-call-budget.mjs';

const logger = { info: () => {}, warn: () => {}, error: () => {} };
const response = (text) => ({ text, provider: 'offline', model: 'offline', finishReason: 'stop' });
const inputs = async function* (values) { yield* values; };

function interruptionProvider(index, mode = 'after-first-delta') {
  let firstStarted;
  const started = new Promise((resolve) => { firstStarted = resolve; });
  return {
    name: 'offline-interruption',
    started,
    complete: async () => response('unused'),
    async *stream(request, options) {
      const input = request.messages.at(-1)?.content ?? '';
      if (input === `A-${index}`) {
        firstStarted();
        if (mode !== 'before-first-delta') yield { type: 'text_delta', delta: `stale-A-${index}` };
        if (mode === 'near-completion') yield { type: 'text_delta', delta: `stale-tail-${index}` };
        await new Promise((resolve) => {
          if (options?.signal?.aborted) { resolve(); return; }
          options?.signal?.addEventListener('abort', resolve, { once: true });
        });
        throw new Error('offline interrupted A');
      }
      yield { type: 'text_delta', delta: `answer-${input}` };
      yield { type: 'completed', response: response(`answer-${input}`) };
    },
  };
}

test('500 deterministic interruption sequences preserve only the latest completed response', async () => {
  const phases = ['before-first-delta', 'after-first-delta', 'near-completion', 'after-first-delta', 'near-completion'];
  for (let index = 0; index < 500; index += 1) {
    const provider = interruptionProvider(index, phases[index % phases.length]);
    const runner = new ConversationRunner(new AssistantCore({ provider, logger }));
    const result = await runner.run(inputs([`A-${index}`, `B-${index}`]), { interruptible: true });
    const messages = result.session.getMessages();
    assert.equal(result.status, 'completed');
    assert.equal(messages.some(({ role, content }) => role === 'assistant' && content.startsWith('stale-')), false);
    assert.deepEqual(messages, [
      { id: messages[0].id, role: 'user', content: `A-${index}`, createdAt: messages[0].createdAt },
      { id: messages[1].id, role: 'user', content: `B-${index}`, createdAt: messages[1].createdAt },
      { id: messages[2].id, role: 'assistant', content: `answer-B-${index}`, createdAt: messages[2].createdAt },
    ]);
  }
});

test('200 rapid A to B to C sequences keep only the latest assistant answer', async () => {
  for (let index = 0; index < 200; index += 1) {
    const provider = interruptionProvider(index);
    const runner = new ConversationRunner(new AssistantCore({ provider, logger }));
    const result = await runner.run(inputs([`A-${index}`, `B-${index}`, `C-${index}`]), { interruptible: true });
    const assistants = result.session.getMessages().filter(({ role }) => role === 'assistant');
    assert.equal(result.status, 'completed');
    assert.deepEqual(assistants.map(({ content }) => content), [`answer-C-${index}`]);
    assert.equal(assistants.some(({ content }) => /answer-[AB]/u.test(content)), false);
  }
});

test('200 abort classification cases keep exact issued/aborted counters', async () => {
  const budget = new ProviderRequestBudget(200);
  const cases = ['real-external-abort', 'timeout-abort', 'cleanup-cancel', 'completed-stream'];
  for (let index = 0; index < 200; index += 1) {
    const kind = cases[index % cases.length];
    const controller = new AbortController();
    const countingFetch = createCountingFetch({
      budget,
      fetchImpl: async (_input, init) => {
        if (kind === 'cleanup-cancel' || kind === 'completed-stream') {
          return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{}')); c.close(); } }));
        }
        return new Promise((resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(Object.assign(new Error(kind), { name: 'AbortError' })), { once: true });
        });
      },
    });
    const pending = countingFetch('http://offline.test', { body: '{}', signal: controller.signal });
    if (kind === 'cleanup-cancel' || kind === 'completed-stream') {
      const result = await pending;
      await result.text();
    } else {
      controller.abort();
      await assert.rejects(pending, { name: 'AbortError' });
    }
  }
  assert.equal(budget.providerRequests, 200);
  assert.equal(budget.abortedIssuedRequests, 100);
});

test('500 mixed simulated interactions keep exact budget accounting', () => {
  const budget = new ProviderRequestBudget(1_000);
  let expectedRequests = 0;
  for (let index = 0; index < 500; index += 1) {
    budget.noteLogicalInteraction();
    budget.countProviderRequest();
    expectedRequests += 1;
    if (index % 5 === 2) { budget.countProviderRequest({ retry: true }); expectedRequests += 1; }
    if (index % 5 === 3) { budget.countProviderRequest({ kind: 'tool-second-round' }); expectedRequests += 1; }
    if (index % 5 === 4) budget.noteIssuedRequestAborted();
  }
  assert.equal(budget.providerRequests, expectedRequests);
  assert.equal(budget.logicalInteractions, 500);
  assert.equal(budget.retryRequests, 100);
  assert.equal(budget.toolSecondRoundRequests, 100);
  assert.equal(budget.abortedIssuedRequests, 100);
});

test('memory, saved-session and tool regressions remain offline-safe', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-interruption-offline-'));
  try {
    const memoryProvider = {
      name: 'offline-memory',
      complete: async (request) => response(request.messages.some(({ content }) => content.includes('Jhon')) ? 'Jhon' : 'missing'),
      async *stream(request) { yield { type: 'completed', response: await this.complete(request) }; },
    };
    const memory = { version: 1, entries: [{ key: 'name', value: 'Jhon' }] };
    const core = new AssistantCore({ provider: memoryProvider, logger });
    const session = core.createSession();
    const result = await core.respond(session, 'Who am I?', { memory });
    assert.equal(result.text, 'Jhon');
    assert.equal(session.getMessages().some(({ content }) => content.includes('memory-data')), false);

    const store = new SavedSessionStore(join(root, 'session.json'));
    await store.save('safe', [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' }]);
    const saved = await store.get('safe');
    assert.deepEqual(saved.messages.map(({ role, content }) => ({ role, content })), [
      { role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' },
    ]);
    assert.equal((await readFile(join(root, 'session.json'), 'utf8')).includes('memory-data'), false);

    const toolProvider = {
      name: 'offline-tool',
      calls: 0,
      complete: async function (request) {
        this.calls += 1;
        if (this.calls === 1) {
          return {
            ...response(''), finishReason: 'tool_calls',
            toolCalls: [{ id: 'time-1', name: 'local_time', argumentsJson: '{}' }],
          };
        }
        assert.equal(request.messages.some(({ role }) => role === 'tool'), true);
        return response('tool-result');
      },
    };
    const toolCore = new AssistantCore({
      provider: toolProvider,
      logger,
      toolManager: createLocalToolManager(() => new Date('2026-09-22T17:34:56.000Z')),
      toolAllowlist: LOCAL_TOOL_ALLOWLIST,
    });
    assert.equal((await toolCore.respond(toolCore.createSession(), 'time')).text, 'tool-result');
    assert.equal(toolProvider.calls, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('critical interruption sequence remains stable across ten consecutive runs', async () => {
  for (let index = 0; index < 10; index += 1) {
    const provider = interruptionProvider(index);
    const result = await new ConversationRunner(new AssistantCore({ provider, logger }))
      .run(inputs([`A-${index}`, `B-${index}`]), { interruptible: true });
    assert.equal(result.session.getMessages().at(-1)?.content, `answer-B-${index}`);
  }
});
