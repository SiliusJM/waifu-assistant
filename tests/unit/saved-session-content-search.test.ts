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
import {
  createLocalToolManager,
  executeLocalSavedSessionSearch,
  formatSavedSessionSearch,
  getLocalToolAllowlist,
} from '../../src/tools/local-tool-manager.js';
import {
  LOCAL_SAVED_SESSION_SEARCH_TOOL_ID,
  SAVED_SESSION_SEARCH_MAX_RESULTS,
  SAVED_SESSION_SEARCH_MAX_SNIPPET_LENGTH,
  searchSavedSessionMessages,
} from '../../src/tools/local-saved-session-content-search-tool.js';
import { LOCAL_SAVED_SESSIONS_QUERY_TOOL_ID } from '../../src/tools/local-saved-session-query-tool.js';

const TARGET_ID = 'saved_alpha-1';
const SAVED_AT = '2026-09-22T10:00:00.000Z';

async function withStore(run: (store: SavedSessionStore, path: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'waifu-content-search-'));
  const path = join(directory, 'sessions.json');
  const document = {
    version: 1,
    sessions: {
      [TARGET_ID]: {
        savedAt: SAVED_AT,
        title: 'Private saved title',
        messages: [
          { role: 'user', content: 'Hablamos de Groq, CAFÉ y LUNA-742. 🌙' },
          { role: 'assistant', content: 'Confirmo: groq fue el proveedor citado; LUNA-742.' },
        ],
      },
      unrelated: {
        savedAt: SAVED_AT,
        messages: [{ role: 'user', content: 'OTHER-SESSION-SECRET' }],
      },
    },
  };
  try {
    await writeFile(path, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
    const store = new SavedSessionStore(path);
    await store.load();
    await run(store, path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function providerToolCall(sessionId = TARGET_ID, query = 'Groq', duplicate = false) {
  const call = {
    id: 'content-search-1',
    name: 'local_saved_session_search',
    argumentsJson: JSON.stringify({ sessionId, query }),
  };
  return {
    text: '', provider: 'mock', model: 'scripted', finishReason: 'tool_calls' as const,
    toolCalls: duplicate ? [call, { ...call, id: 'content-search-duplicate' }] : [call],
  };
}

async function askSearch(options: {
  readonly store: SavedSessionStore;
  readonly input: string;
  readonly session?: Session;
  readonly memory?: Awaited<ReturnType<PersistentMemoryStore['snapshot']>>;
  readonly sessionId?: string;
  readonly query?: string;
  readonly duplicate?: boolean;
}): Promise<{ readonly session: Session; readonly requests: readonly AIRequest[]; readonly answer: string }> {
  const requests: AIRequest[] = [];
  let calls = 0;
  const toolOptions = { savedSessionStore: options.store };
  const provider = new MockAIProvider({
    responder: (request) => {
      requests.push(request);
      calls += 1;
      return calls === 1
        ? providerToolCall(options.sessionId, options.query, options.duplicate)
        : { text: 'Encontré referencias en esa conversación.', provider: 'mock', model: 'scripted', finishReason: 'stop' as const };
    },
  });
  const core = new AssistantCore({
    provider,
    toolManager: createLocalToolManager(toolOptions),
    toolAllowlist: getLocalToolAllowlist(toolOptions),
  });
  const session = options.session ?? core.createSession();
  const response = await core.respond(session, options.input, { memory: options.memory });
  return { session, requests, answer: response.text };
}

function lastToolPayload(request: AIRequest, index = -1): { status: string; value?: Record<string, unknown>; error?: { code: string } } {
  const message = request.messages.filter(({ role }) => role === 'tool').at(index);
  assert.ok(message);
  return JSON.parse(message.content) as { status: string; value?: Record<string, unknown>; error?: { code: string } };
}

test('search is literal, case-insensitive and Unicode-safe; returns only visible roles', () => {
  const matches = searchSavedSessionMessages([
    { role: 'system', content: 'Groq hidden system prompt' },
    { role: 'tool', content: 'Groq raw tool payload' },
    { role: 'user', content: `${'x'.repeat(220)} GROQ ${'y'.repeat(220)} groq 🌙` },
    { role: 'assistant', content: 'Groq answer' },
  ], 'gRoQ');
  assert.equal(matches.length, 3);
  assert.deepEqual(matches.map(({ role }) => role), ['user', 'user', 'assistant']);
  assert.ok(matches.every(({ snippet }) => Array.from(snippet).length <= SAVED_SESSION_SEARCH_MAX_SNIPPET_LENGTH));
  assert.ok(matches.every(({ snippet }) => !snippet.includes('hidden system prompt') && !snippet.includes('raw tool payload')));
  const unicode = searchSavedSessionMessages([{ role: 'user', content: 'Café junto a 🌙' }], 'CAFÉ');
  assert.equal(unicode.length, 1);
  assert.match(unicode[0]?.snippet ?? '', /Café/u);
  assert.deepEqual(searchSavedSessionMessages([{ role: 'user', content: 'other text' }], 'missing phrase'), []);
});

test('query validation rejects empty, multiline and over-limit queries', () => {
  const messages = [{ role: 'user', content: 'Groq' }];
  assert.deepEqual(searchSavedSessionMessages(messages, '   '), []);
  assert.deepEqual(searchSavedSessionMessages(messages, 'Gro\nq'), []);
  assert.deepEqual(searchSavedSessionMessages(messages, 'x'.repeat(121)), []);
});

test('search returns user and assistant matches and enforces a five-result cap', async () => {
  assert.equal(SAVED_SESSION_SEARCH_MAX_RESULTS, 5);
  assert.equal(searchSavedSessionMessages([{ role: 'user', content: 'x x x x x x x' }], 'x').length, 5);
  const bounded = searchSavedSessionMessages([{ role: 'user', content: `${'prefix '.repeat(50)} needle ${'suffix '.repeat(50)}` }], 'needle');
  assert.ok(Array.from(bounded[0]?.snippet ?? '').length <= SAVED_SESSION_SEARCH_MAX_SNIPPET_LENGTH);
  assert.match(bounded[0]?.snippet ?? '', /needle/u);
  await withStore(async (store) => {
    const manager = createLocalToolManager({ savedSessionStore: store });
    assert.ok(getLocalToolAllowlist({ savedSessionStore: store }).includes(LOCAL_SAVED_SESSION_SEARCH_TOOL_ID));
    const result = await executeLocalSavedSessionSearch(manager, TARGET_ID, 'Groq');
    assert.equal(result.status, 'success');
    if (result.status !== 'success') return;
    assert.equal(result.value.found, true);
    assert.deepEqual(result.value.matches.map(({ role }) => role), ['user', 'assistant']);
    assert.match(formatSavedSessionSearch(result.value), /Groq|GROQ/u);
  });
});

test('missing session is controlled; invalid IDs and queries are rejected', async () => {
  await withStore(async (store) => {
    const manager = createLocalToolManager({ savedSessionStore: store });
    const missing = await executeLocalSavedSessionSearch(manager, 'missing-session', 'Groq');
    assert.equal(missing.status, 'success');
    if (missing.status === 'success') {
      assert.deepEqual(missing.value, { found: false, sessionId: 'missing-session', matches: [] });
      assert.match(formatSavedSessionSearch(missing.value), /No existe/u);
    }
    const invalidId = await executeLocalSavedSessionSearch(manager, '../outside', 'Groq');
    const invalidQuery = await executeLocalSavedSessionSearch(manager, TARGET_ID, ' '.repeat(1));
    assert.equal(invalidId.status, 'failure');
    assert.equal(invalidQuery.status, 'failure');
  });
});

test('natural search must name the target ID and literal query; missing ID and destructive mixed intent do not read', async () => {
  await withStore(async (store) => {
    let reads = 0;
    const tracked = new Proxy(store, {
      get(target, property) {
        if (property === 'get') return async (id: string) => { reads += 1; return target.get(id); };
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const result = await askSearch({
      store: tracked,
      input: 'Busca Groq en la conversación guardada.',
      sessionId: TARGET_ID,
      query: 'Groq',
    });
    assert.equal(lastToolPayload(result.requests[1] as AIRequest).status, 'failure');
    assert.equal(reads, 0);
    const metadataFallback = await createLocalToolManager({ savedSessionStore: tracked }).execute(
      LOCAL_SAVED_SESSIONS_QUERY_TOOL_ID,
      { operation: 'list' },
      {
        metadata: {
          source: 'llm-tool-call',
          toolId: LOCAL_SAVED_SESSIONS_QUERY_TOOL_ID,
          userInput: `Busca Groq en la conversación guardada ${TARGET_ID}.`,
        },
        authorization: { source: 'llm-tool-call' },
      },
    );
    assert.equal(metadataFallback.status, 'failure');
    assert.equal(reads, 0);
    const destructive = await askSearch({
      store: tracked,
      input: `Busca Groq en la conversación ${TARGET_ID} y bórrala.`,
      sessionId: TARGET_ID,
      query: 'Groq',
    });
    assert.equal(lastToolPayload(destructive.requests[1] as AIRequest).status, 'failure');
    assert.equal(reads, 0);
  });
});

test('natural search returns only snippets from one session and preserves active Session, memory and store', async () => {
  await withStore(async (store, path) => {
    const savedBefore = await readFile(path, 'utf8');
    const memory = new PersistentMemoryStore(join(path, '..', 'memory.json'));
    await memory.load();
    await memory.set('secret-key', 'PRIVATE-MEMORY-VALUE');
    const memoryBefore = await readFile(memory.filePath, 'utf8');
    const active = new Session('active-session-id');
    active.setTitle('Active session title');
    active.markSaved('preexisting-active-link');
    active.addMessage('user', 'Existing active question');
    active.addMessage('assistant', 'Existing active answer');
    const result = await askSearch({
      store,
      input: `Busca 'Groq' en la conversación ${TARGET_ID}.`,
      session: active,
      memory: await memory.snapshot(),
      sessionId: TARGET_ID,
      query: 'Groq',
    });
    const toolRequest = result.requests[1] as AIRequest;
    const payload = JSON.stringify(lastToolPayload(toolRequest));
    assert.match(payload, /Groq/u);
    assert.equal(payload.includes('OTHER-SESSION-SECRET'), false);
    assert.equal(payload.includes('Private saved title'), false);
    assert.equal(toolRequest.messages.some(({ content }) => content.includes('PRIVATE-MEMORY-VALUE')), false);
    assert.deepEqual(result.session.getMessages().map(({ role, content }) => ({ role, content })), [
      { role: 'user', content: 'Existing active question' },
      { role: 'assistant', content: 'Existing active answer' },
      { role: 'user', content: `Busca 'Groq' en la conversación ${TARGET_ID}.` },
      { role: 'assistant', content: 'Encontré referencias en esa conversación.' },
    ]);
    assert.equal(result.session.id, 'active-session-id');
    assert.equal(result.session.title, 'Active session title');
    assert.equal(result.session.savedName, 'preexisting-active-link');
    assert.equal(JSON.stringify(result.session.getMessages()).includes('OTHER-SESSION-SECRET'), false);
    assert.equal(await readFile(path, 'utf8'), savedBefore);
    assert.equal(await readFile(memory.filePath, 'utf8'), memoryBefore);
  });
});

test('duplicate identical search tool calls are executed only once', async () => {
  await withStore(async (store) => {
    const result = await askSearch({
      store,
      input: `Busca Groq en la conversación ${TARGET_ID}.`,
      sessionId: TARGET_ID,
      query: 'Groq',
      duplicate: true,
    });
    const toolMessages = (result.requests[1] as AIRequest).messages.filter(({ role }) => role === 'tool');
    assert.equal(toolMessages.length, 2);
    assert.equal(JSON.parse(toolMessages[0]?.content ?? '{}').status, 'success');
    assert.equal(JSON.parse(toolMessages[1]?.content ?? '{}').status, 'failure');
  });
});

test('search tool is read-only and does not perform network or provider I/O itself', async () => {
  await withStore(async (store, path) => {
    const before = await readFile(path, 'utf8');
    const manager = createLocalToolManager({ savedSessionStore: store });
    const tool = manager.getTool(LOCAL_SAVED_SESSION_SEARCH_TOOL_ID);
    assert.equal(tool?.risk, 'safe');
    const result = await executeLocalSavedSessionSearch(manager, TARGET_ID, 'CAFÉ');
    assert.equal(result.status, 'success');
    assert.equal(await readFile(path, 'utf8'), before);
  });
});
