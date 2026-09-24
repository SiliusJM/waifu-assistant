import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AIRequest } from '../../src/ai/ai-types.js';
import type { MemorySnapshot } from '../../src/memory/memory-types.js';
import { MockAIProvider } from '../../src/ai/mock-ai-provider.js';
import { AssistantCore } from '../../src/core/assistant-core.js';
import { NoteStore } from '../../src/notes/note-store.js';
import { ReminderStore } from '../../src/reminders/reminder-store.js';
import { PersistentMemoryStore } from '../../src/memory/memory-store.js';
import { createLocalToolManager, getLocalToolAllowlist } from '../../src/tools/local-tool-manager.js';

const NOW = '2026-09-23T12:00:00.000Z';

function toolResponse(name: string, argumentsValue: object | undefined, id = 'query-1') {
  return {
    text: '', provider: 'mock', model: 'mock-model', finishReason: 'tool_calls' as const,
    toolCalls: [{ id, name, argumentsJson: JSON.stringify(argumentsValue ?? {}) }],
  };
}

async function withFixture(run: (fixture: {
  reminderStore: ReminderStore;
  noteStore: NoteStore;
  reminderPath: string;
  notePath: string;
}) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'waifu-natural-queries-'));
  const now = (): Date => new Date(NOW);
  let nextReminderId = 0;
  let nextNoteId = 0;
  const reminderPath = join(directory, 'reminders.json');
  const notePath = join(directory, 'notes.json');
  const reminderStore = new ReminderStore(reminderPath, {
    now,
    idFactory: () => `0000000${(++nextReminderId).toString(16)}`,
  });
  const noteStore = new NoteStore(notePath, {
    now,
    idFactory: () => `0000000${(++nextNoteId).toString(16)}`,
  });
  try {
    await reminderStore.load();
    await noteStore.load();
    await run({ reminderStore, noteStore, reminderPath, notePath });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function runQuery(
  reminderStore: ReminderStore,
  noteStore: NoteStore,
  input: string,
  name: string,
  argumentsValue: object = {},
  secondResponse = 'Consulta completada.',
): Promise<{ readonly response: string; readonly requests: readonly AIRequest[] }> {
  const requests: AIRequest[] = [];
  let calls = 0;
  const provider = new MockAIProvider({
    responder: (request) => {
      requests.push(request);
      calls += 1;
      return calls === 1
        ? toolResponse(name, argumentsValue)
        : { text: secondResponse, provider: 'mock', model: 'mock-model', finishReason: 'stop' as const };
    },
  });
  const options = { reminderStore, noteStore, now: () => new Date(NOW) };
  const core = new AssistantCore({
    provider,
    toolManager: createLocalToolManager(options),
    toolAllowlist: getLocalToolAllowlist(options),
  });
  const result = await core.respond(core.createSession(), input);
  return { response: result.text, requests };
}

test('contextual memory recall does not read or mutate notes and reminders', async () => {
  await withFixture(async ({ reminderStore, noteStore, reminderPath, notePath }) => {
    await reminderStore.add('Guardar turno de laboratorio', new Date('2026-09-24T09:00:00.000Z'));
    await noteStore.add('Nota privada de prueba');
    const reminderBefore = await readFile(reminderPath, 'utf8');
    const noteBefore = await readFile(notePath, 'utf8');
    const requests: AIRequest[] = [];
    const provider = new MockAIProvider({
      responder: (request) => {
        requests.push(request);
        return { text: 'Tu juego favorito guardado es Genshin Impact.', provider: 'mock', model: 'mock-model', finishReason: 'stop' };
      },
    });
    const options = { reminderStore, noteStore, now: () => new Date(NOW) };
    const core = new AssistantCore({ provider, toolManager: createLocalToolManager(options), toolAllowlist: getLocalToolAllowlist(options) });
    const memory: MemorySnapshot = Object.freeze({
      version: 1,
      entries: Object.freeze([
        { key: 'favorite_game', value: 'Genshin Impact' },
        { key: 'note', value: 'unrelated memory entry' },
      ]),
    });

    await core.respond(core.createSession(), '¿Cuál era el juego que me gustaba?', { memory });

    const recallBlock = requests[0]?.messages.find(({ content }) => content.includes('<relevant-explicit-memories>'))?.content ?? '';
    assert.match(recallBlock, /Genshin Impact/u);
    assert.doesNotMatch(recallBlock, /unrelated memory entry/u);
    assert.equal(await readFile(reminderPath, 'utf8'), reminderBefore);
    assert.equal(await readFile(notePath, 'utf8'), noteBefore);
  });
});

test('pending reminders, all reminders, next reminder, and empty reminders are read-only', async () => {
  await withFixture(async ({ reminderStore, noteStore, reminderPath }) => {
    const pending = await reminderStore.add('Revisar agenda', new Date('2026-09-24T09:00:00.000Z'));
    const completed = await reminderStore.add('Enviar informe', new Date('2026-09-25T09:00:00.000Z'));
    await reminderStore.complete(completed.id);
    const before = await readFile(reminderPath, 'utf8');

    const pendingQuery = await runQuery(reminderStore, noteStore, '¿Qué recordatorios tengo?', 'local_reminders_list');
    const pendingResult = JSON.parse(pendingQuery.requests[1]?.messages.at(-1)?.content ?? '{}') as { value?: { reminders?: unknown[] } };
    assert.equal(pendingResult.value?.reminders?.length, 1);
    assert.equal((pendingResult.value?.reminders?.[0] as { id: string }).id, pending.id);
    assert.equal((pendingResult.value?.reminders?.[0] as Record<string, unknown>).completedAt, undefined);

    const unauthorizedAllQuery = await runQuery(
      reminderStore,
      noteStore,
      '¿Qué recordatorios tengo?',
      'local_reminders_list',
      { includeCompleted: true },
      'Solo puedo incluir completados si lo pides explícitamente.',
    );
    const unauthorizedAllResult = JSON.parse(unauthorizedAllQuery.requests[1]?.messages.at(-1)?.content ?? '{}') as { status?: string; error?: { code?: string } };
    assert.equal(unauthorizedAllResult.status, 'failure');
    assert.equal(unauthorizedAllResult.error?.code, 'TOOL_PERMISSION_ERROR');

    const allQuery = await runQuery(
      reminderStore,
      noteStore,
      'Muéstrame todos mis recordatorios, incluso completados.',
      'local_reminders_list',
      { includeCompleted: true },
    );
    const allResult = JSON.parse(allQuery.requests[1]?.messages.at(-1)?.content ?? '{}') as { value?: { reminders?: unknown[] } };
    assert.equal(allResult.value?.reminders?.length, 2);

    const nextQuery = await runQuery(reminderStore, noteStore, '¿Cuál es mi próximo recordatorio?', 'local_reminder_next');
    const nextResult = JSON.parse(nextQuery.requests[1]?.messages.at(-1)?.content ?? '{}') as { value?: { reminder?: { id?: string } } };
    assert.equal(nextResult.value?.reminder?.id, pending.id);

    const emptyStore = new ReminderStore(join(reminderPath, '..', 'empty-reminders.json'), { now: () => new Date(NOW) });
    await emptyStore.load();
    const emptyQuery = await runQuery(emptyStore, noteStore, '¿Qué recordatorios tengo?', 'local_reminders_list');
    const emptyResult = JSON.parse(emptyQuery.requests[1]?.messages.at(-1)?.content ?? '{}') as { value?: { reminders?: unknown[] } };
    assert.deepEqual(emptyResult.value?.reminders, []);
    assert.equal(await readFile(reminderPath, 'utf8'), before);
  });
});

test('notes list returns bounded previews and note show returns only the requested note', async () => {
  await withFixture(async ({ reminderStore, noteStore, notePath }) => {
    const first = await noteStore.add(`Idea privada ${'detallada '.repeat(30)}🌸`);
    const second = await noteStore.add('Comprar adaptador HDMI');
    const before = await readFile(notePath, 'utf8');

    const listQuery = await runQuery(reminderStore, noteStore, '¿Qué notas tengo guardadas?', 'local_notes_list');
    const listResult = JSON.parse(listQuery.requests[1]?.messages.at(-1)?.content ?? '{}') as { value?: { notes?: Array<Record<string, unknown>> } };
    assert.equal(listResult.value?.notes?.length, 2);
    assert.equal(listResult.value?.notes?.every((note) => Object.keys(note).every((key) => ['id', 'preview', 'updatedAt'].includes(key))), true);
    assert.equal(String(listResult.value?.notes?.find((note) => note.id === first.id)?.preview).includes('detallada '.repeat(10)), false);

    const showQuery = await runQuery(reminderStore, noteStore, `Muéstrame la nota ${second.id}.`, 'local_note_show', { id: second.id });
    const showResult = JSON.parse(showQuery.requests[1]?.messages.at(-1)?.content ?? '{}') as { value?: Record<string, unknown> };
    assert.equal(showResult.value?.id, second.id);
    assert.equal(showResult.value?.text, second.text);
    assert.equal(JSON.stringify(showResult).includes(first.text), false);
    assert.equal(await readFile(notePath, 'utf8'), before);
  });
});

test('missing note is a controlled read-only failure', async () => {
  await withFixture(async ({ reminderStore, noteStore }) => {
    const query = await runQuery(reminderStore, noteStore, 'Muéstrame la nota n-ffffffff.', 'local_note_show', { id: 'n-ffffffff' }, 'No encontré esa nota.');
    const toolResult = JSON.parse(query.requests[1]?.messages.at(-1)?.content ?? '{}') as { status?: string; error?: { code?: string } };
    assert.equal(toolResult.status, 'failure');
    assert.equal(toolResult.error?.code, 'TOOL_ARGUMENTS_ERROR');
    assert.equal(query.response, 'No encontré esa nota.');
  });
});

test('destructive natural-language requests cannot execute a delete tool', async () => {
  await withFixture(async ({ reminderStore, noteStore, notePath }) => {
    const note = await noteStore.add('Conservar esta nota');
    const before = await readFile(notePath, 'utf8');
    const query = await runQuery(reminderStore, noteStore, `¿Puedes borrar mi nota ${note.id}?`, 'local_note_delete', {}, 'Los borrados requieren el comando explícito.');
    const toolResult = JSON.parse(query.requests[1]?.messages.at(-1)?.content ?? '{}') as { status?: string; error?: { code?: string } };
    assert.equal(toolResult.status, 'failure');
    assert.equal(toolResult.error?.code, 'TOOL_NOT_FOUND_ERROR');
    assert.equal(await readFile(notePath, 'utf8'), before);
    assert.equal((await noteStore.list()).length, 1);
  });
});

test('read-only query payloads stay out of Session and duplicate tool calls execute once', async () => {
  await withFixture(async ({ reminderStore, noteStore, reminderPath }) => {
    await reminderStore.add('Leer', new Date('2026-09-24T09:00:00.000Z'));
    const before = await readFile(reminderPath, 'utf8');
    const memoryStore = new PersistentMemoryStore(join(reminderPath, '..', 'memory.json'));
    await memoryStore.load();
    await memoryStore.set('test-key', 'test-value');
    const memoryBefore = await readFile(memoryStore.filePath, 'utf8');
    let calls = 0;
    const provider = new MockAIProvider({
      responder: () => {
        calls += 1;
        return calls === 1
          ? {
            ...toolResponse('local_reminders_list', {}),
            toolCalls: [
              { id: 'list-1', name: 'local_reminders_list', argumentsJson: '{}' },
              { id: 'list-2', name: 'local_reminders_list', argumentsJson: '{}' },
            ],
          }
          : { text: 'Hay un recordatorio pendiente.', provider: 'mock', model: 'mock-model', finishReason: 'stop' as const };
      },
    });
    const options = { reminderStore, noteStore, now: () => new Date(NOW) };
    const core = new AssistantCore({ provider, toolManager: createLocalToolManager(options), toolAllowlist: getLocalToolAllowlist(options) });
    const session = core.createSession();
    await core.respond(session, '¿Qué recordatorios tengo?', { memory: await memoryStore.snapshot() });
    await core.respond(session, 'Gracias.');

    assert.deepEqual(session.getMessages().map(({ role }) => role), ['user', 'assistant', 'user', 'assistant']);
    assert.equal((await reminderStore.list()).length, 1);
    assert.equal(await readFile(reminderPath, 'utf8'), before);
    assert.equal(await readFile(memoryStore.filePath, 'utf8'), memoryBefore);
  });
});
