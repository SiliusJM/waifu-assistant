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
  readonly memory: PersistentMemoryStore;
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
  const memory = new PersistentMemoryStore(join(directory, 'memory.json'));
  try {
    await Promise.all([reminders.load(), notes.load(), sessions.load(), memory.load()]);
    await run({ directory, reminders, notes, sessions, memory });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function* inputs(values: readonly string[]): AsyncIterable<string> {
  yield* values;
}

async function runFlow(
  stores: { readonly reminders: ReminderStore; readonly notes: NoteStore; readonly sessions: SavedSessionStore; readonly memory?: PersistentMemoryStore },
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
    ...(stores.memory ? { memoryStore: stores.memory } : {}),
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

test('explicit memory update asks first and a clear yes writes exactly once', async () => {
  await withStores(async ({ reminders, notes, sessions, memory }) => {
    await memory.set('city', 'Cuenca');
    let updateCalls = 0;
    let valueBeforeConfirmation: string | undefined;
    const update = memory.update.bind(memory);
    memory.update = async (...args) => { updateCalls += 1; return update(...args); };
    const outcome = await runFlow({ reminders, notes, sessions, memory }, [
      'Ahora vivo en Guayaquil, cambia mi ciudad.', 'Sí', 'Sí', '/exit',
    ], { onDelta: async (text) => {
      if (text.includes('¿Quieres cambiarlo')) valueBeforeConfirmation = await memory.get('city');
    } });

    assert.equal(valueBeforeConfirmation, 'Cuenca');
    assert.equal(updateCalls, 1);
    assert.equal(await memory.get('city'), 'Guayaquil');
    assert.equal(outcome.providerCalls, 1);
    const visible = outcome.runner.session.getMessages().map(({ content }) => content);
    assert.match(visible[1] ?? '', /city = "Cuenca"/u);
    assert.match(visible[1] ?? '', /Guayaquil/u);
    assert.match(visible[3] ?? '', /Memoria actualizada: city/u);
  });
});

test('explicit new memory intent asks confirmation and yes creates exactly one entry without calling the provider', async () => {
  await withStores(async ({ reminders, notes, sessions, memory }) => {
    await memory.set('name', 'Jhon');
    let rememberCalls = 0;
    const remember = memory.remember.bind(memory);
    memory.remember = async (...args) => { rememberCalls += 1; return remember(...args); };
    const outcome = await runFlow({ reminders, notes, sessions, memory }, [
      'Recuerda que mi juego favorito es Genshin Impact.', 'sí', '/exit',
    ]);

    assert.equal(outcome.providerCalls, 0);
    assert.equal(rememberCalls, 1);
    assert.equal(await memory.get('favorite_game'), 'Genshin Impact');
    assert.equal(await memory.get('name'), 'Jhon');
    const visible = outcome.runner.session.getMessages().map(({ content }) => content);
    assert.match(visible[1] ?? '', /favorite_game = "Genshin Impact"/u);
    assert.match(visible[3] ?? '', /Memoria guardada: favorite_game/u);
    assert.doesNotMatch(visible[1] ?? '', /Jhon|city/u);
  });
});

test('explicit creation supports bounded Spanish intents and rejects casual statements', async () => {
  await withStores(async ({ reminders, notes, sessions, memory }) => {
    const flow = new SafeClarificationFlow({
      toolManager: createLocalToolManager({ reminderStore: reminders, noteStore: notes, savedSessionStore: sessions }),
      sessionId: 'bounded-create-intents',
      memoryStore: memory,
    });
    assert.equal(await flow.handle('Mi ciudad es Guayaquil.', { sessionId: 'bounded-create-intents' }), undefined);
    for (const [request, expected] of [
      ['Guarda en tu memoria que mi ciudad es Guayaquil.', 'city'],
      ['Quiero que recuerdes que mi nombre es Jhon.', 'name'],
      ['Memoriza que mi juego favorito es Genshin Impact.', 'favorite_game'],
    ] as const) {
      assert.match(await flow.handle(request, { sessionId: 'bounded-create-intents' }) ?? '', new RegExp(`${expected} =`));
      assert.match(await flow.handle('yes', { sessionId: 'bounded-create-intents' }) ?? '', new RegExp(`Memoria guardada: ${expected}`));
    }
    assert.deepEqual(await memory.list(), [
      { key: 'city', value: 'Guayaquil' },
      { key: 'favorite_game', value: 'Genshin Impact' },
      { key: 'name', value: 'Jhon' },
    ]);
  });
});

test('explicit create rejection, ambiguity, and topic change do not write or leave a reusable confirmation', async () => {
  await withStores(async ({ reminders, notes, sessions, memory }) => {
    const rejected = await runFlow({ reminders, notes, sessions, memory }, [
      'Recuerda que mi ciudad es Quito.', 'No, gracias.', 'yes', '/exit',
    ]);
    assert.equal(await memory.count(), 0);
    assert.equal(rejected.providerCalls, 1);
    assert.match(rejected.runner.session.getMessages()[3]?.content ?? '', /No guardé city/u);
  });
  await withStores(async ({ reminders, notes, sessions, memory }) => {
    const ambiguous = await runFlow({ reminders, notes, sessions, memory }, [
      'Recuerda que mi ciudad es Quito.', 'quizá', '/exit',
    ]);
    assert.equal(await memory.count(), 0);
    assert.equal(ambiguous.providerCalls, 0);
    assert.match(ambiguous.runner.session.getMessages()[3]?.content ?? '', /confirmación clara/u);
  });
  await withStores(async ({ reminders, notes, sessions, memory }) => {
    const flow = new SafeClarificationFlow({
      toolManager: createLocalToolManager({ reminderStore: reminders, noteStore: notes, savedSessionStore: sessions }),
      sessionId: 'create-topic-change',
      memoryStore: memory,
    });
    assert.match(await flow.handle('Recuerda que mi ciudad es Quito.', { sessionId: 'create-topic-change' }) ?? '', /¿Quieres que guarde/u);
    assert.equal(await flow.handle('Cambiemos de tema. Cuéntame un chiste.', { sessionId: 'create-topic-change' }), undefined);
    assert.equal(await flow.handle('Sí', { sessionId: 'create-topic-change' }), undefined);
    assert.equal(await memory.count(), 0);
  });
});

test('existing keys route to the existing update confirmation and never use create to overwrite', async () => {
  await withStores(async ({ reminders, notes, sessions, memory }) => {
    await memory.set('city', 'Cuenca');
    let rememberCalls = 0;
    let updateCalls = 0;
    const remember = memory.remember.bind(memory);
    const update = memory.update.bind(memory);
    memory.remember = async (...args) => { rememberCalls += 1; return remember(...args); };
    memory.update = async (...args) => { updateCalls += 1; return update(...args); };
    const outcome = await runFlow({ reminders, notes, sessions, memory }, [
      'Recuerda que mi ciudad es Guayaquil.', 'yes', '/exit',
    ]);
    assert.equal(await memory.get('city'), 'Guayaquil');
    assert.equal(rememberCalls, 0);
    assert.equal(updateCalls, 1);
    assert.equal(outcome.providerCalls, 0);
    assert.match(outcome.runner.session.getMessages()[1]?.content ?? '', /Cuenca/u);
    assert.match(outcome.runner.session.getMessages()[1]?.content ?? '', /¿Quieres cambiarlo/u);
  });
  await withStores(async ({ reminders, notes, sessions, memory }) => {
    const conflict = new PersistentMemoryStore(memory.filePath);
    const toolOptions = { reminderStore: reminders, noteStore: notes, savedSessionStore: sessions };
    const flow = new SafeClarificationFlow({ toolManager: createLocalToolManager(toolOptions), sessionId: 'create-conflict', memoryStore: memory });
    assert.match(await flow.handle('Recuerda que mi juego favorito es Genshin Impact.', { sessionId: 'create-conflict' }) ?? '', /favorite_game/u);
    await conflict.remember('favorite_game', 'Stardew Valley');
    const response = await flow.handle('yes', { sessionId: 'create-conflict' });
    assert.match(response ?? '', /ya existe; no la sobrescribí/u);
    assert.equal(await memory.get('favorite_game'), 'Stardew Valley');
  });
});

test('multi-memory and sensitive create requests are rejected without exposing values', async () => {
  await withStores(async ({ reminders, notes, sessions, memory }) => {
    const multi = await runFlow({ reminders, notes, sessions, memory }, [
      'Recuerda mi ciudad, mi juego y mi correo.', '/exit',
    ]);
    assert.equal(await memory.count(), 0);
    assert.equal(multi.providerCalls, 0);
    assert.match(multi.runner.session.getMessages()[1]?.content ?? '', /una memoria por vez/u);
  });
  await withStores(async ({ reminders, notes, sessions, memory }) => {
    const multi = await runFlow({ reminders, notes, sessions, memory }, [
      'Recuerda que mi ciudad es Quito. Mi juego favorito es Genshin Impact.', '/exit',
    ]);
    assert.equal(await memory.count(), 0);
    assert.equal(multi.providerCalls, 0);
    assert.match(multi.runner.session.getMessages()[1]?.content ?? '', /una memoria por vez/u);
  });
  await withStores(async ({ reminders, notes, sessions, memory }) => {
    const sensitiveKey = await runFlow({ reminders, notes, sessions, memory }, [
      'Recuerda que mi contraseña es never-print-this-placeholder.', '/exit',
    ]);
    assert.equal(await memory.count(), 0);
    assert.equal(sensitiveKey.providerCalls, 0);
    assert.doesNotMatch(sensitiveKey.runner.session.getMessages()[1]?.content ?? '', /never-print-this-placeholder/u);
  });
  await withStores(async ({ reminders, notes, sessions, memory }) => {
    const sensitiveValue = await runFlow({ reminders, notes, sessions, memory }, [
      'Recuerda que mi ciudad es password is never-print-this-placeholder.', '/exit',
    ]);
    assert.equal(await memory.count(), 0);
    assert.equal(sensitiveValue.providerCalls, 0);
    assert.doesNotMatch(sensitiveValue.runner.session.getMessages()[1]?.content ?? '', /never-print-this-placeholder/u);
  });
});

test('duplicate confirmation cannot create twice and pending create state is not serialized', async () => {
  await withStores(async ({ reminders, notes, sessions, memory }) => {
    let rememberCalls = 0;
    const remember = memory.remember.bind(memory);
    memory.remember = async (...args) => { rememberCalls += 1; return remember(...args); };
    const outcome = await runFlow({ reminders, notes, sessions, memory }, [
      'Recuerda que mi ciudad es Guayaquil.', 'yes', 'yes', '/exit',
    ]);
    assert.equal(rememberCalls, 1);
    assert.equal(await memory.count(), 1);
    assert.equal(outcome.providerCalls, 1);
  });
  await withStores(async ({ reminders, notes, sessions, memory }) => {
    const flow = new SafeClarificationFlow({
      toolManager: createLocalToolManager({ reminderStore: reminders, noteStore: notes, savedSessionStore: sessions }),
      sessionId: 'pending-create',
      memoryStore: memory,
    });
    await flow.handle('Recuerda que mi ciudad es Guayaquil.', { sessionId: 'pending-create' });
    assert.doesNotMatch(JSON.stringify(flow), /memory-create|Guayaquil|city/u);
    assert.equal(await memory.count(), 0);
  });
  await withStores(async ({ reminders, notes, sessions, memory }) => {
    const toolOptions = { reminderStore: reminders, noteStore: notes, savedSessionStore: sessions };
    const runner = new ConversationRunner(new AssistantCore({ provider: new MockAIProvider({ responseText: 'unused' }) }));
    const flow = new SafeClarificationFlow({
      toolManager: createLocalToolManager(toolOptions),
      sessionId: runner.session.id,
      memoryStore: memory,
    });
    await runner.run(inputs(['Recuerda que mi ciudad es Guayaquil.']), {
      clarification: flow,
      onDelta: async () => {
        await sessions.save('visible-confirmation-only', runner.session.getMessages().map(({ role, content }) => ({ role, content })));
      },
    });
    const saved = await sessions.get('visible-confirmation-only');
    assert.deepEqual(saved?.messages.map(({ role }) => role), ['user', 'assistant']);
    assert.match(saved?.messages[1]?.content ?? '', /¿Quieres que guarde city/u);
    assert.doesNotMatch(JSON.stringify(saved?.messages), /memory-create|"value"/u);
    assert.equal(await memory.count(), 0);
  });
});

test('create pending state clears on /clear, /load-session, exit, invalid follow-up, and session change', async () => {
  for (const command of ['/clear', '/load-session demo', '/exit']) {
    await withStores(async ({ reminders, notes, sessions, memory }) => {
      const outcome = await runFlow({ reminders, notes, sessions, memory }, [
        'Recuerda que mi ciudad es Quito.', command, 'yes', '/exit',
      ]);
      assert.equal(await memory.count(), 0, command);
      assert.equal(outcome.providerCalls, command === '/exit' ? 0 : 1, command);
    });
  }
  await withStores(async ({ reminders, notes, sessions, memory }) => {
    const flow = new SafeClarificationFlow({
      toolManager: createLocalToolManager({ reminderStore: reminders, noteStore: notes, savedSessionStore: sessions }),
      sessionId: 'create-session-one',
      memoryStore: memory,
    });
    assert.match(await flow.handle('Recuerda que mi ciudad es Quito.', { sessionId: 'create-session-one' }) ?? '', /¿Quieres que guarde/u);
    assert.equal(await flow.handle('yes', { sessionId: 'create-session-two' }), undefined);
    assert.equal(await flow.handle('yes', { sessionId: 'create-session-one' }), undefined);
    assert.equal(await memory.count(), 0);
  });
});

test('a newly created memory is available to explicit contextual recall on the following turn', async () => {
  await withStores(async ({ reminders, notes, sessions, memory }) => {
    await runFlow({ reminders, notes, sessions, memory }, [
      'Recuerda que mi ciudad es Guayaquil.', 'yes', '/exit',
    ]);
    const requests: string[] = [];
    const core = new AssistantCore({ provider: new MockAIProvider({ responder: (request) => {
      requests.push(request.messages.map(({ content }) => content).join('\n'));
      return { text: 'Vives en Guayaquil.', provider: 'mock', model: 'scripted', finishReason: 'stop' };
    } }) });
    await core.respond(core.createSession(), '¿En qué ciudad vivo?', { memory: await memory.snapshot() });
    assert.match(requests[0] ?? '', /Guayaquil/u);
  });
});

test('memory update reject and ambiguous confirmation never write', async () => {
  await withStores(async ({ reminders, notes, sessions, memory }) => {
    await memory.set('favorite_game', 'Stardew Valley');
    const rejected = await runFlow({ reminders, notes, sessions, memory }, [
      'Actualiza favorite_game a Hades.', 'No, gracias.', '/exit',
    ]);
    assert.equal(await memory.get('favorite_game'), 'Stardew Valley');
    assert.match(rejected.runner.session.getMessages()[3]?.content ?? '', /No cambié favorite_game/u);
    assert.equal(rejected.providerCalls, 0);
  });
  await withStores(async ({ reminders, notes, sessions, memory }) => {
    await memory.set('favorite_game', 'Stardew Valley');
    const ambiguous = await runFlow({ reminders, notes, sessions, memory }, [
      'Actualiza favorite_game a Hades.', 'quizá', '/exit',
    ]);
    assert.equal(await memory.get('favorite_game'), 'Stardew Valley');
    assert.match(ambiguous.runner.session.getMessages()[3]?.content ?? '', /confirmación clara/u);
    assert.equal(ambiguous.providerCalls, 0);
  });
});

test('casual statement, missing key, bulk intent and secret-like memory never update', async () => {
  await withStores(async ({ reminders, notes, sessions, memory }) => {
    await memory.set('city', 'Cuenca');
    const casual = await runFlow({ reminders, notes, sessions, memory }, ['Ahora vivo en Guayaquil.', '/exit']);
    assert.equal(await memory.get('city'), 'Cuenca');
    assert.equal(casual.providerCalls, 1);
  });
  await withStores(async ({ reminders, notes, sessions, memory }) => {
    const missing = await runFlow({ reminders, notes, sessions, memory }, ['Cambia mi ciudad a Guayaquil.', '/exit']);
    assert.equal(await memory.count(), 0);
    assert.match(missing.runner.session.getMessages()[1]?.content ?? '', /no crearé una nueva/iu);
    assert.equal(missing.providerCalls, 0);
  });
  await withStores(async ({ reminders, notes, sessions, memory }) => {
    await memory.set('city', 'Cuenca');
    const bulk = await runFlow({ reminders, notes, sessions, memory }, ['Actualiza todas mis memorias a Guayaquil.', '/exit']);
    assert.equal(await memory.get('city'), 'Cuenca');
    assert.equal(bulk.providerCalls, 0);
  });
  await withStores(async ({ reminders, notes, sessions, memory }) => {
    await memory.set('city', 'Cuenca');
    await memory.set('name', 'Jhon');
    const multi = await runFlow({ reminders, notes, sessions, memory }, [
      'Actualiza city a Guayaquil y name a Ana.', '/exit',
    ]);
    assert.equal(await memory.get('city'), 'Cuenca');
    assert.equal(await memory.get('name'), 'Jhon');
    assert.match(multi.runner.session.getMessages()[1]?.content ?? '', /No pude identificar una sola memoria/u);
    assert.equal(multi.providerCalls, 0);
  });
  await withStores(async ({ reminders, notes, sessions, memory }) => {
    await memory.set('api_key', 'non-secret-test-placeholder');
    const sensitive = await runFlow({ reminders, notes, sessions, memory }, ['Actualiza api_key a another-placeholder.', '/exit']);
    assert.equal(await memory.get('api_key'), 'non-secret-test-placeholder');
    assert.doesNotMatch(sensitive.runner.session.getMessages()[1]?.content ?? '', /non-secret-test-placeholder|another-placeholder/u);
    assert.equal(sensitive.providerCalls, 0);
  });
});

test('memory update detects optimistic conflicts and clears pending state without exposing it', async () => {
  await withStores(async ({ reminders, notes, sessions, memory }) => {
    await memory.set('city', 'Cuenca');
    const toolOptions = { reminderStore: reminders, noteStore: notes, savedSessionStore: sessions };
    const manager = createLocalToolManager(toolOptions);
    const flow = new SafeClarificationFlow({ toolManager: manager, sessionId: 'memory-update-session', memoryStore: memory });
    const prompt = await flow.handle('Actualiza city a Guayaquil.', { sessionId: 'memory-update-session' });
    assert.match(prompt ?? '', /Cuenca/u);
    assert.doesNotMatch(JSON.stringify(flow), /oldValue|newValue|Guayaquil|Cuenca/u);
    await memory.set('city', 'Quito');
    const conflict = await flow.handle('Sí', { sessionId: 'memory-update-session' });
    assert.match(conflict ?? '', /cambió desde la solicitud/u);
    assert.equal(await memory.get('city'), 'Quito');
    assert.equal(await flow.handle('Sí', { sessionId: 'memory-update-session' }), undefined);
    assert.equal(await memory.get('city'), 'Quito');
  });
});

test('pending update data stays outside Session state and saved-session schema', async () => {
  await withStores(async ({ reminders, notes, sessions, memory }) => {
    await memory.set('city', 'Cuenca');
    const toolOptions = { reminderStore: reminders, noteStore: notes, savedSessionStore: sessions };
    const core = new AssistantCore({ provider: new MockAIProvider({ responseText: 'unused' }) });
    const runner = new ConversationRunner(core);
    const flow = new SafeClarificationFlow({
      toolManager: createLocalToolManager(toolOptions),
      sessionId: runner.session.id,
      memoryStore: memory,
    });
    let serializedWhilePending = '';
    await runner.run(inputs(['Actualiza city a Guayaquil.']), {
      clarification: flow,
      onDelta: async () => {
        serializedWhilePending = JSON.stringify(flow);
        await sessions.save('memory_update_pending', runner.session.getMessages().map(({ role, content }) => ({ role, content })));
      },
    });
    assert.doesNotMatch(serializedWhilePending, /oldValue|newValue|Cuenca|Guayaquil/u);
    const visibleMessages = runner.session.getMessages().map(({ role, content }) => ({ role, content }));
    const saved = await sessions.get('memory_update_pending');
    assert.deepEqual(saved?.messages, visibleMessages);
    assert.equal(JSON.stringify(saved?.messages).includes('oldValue'), false);
    assert.equal(JSON.stringify(saved?.messages).includes('newValue'), false);
  });
});

test('memory update pending state is cleared by /clear, load-session, exit, and session change', async () => {
  for (const command of ['/clear', '/load-session demo', '/exit']) {
    await withStores(async ({ reminders, notes, sessions, memory }) => {
      await memory.set('city', 'Cuenca');
      const outcome = await runFlow({ reminders, notes, sessions, memory }, [
        'Actualiza city a Guayaquil.', command, 'Sí', '/exit',
      ]);
      assert.equal(await memory.get('city'), 'Cuenca', command);
      assert.equal(outcome.providerCalls, command === '/exit' ? 0 : 1, command);
    });
  }
  await withStores(async ({ reminders, notes, sessions, memory }) => {
    await memory.set('city', 'Cuenca');
    const outcome = await runFlow({ reminders, notes, sessions, memory }, [
      'Actualiza city a Guayaquil.', 'Cambiemos de tema. Cuéntame un chiste.', '/exit',
    ]);
    assert.equal(await memory.get('city'), 'Cuenca');
    assert.equal(outcome.providerCalls, 1);
  });
  await withStores(async ({ reminders, notes, sessions, memory }) => {
    await memory.set('city', 'Cuenca');
    const flow = new SafeClarificationFlow({
      toolManager: createLocalToolManager({ reminderStore: reminders, noteStore: notes, savedSessionStore: sessions }),
      sessionId: 'original-session',
      memoryStore: memory,
    });
    assert.match(await flow.handle('Actualiza city a Guayaquil.', { sessionId: 'original-session' }) ?? '', /¿Quieres cambiarlo/u);
    assert.equal(await flow.handle('Sí', { sessionId: 'different-session' }), undefined);
    assert.equal(await flow.handle('Sí', { sessionId: 'original-session' }), undefined);
    assert.equal(await memory.get('city'), 'Cuenca');
  });
});

test('ambiguous natural key matches do not select or update either memory', async () => {
  await withStores(async ({ reminders, notes, sessions, memory }) => {
    await memory.set('city', 'Cuenca');
    await memory.set('home_city', 'Loja');
    const outcome = await runFlow({ reminders, notes, sessions, memory }, ['Cambia mi ciudad a Guayaquil.', '/exit']);
    assert.equal(await memory.get('city'), 'Cuenca');
    assert.equal(await memory.get('home_city'), 'Loja');
    assert.match(outcome.runner.session.getMessages()[1]?.content ?? '', /No encontré una única memoria/u);
    assert.equal(outcome.providerCalls, 0);
  });
});

test('updated memory is immediately available to contextual recall on the next turn', async () => {
  await withStores(async ({ reminders, notes, sessions, memory }) => {
    await memory.set('city', 'Cuenca');
    const result = await runFlow({ reminders, notes, sessions, memory }, [
      'Actualiza mi ciudad a Guayaquil.', 'Sí', '/exit',
    ]);
    assert.match(result.runner.session.getMessages().map(({ content }) => content).join('\n'), /Memoria actualizada: city/u);
    const requestContents: string[] = [];
    const core = new AssistantCore({
      provider: new MockAIProvider({ responder: (request) => {
        requestContents.push(request.messages.map(({ content }) => content).join('\n'));
        return { text: 'Guayaquil.', provider: 'mock', model: 'scripted', finishReason: 'stop' };
      } }),
    });
    await core.respond(core.createSession(), '¿En qué ciudad vivo?', { memory: await memory.snapshot() });
    assert.match(requestContents[0] ?? '', /Guayaquil/u);
    assert.doesNotMatch(requestContents[0] ?? '', /Cuenca/u);
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
