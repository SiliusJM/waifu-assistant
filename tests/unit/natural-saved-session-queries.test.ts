import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MockAIProvider } from '../../src/ai/mock-ai-provider.js';
import type { AIRequest } from '../../src/ai/ai-types.js';
import { AssistantCore } from '../../src/core/assistant-core.js';
import { SavedSessionStore } from '../../src/core/saved-session-store.js';
import { Session } from '../../src/core/session.js';
import { PersistentMemoryStore } from '../../src/memory/memory-store.js';
import { createLocalToolManager, getLocalToolAllowlist } from '../../src/tools/local-tool-manager.js';

const TOOL_NAME = 'local_saved_sessions_query';
const SAVED_AT_OLD = '2026-09-20T10:00:00.000Z';
const SAVED_AT_NEW = '2026-09-22T10:00:00.000Z';

function snapshot(savedAt: string, title?: string, text = 'PRIVATE-SAVED-MESSAGE'): Record<string, unknown> {
  return {
    savedAt,
    ...(title === undefined ? {} : { title }),
    messages: [{ role: 'user', content: text }, { role: 'assistant', content: `reply-${text}` }],
  };
}

async function withSavedStore(run: (store: SavedSessionStore, path: string) => Promise<void>, data?: unknown): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'waifu-saved-query-'));
  const path = join(directory, 'sessions.json');
  try {
    if (data !== undefined) await writeFile(path, JSON.stringify(data, null, 2) + '\n', 'utf8');
    const store = new SavedSessionStore(path);
    await store.load();
    await run(store, path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function toolCall(operation: 'list' | 'count' | 'recent' | 'info', sessionId?: string) {
  return {
    text: '', provider: 'mock', model: 'scripted', finishReason: 'tool_calls' as const,
    toolCalls: [{
      id: `saved-${operation}`,
      name: TOOL_NAME,
      argumentsJson: JSON.stringify({ operation, ...(sessionId === undefined ? {} : { sessionId }) }),
    }],
  };
}

async function askSavedSessions(options: {
  readonly store: SavedSessionStore;
  readonly input: string;
  readonly operation: 'list' | 'count' | 'recent' | 'info';
  readonly sessionId?: string;
  readonly session?: Session;
  readonly memory?: Awaited<ReturnType<PersistentMemoryStore['snapshot']>>;
  readonly finalText?: string;
}): Promise<{ readonly session: Session; readonly requests: readonly AIRequest[]; readonly answer: string }> {
  const requests: AIRequest[] = [];
  let invocation = 0;
  const provider = new MockAIProvider({
    responder: (request) => {
      requests.push(request);
      invocation += 1;
      return invocation === 1
        ? toolCall(options.operation, options.sessionId)
        : { text: options.finalText ?? 'Aquí está la información guardada.', provider: 'mock', model: 'scripted', finishReason: 'stop' as const };
    },
  });
  const toolOptions = { savedSessionStore: options.store };
  const core = new AssistantCore({
    provider,
    toolManager: createLocalToolManager(toolOptions),
    toolAllowlist: getLocalToolAllowlist(toolOptions),
  });
  const session = options.session ?? core.createSession();
  const response = await core.respond(session, options.input, { memory: options.memory });
  return { session, requests, answer: response.text };
}

function resultValue(request: AIRequest): Record<string, unknown> {
  const message = request.messages.at(-1);
  assert.equal(message?.role, 'tool');
  const payload = JSON.parse(message?.content ?? '{}') as { value: Record<string, unknown> };
  return payload.value;
}

const savedDocument = {
  version: 1,
  sessions: {
    older: snapshot(SAVED_AT_OLD, 'Proyecto Yuki 🌸', 'OLDER-PRIVATE-MESSAGE'),
    newer_a: snapshot(SAVED_AT_NEW, 'Proyecto Yuki 🌸', 'NEWER-A-PRIVATE-MESSAGE'),
    legacy: snapshot('2026-09-21T10:00:00.000Z', undefined, 'LEGACY-PRIVATE-MESSAGE'),
  },
};

test('saved conversation list returns newest-first metadata only and preserves duplicate titles by ID', async () => {
  await withSavedStore(async (store, path) => {
    const before = await readFile(path, 'utf8');
    const result = await askSavedSessions({ store, input: '¿Qué conversaciones tengo guardadas?', operation: 'list' });
    const value = resultValue(result.requests[1] as AIRequest);
    assert.equal(value.operation, 'list');
    assert.deepEqual(value.sessions, [
      { name: 'newer_a', title: 'Proyecto Yuki 🌸', messageCount: 2, savedAt: SAVED_AT_NEW },
      { name: 'legacy', title: 'Sin título', messageCount: 2, savedAt: '2026-09-21T10:00:00.000Z' },
      { name: 'older', title: 'Proyecto Yuki 🌸', messageCount: 2, savedAt: SAVED_AT_OLD },
    ]);
    const serialized = JSON.stringify(value);
    assert.equal(serialized.includes('PRIVATE-MESSAGE'), false);
    assert.equal(serialized.includes('reply-'), false);
    assert.equal(JSON.stringify(result.session.getMessages()).includes('"sessions"'), false);
    assert.equal(await readFile(path, 'utf8'), before);
    assert.deepEqual(result.session.getMessages().map(({ role }) => role), ['user', 'assistant']);
    assert.equal(result.session.getMessages().some(({ content }) => content.includes('OLDER-PRIVATE')), false);
  }, savedDocument);
});

test('saved conversation count returns only a count', async () => {
  await withSavedStore(async (store) => {
    const result = await askSavedSessions({ store, input: '¿Cuántas conversaciones guardadas tengo?', operation: 'count' });
    assert.deepEqual(resultValue(result.requests[1] as AIRequest), { operation: 'count', count: 3 });
  }, savedDocument);
});

test('most recent saved conversation uses existing store ordering and returns metadata only', async () => {
  await withSavedStore(async (store) => {
    const result = await askSavedSessions({
      store, input: '¿Cuál fue mi conversación guardada más reciente?', operation: 'recent',
    });
    assert.deepEqual(resultValue(result.requests[1] as AIRequest), {
      operation: 'recent',
      session: { name: 'newer_a', title: 'Proyecto Yuki 🌸', messageCount: 2, savedAt: SAVED_AT_NEW },
    });
  }, savedDocument);
});

test('session metadata lookup selects only the requested ID and missing IDs are controlled', async () => {
  await withSavedStore(async (store) => {
    const found = await askSavedSessions({
      store, input: 'Muéstrame la información de la sesión newer_a.', operation: 'info', sessionId: 'newer_a',
    });
    assert.deepEqual(resultValue(found.requests[1] as AIRequest), {
      operation: 'info', found: true,
      session: { name: 'newer_a', title: 'Proyecto Yuki 🌸', messageCount: 2, savedAt: SAVED_AT_NEW },
    });
    const missing = await askSavedSessions({
      store, input: 'Muéstrame la información de la sesión missing_id.', operation: 'info', sessionId: 'missing_id',
    });
    assert.deepEqual(resultValue(missing.requests[1] as AIRequest), {
      operation: 'info', found: false, session: null,
    });
  }, savedDocument);
});

test('query operation must match the user intent to prevent unnecessary metadata disclosure', async () => {
  await withSavedStore(async (store) => {
    const result = await askSavedSessions({
      store,
      input: '¿Cuál fue mi conversación guardada más reciente?',
      operation: 'list',
    });
    const response = JSON.parse(result.requests[1]?.messages.at(-1)?.content ?? '{}') as Record<string, unknown>;
    assert.equal(response.status, 'failure');
    assert.equal((response.error as { code: string }).code, 'TOOL_PERMISSION_ERROR');
    assert.equal(Object.hasOwn(response, 'value'), false);
  }, savedDocument);
});

test('empty saved-session store has controlled list, count and recent results', async () => {
  await withSavedStore(async (store) => {
    const list = await askSavedSessions({ store, input: '¿Qué conversaciones tengo guardadas?', operation: 'list' });
    const count = await askSavedSessions({ store, input: '¿Cuántas sesiones guardadas tengo?', operation: 'count' });
    const recent = await askSavedSessions({ store, input: '¿Cuál es mi conversación guardada más reciente?', operation: 'recent' });
    assert.deepEqual(resultValue(list.requests[1] as AIRequest), { operation: 'list', sessions: [] });
    assert.deepEqual(resultValue(count.requests[1] as AIRequest), { operation: 'count', count: 0 });
    assert.deepEqual(resultValue(recent.requests[1] as AIRequest), { operation: 'recent', session: null });
  });
});

test('open, delete and rename requests cannot execute a saved-session operation', async () => {
  await withSavedStore(async (store, path) => {
    const before = await readFile(path, 'utf8');
    const current = new Session('active-session-id');
    current.setTitle('Current active 🌙');
    current.markSaved('older');
    current.addMessage('user', 'Active conversation stays here');
    current.addMessage('assistant', 'Existing answer');
    const priorMessages = current.getMessages().map(({ role, content }) => ({ role, content }));
    const cases = [
      'Abre la conversación guardada older.',
      'Borra la sesión older.',
      'Renombra la conversación guardada older.',
    ];
    const memory = new PersistentMemoryStore(join(path, '..', 'memory.json'));
    await memory.load();
    await memory.set('private-key', 'PRIVATE-MEMORY-VALUE');
    const memoryBefore = await readFile(memory.filePath, 'utf8');
    for (const input of cases) {
      const result = await askSavedSessions({
        store, input, operation: 'list', session: current,
        memory: await memory.snapshot(),
        finalText: 'Usa el comando explícito de sesiones para esa acción.',
      });
      const denied = JSON.parse((result.requests[1]?.messages.at(-1)?.content) ?? '{}') as Record<string, unknown>;
      assert.equal(denied.status, 'failure');
      assert.equal((denied.error as { code: string }).code, 'TOOL_PERMISSION_ERROR');
      assert.match(result.answer, /comando explícito/u);
      assert.equal(result.session.id, 'active-session-id');
      assert.equal(result.session.title, 'Current active 🌙');
      assert.equal(result.session.savedName, 'older');
      assert.deepEqual(result.session.getMessages().slice(0, 2).map(({ role, content }) => ({ role, content })), priorMessages);
      assert.equal(result.requests.some((request) => request.messages.some(({ content }) => content.includes('<memory-data>'))), false);
    }
    assert.equal(await readFile(path, 'utf8'), before);
    assert.equal(await readFile(memory.filePath, 'utf8'), memoryBefore);
  }, savedDocument);
});

test('saved-session metadata queries do not send Persistent Memory or persist raw tool payload', async () => {
  await withSavedStore(async (store, path) => {
    const before = await readFile(path, 'utf8');
    const directory = join(path, '..');
    const memory = new PersistentMemoryStore(join(directory, 'memory.json'));
    await memory.load();
    await memory.set('private-memory-key', 'PRIVATE-MEMORY-VALUE');
    const memoryBefore = await readFile(memory.filePath, 'utf8');
    const result = await askSavedSessions({
      store, input: '¿Qué conversaciones tengo guardadas?', operation: 'list', memory: await memory.snapshot(),
      session: new Session('memory-isolated-session'),
    });
    assert.equal(result.requests.some((request) => request.messages.some(({ content }) => content.includes('<memory-data>'))), false);
    assert.equal(result.requests.some((request) => request.messages.some(({ content }) => content.includes('PRIVATE-MEMORY-VALUE'))), false);
    assert.equal(result.session.getMessages().some(({ content }) => content.includes('OLDER-PRIVATE-MESSAGE')), false);
    assert.equal(result.session.getMessages().some(({ content }) => content.includes('PRIVATE-MEMORY-VALUE')), false);
    assert.equal(JSON.stringify(result.session.getMessages()).includes('"sessions"'), false);
    assert.equal(await readFile(memory.filePath, 'utf8'), memoryBefore);
    assert.equal(await readFile(path, 'utf8'), before);
  }, savedDocument);
});
