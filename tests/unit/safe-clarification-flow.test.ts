import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AIProvider } from '../../src/ai/ai-provider.js';
import type { AIRequest, AIResponse, AIStreamEvent, ProviderCallOptions } from '../../src/ai/ai-types.js';
import { MockAIProvider } from '../../src/ai/mock-ai-provider.js';
import { AssistantCore } from '../../src/core/assistant-core.js';
import { ConversationRunner } from '../../src/core/conversation-runner.js';
import { SafeClarificationFlow } from '../../src/core/safe-clarification-flow.js';
import { SavedSessionStore } from '../../src/core/saved-session-store.js';
import { NoteStore } from '../../src/notes/note-store.js';
import { PersistentMemoryStore } from '../../src/memory/memory-store.js';
import { ReminderStore } from '../../src/reminders/reminder-store.js';
import { createLocalToolManager, getLocalToolAllowlist } from '../../src/tools/local-tool-manager.js';
import { LOCAL_REMINDER_CREATE_TOOL_ID } from '../../src/tools/local-reminder-create-tool.js';

const FIXED_NOW = new Date(2026, 8, 23, 12, 0, 0);
const SAVED_ID = 's-ab12cd34';

async function withStores(run: (stores: {
  readonly directory: string;
  readonly reminders: ReminderStore;
  readonly notes: NoteStore;
  readonly sessions: SavedSessionStore;
}) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'waifu-safe-clarification-'));
  const reminders = new ReminderStore(join(directory, 'reminders.json'), { now: () => new Date(FIXED_NOW) });
  const notes = new NoteStore(join(directory, 'notes.json'), { now: () => new Date(FIXED_NOW) });
  const sessionsPath = join(directory, 'sessions.json');
  await writeFile(sessionsPath, `${JSON.stringify({
    version: 1,
    sessions: {
      [SAVED_ID]: {
        savedAt: '2026-09-22T10:00:00.000Z',
        title: 'Trip notes',
        messages: [
          { role: 'user', content: 'We compared Groq and other routes.' },
          { role: 'assistant', content: 'Groq was mentioned.' },
        ],
      },
    },
  }, null, 2)}\n`, 'utf8');
  const sessions = new SavedSessionStore(sessionsPath);
  try {
    await Promise.all([reminders.load(), notes.load(), sessions.load()]);
    await run({ directory, reminders, notes, sessions });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function* inputs(values: readonly string[]): AsyncIterable<string> {
  yield* values;
}

async function runFlow(
  stores: { readonly reminders: ReminderStore; readonly notes: NoteStore; readonly sessions: SavedSessionStore },
  values: readonly string[],
  options: {
    readonly onCommand?: (command: string) => void | Promise<void>;
    readonly onDelta?: (text: string) => void | Promise<void>;
    readonly signal?: AbortSignal;
    readonly sessionId?: string;
    readonly now?: () => Date;
    readonly onReminderCreated?: () => void | Promise<void>;
  } = {},
) {
  let providerCalls = 0;
  const toolOptions = {
    now: options.now ?? (() => new Date(FIXED_NOW)),
    reminderStore: stores.reminders,
    noteStore: stores.notes,
    savedSessionStore: stores.sessions,
  };
  const provider = new MockAIProvider({
    responder: () => {
      providerCalls += 1;
      return { text: 'Respuesta normal.', provider: 'mock', model: 'scripted', finishReason: 'stop' };
    },
  });
  const core = new AssistantCore({ provider, toolManager: createLocalToolManager(toolOptions), toolAllowlist: getLocalToolAllowlist(toolOptions) });
  const runner = new ConversationRunner(core, options.sessionId ? core.createSession() : undefined);
  const flow = new SafeClarificationFlow({
    toolManager: createLocalToolManager(toolOptions),
    sessionId: runner.session.id,
    now: options.now ?? (() => new Date(FIXED_NOW)),
    onReminderCreated: options.onReminderCreated,
  });
  const result = await runner.run(inputs(values), {
    signal: options.signal,
    interruptible: true,
    clarification: flow,
    onCommand: async (command) => { await options.onCommand?.(command); },
    onDelta: options.onDelta,
  });
  return { runner, flow, result, providerCalls };
}

test('ambiguous tomorrow reminder asks once, resolves local hour and creates exactly one tool-backed reminder', async () => {
  await withStores(async ({ reminders, notes, sessions }) => {
    let refreshes = 0;
    const outcome = await runFlow({ reminders, notes, sessions }, [
      'Recuérdame mañana comprar pan.',
      'A las 8.',
      '/exit',
    ], { onReminderCreated: () => { refreshes += 1; } });
    const saved = await reminders.list({ all: true });
    assert.equal(outcome.providerCalls, 0);
    assert.equal(saved.length, 1);
    assert.equal(saved[0]?.text, 'comprar pan');
    const due = new Date(saved[0]?.dueAt ?? '');
    assert.equal(due.getFullYear(), 2026);
    assert.equal(due.getMonth(), 8);
    assert.equal(due.getDate(), 24);
    assert.equal(due.getHours(), 8);
    assert.equal(due.getMinutes(), 0);
    assert.equal(refreshes, 1);
    assert.match(outcome.runner.session.getMessages()[1]?.content ?? '', /¿A qué hora local/u);
    assert.match(outcome.runner.session.getMessages()[3]?.content ?? '', /Recordatorio creado/u);
    assert.deepEqual(outcome.runner.session.getMessages().map(({ role }) => role), ['user', 'assistant', 'user', 'assistant']);
  });
});

test('invalid reminder follow-up and cancellation never write a reminder or loop for another clarification', async () => {
  await withStores(async ({ reminders, notes, sessions }) => {
    const outcome = await runFlow({ reminders, notes, sessions }, [
      'Recuérdame mañana comprar pan.',
      'A las 25.',
      '/exit',
    ]);
    assert.equal((await reminders.list({ all: true })).length, 0);
    assert.equal(outcome.providerCalls, 0);
    assert.match(outcome.runner.session.getMessages()[3]?.content ?? '', /sin guardarlo/u);
  });
  await withStores(async ({ reminders, notes, sessions }) => {
    const outcome = await runFlow({ reminders, notes, sessions }, [
      'Recuérdame mañana comprar pan.',
      'Olvídalo.',
      'Hablemos de música.',
      '/exit',
    ]);
    assert.equal((await reminders.list({ all: true })).length, 0);
    assert.equal(outcome.providerCalls, 1);
    assert.match(outcome.runner.session.getMessages()[3]?.content ?? '', /Cancelé la aclaración/u);
    assert.equal(outcome.runner.session.getMessages()[4]?.content, 'Hablemos de música.');
  });
});

test('saved conversation search asks for ID and executes one literal search only after a valid ID', async () => {
  await withStores(async ({ reminders, notes, sessions, directory }) => {
    const before = await readFile(sessions.filePath, 'utf8');
    const outcome = await runFlow({ reminders, notes, sessions }, [
      "Busca 'Groq' en una conversación guardada.",
      SAVED_ID,
      '/exit',
    ]);
    assert.equal(outcome.providerCalls, 0);
    assert.match(outcome.runner.session.getMessages()[1]?.content ?? '', /¿Qué ID/u);
    assert.match(outcome.runner.session.getMessages()[3]?.content ?? '', /Groq/u);
    assert.equal((await readFile(sessions.filePath, 'utf8')), before);
    assert.equal(await readFile(join(directory, 'reminders.json'), 'utf8').then(() => true, () => false), false);
  });
});

test('invalid saved-session ID is controlled and does not access the store', async () => {
  await withStores(async ({ reminders, notes, sessions }) => {
    let reads = 0;
    const tracked = new Proxy(sessions, {
      get(target, property) {
        if (property === 'get') return async () => { reads += 1; return undefined; };
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const toolOptions = { reminderStore: reminders, noteStore: notes, savedSessionStore: tracked };
    const provider = new MockAIProvider({ responseText: 'unused' });
    const core = new AssistantCore({ provider, toolManager: createLocalToolManager(toolOptions), toolAllowlist: getLocalToolAllowlist(toolOptions) });
    const runner = new ConversationRunner(core);
    const flow = new SafeClarificationFlow({ toolManager: createLocalToolManager(toolOptions), sessionId: runner.session.id, now: () => new Date(FIXED_NOW) });
    await runner.run(inputs(["Busca 'Groq' en una conversación guardada.", '../invalid', '/exit']), { clarification: flow });
    assert.equal(reads, 0);
    assert.match(runner.session.getMessages()[3]?.content ?? '', /ID no es válido/u);
  });
});

test('ambiguous note asks for explicit content and creates one note through ToolManager', async () => {
  await withStores(async ({ reminders, notes, sessions }) => {
    const outcome = await runFlow({ reminders, notes, sessions }, [
      'Guarda eso como nota.',
      'Comprar pan mañana 🌸',
      '/exit',
    ]);
    const savedNotes = await notes.list();
    assert.equal(outcome.providerCalls, 0);
    assert.equal(savedNotes.length, 1);
    assert.equal(savedNotes[0]?.text, 'Comprar pan mañana 🌸');
    assert.match(outcome.runner.session.getMessages()[1]?.content ?? '', /No asumiré/u);
    assert.match(outcome.runner.session.getMessages()[3]?.content ?? '', /Nota guardada/u);
  });
  await withStores(async ({ reminders, notes, sessions }) => {
    const outcome = await runFlow({ reminders, notes, sessions }, [
      'Guarda eso como nota.',
      '¿Qué hora es?',
      '/exit',
    ]);
    assert.equal((await notes.list()).length, 0);
    assert.equal(outcome.providerCalls, 1);
    assert.equal(outcome.runner.session.getMessages()[2]?.content, '¿Qué hora es?');
  });
  await withStores(async ({ reminders, notes, sessions }) => {
    const outcome = await runFlow({ reminders, notes, sessions }, [
      'Guarda eso como nota.',
      'Recuérdame mañana pagar la luz.',
      '/exit',
    ]);
    assert.equal((await reminders.list({ all: true })).length, 0);
    assert.equal((await notes.list()).length, 0);
    assert.equal(outcome.providerCalls, 0);
  });
});

test('ambiguous saved-session metadata asks for ID and returns only metadata', async () => {
  await withStores(async ({ reminders, notes, sessions }) => {
    const outcome = await runFlow({ reminders, notes, sessions }, [
      'Muéstrame esa conversación.',
      SAVED_ID,
      '/exit',
    ]);
    const reply = outcome.runner.session.getMessages()[3]?.content ?? '';
    assert.equal(outcome.providerCalls, 0);
    assert.match(outcome.runner.session.getMessages()[1]?.content ?? '', /¿Qué ID/u);
    assert.match(reply, /Trip notes/u);
    assert.equal(reply.includes('Groq'), false);
  });
});

test('slash commands and run termination clear pending clarification; it cannot cross runner sessions', async () => {
  await withStores(async ({ reminders, notes, sessions }) => {
    let cleared = 0;
    const outcome = await runFlow({ reminders, notes, sessions }, [
      'Recuérdame mañana comprar pan.',
      '/clear',
      'A las 8.',
      '/exit',
    ], { onCommand: (command) => { if (command === '/clear') cleared += 1; } });
    assert.equal(cleared, 1);
    assert.equal((await reminders.list({ all: true })).length, 0);
    assert.equal(outcome.providerCalls, 1);
  });
  await withStores(async ({ reminders, notes, sessions }) => {
    const toolOptions = { reminderStore: reminders, noteStore: notes, savedSessionStore: sessions };
    const flow = new SafeClarificationFlow({ toolManager: createLocalToolManager(toolOptions), sessionId: 'runner-one', now: () => new Date(FIXED_NOW) });
    assert.match(await flow.handle('Recuérdame mañana comprar pan.', { sessionId: 'runner-one' }) ?? '', /¿A qué hora/u);
    assert.equal(await flow.handle('A las 8', { sessionId: 'runner-two' }), undefined);
    assert.equal(await flow.handle('A las 8', { sessionId: 'runner-one' }), undefined);
    assert.equal((await reminders.list({ all: true })).length, 0);
  });
});

test('load-session command clears pending state and malformed clarification authorization cannot be forged', async () => {
  await withStores(async ({ reminders, notes, sessions }) => {
    const outcome = await runFlow({ reminders, notes, sessions }, [
      'Recuérdame mañana comprar pan.',
      '/load-session demo',
      'A las 8.',
      '/exit',
    ], { onCommand: () => undefined });
    assert.equal((await reminders.list({ all: true })).length, 0);
    assert.equal(outcome.providerCalls, 1);
  });
  await withStores(async ({ reminders, notes, sessions }) => {
    const toolOptions = { reminderStore: reminders, noteStore: notes, savedSessionStore: sessions };
    const manager = createLocalToolManager(toolOptions);
    const denied = await manager.execute(LOCAL_REMINDER_CREATE_TOOL_ID, {
      text: 'comprar pan', dueAt: '2026-09-24T08:00:00-05:00',
    }, {
      metadata: { source: 'clarification', toolId: LOCAL_REMINDER_CREATE_TOOL_ID, kind: 'reminder-hour' },
      authorization: { source: 'clarification' },
    });
    assert.equal(denied.status, 'failure');
    assert.equal((await reminders.list({ all: true })).length, 0);
  });
});

test('latest-input cancellation and EOF discard clarification state without persisting pending fields', async () => {
  await withStores(async ({ reminders, notes, sessions }) => {
    const toolOptions = { reminderStore: reminders, noteStore: notes, savedSessionStore: sessions };
    const core = new AssistantCore({ provider: new MockAIProvider({ responseText: 'unused' }) });
    const runner = new ConversationRunner(core);
    const flow = new SafeClarificationFlow({ toolManager: createLocalToolManager(toolOptions), sessionId: runner.session.id, now: () => new Date(FIXED_NOW) });
    const controller = new AbortController();
    const before = JSON.stringify(flow);
    let serializedWhilePending = '';
    const result = await runner.run(inputs(['Recuérdame mañana comprar pan.']), {
      signal: controller.signal,
      clarification: flow,
      onDelta: () => { serializedWhilePending = JSON.stringify(flow); controller.abort(); },
    });
    assert.equal(result.status, 'cancelled');
    assert.equal(serializedWhilePending.includes('comprar pan'), false);
    assert.equal(serializedWhilePending.includes('reminder.create'), false);
    assert.equal(JSON.stringify(flow), before);
    assert.equal(await flow.handle('A las 8', { sessionId: runner.session.id }), undefined);
    assert.equal((await reminders.list({ all: true })).length, 0);
  });
  await withStores(async ({ reminders, notes, sessions, directory }) => {
    const memory = new PersistentMemoryStore(join(directory, 'memory.json'));
    await memory.load();
    await memory.set('kept', 'memory-value');
    const memoryBefore = await readFile(memory.filePath, 'utf8');
    const toolOptions = { reminderStore: reminders, noteStore: notes, savedSessionStore: sessions };
    const core = new AssistantCore({ provider: new MockAIProvider({ responseText: 'unused' }) });
    const runner = new ConversationRunner(core);
    const flow = new SafeClarificationFlow({ toolManager: createLocalToolManager(toolOptions), sessionId: runner.session.id, now: () => new Date(FIXED_NOW) });
    const result = await runner.run(inputs(['Recuérdame mañana comprar pan.']), { clarification: flow });
    assert.equal(result.status, 'completed');
    assert.equal(await flow.handle('A las 8', { sessionId: runner.session.id }), undefined);
    assert.equal(await readFile(memory.filePath, 'utf8'), memoryBefore);
    assert.equal((await reminders.list({ all: true })).length, 0);
  });
});

test('latest-input-wins cancels an older provider turn before the latest ambiguous action enters clarification', async () => {
  await withStores(async ({ reminders, notes, sessions }) => {
    let markStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    let markClarificationShown!: () => void;
    const clarificationShown = new Promise<void>((resolve) => { markClarificationShown = resolve; });
    const providerInputs: string[] = [];
    const provider: AIProvider = {
      name: 'clarification-latest-input-test',
      async complete(): Promise<AIResponse> {
        return { text: 'unused', provider: 'clarification-latest-input-test', model: 'test', finishReason: 'stop' };
      },
      async *stream(request: AIRequest, options?: ProviderCallOptions): AsyncIterable<AIStreamEvent> {
        const userInput = request.messages.filter(({ role }) => role === 'user').at(-1)?.content ?? '';
        providerInputs.push(userInput);
        yield { type: 'text_delta', delta: 'old partial' };
        markStarted();
        await new Promise<void>((resolve) => {
          if (options?.signal?.aborted) { resolve(); return; }
          options?.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        throw new Error('superseded');
      },
    };
    const toolOptions = { now: () => new Date(FIXED_NOW), reminderStore: reminders, noteStore: notes, savedSessionStore: sessions };
    const core = new AssistantCore({ provider, toolManager: createLocalToolManager(toolOptions), toolAllowlist: getLocalToolAllowlist(toolOptions) });
    const runner = new ConversationRunner(core);
    const flow = new SafeClarificationFlow({ toolManager: createLocalToolManager(toolOptions), sessionId: runner.session.id, now: () => new Date(FIXED_NOW) });
    async function* sequence(): AsyncIterable<string> {
      yield 'older unrelated request';
      await firstStarted;
      yield 'Recuérdame mañana comprar pan.';
      await clarificationShown;
      yield 'A las 8.';
      yield '/exit';
    }
    await runner.run(sequence(), {
      interruptible: true,
      clarification: flow,
      onDelta: (text) => { if (text.includes('¿A qué hora local')) markClarificationShown(); },
    });
    const created = await reminders.list({ all: true });
    assert.deepEqual(providerInputs, ['older unrelated request']);
    assert.equal(created.length, 1);
    assert.equal(created[0]?.text, 'comprar pan');
    assert.equal(new Date(created[0]?.dueAt ?? '').getHours(), 8);
  });
});
