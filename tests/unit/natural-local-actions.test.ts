import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AIRequest } from '../../src/ai/ai-types.js';
import { MockAIProvider } from '../../src/ai/mock-ai-provider.js';
import { AssistantCore } from '../../src/core/assistant-core.js';
import { NoteStore } from '../../src/notes/note-store.js';
import { ReminderStore } from '../../src/reminders/reminder-store.js';
import {
  createLocalToolManager,
  getLocalToolAllowlist,
} from '../../src/tools/local-tool-manager.js';
import { LOCAL_NOTE_CREATE_TOOL_ID } from '../../src/tools/local-note-create-tool.js';
import { LOCAL_REMINDER_CREATE_TOOL_ID } from '../../src/tools/local-reminder-create-tool.js';

const NOW = '2026-09-23T12:00:00.000Z';

function toolResponse(name: string, argumentsValue: object, id = 'call-1') {
  return {
    text: '',
    provider: 'mock',
    model: 'mock-model',
    finishReason: 'tool_calls' as const,
    toolCalls: [{ id, name, argumentsJson: JSON.stringify(argumentsValue) }],
  };
}

async function withStores(run: (stores: { reminderStore: ReminderStore; noteStore: NoteStore }) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'waifu-natural-actions-'));
  try {
    const now = (): Date => new Date(NOW);
    await run({
      reminderStore: new ReminderStore(join(directory, 'reminders.json'), { now }),
      noteStore: new NoteStore(join(directory, 'notes.json'), { now }),
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('local natural-action tools are registered through ToolManager and enforce strict reminder time input', async () => {
  await withStores(async ({ reminderStore, noteStore }) => {
    const manager = createLocalToolManager({ reminderStore, noteStore, now: () => new Date(NOW) });
    assert.ok(manager.getTool(LOCAL_REMINDER_CREATE_TOOL_ID));
    assert.ok(manager.getTool(LOCAL_NOTE_CREATE_TOOL_ID));

    const result = await manager.execute(LOCAL_REMINDER_CREATE_TOOL_ID, {
      text: 'Pagar la luz', dueAt: '2026-09-24T07:00:00-05:00',
    }, {
      metadata: { source: 'llm-tool-call', toolId: LOCAL_REMINDER_CREATE_TOOL_ID, userInput: 'Recuérdame pagar la luz mañana a las 7.' },
      authorization: { source: 'llm-tool-call' },
    });
    assert.equal(result.status, 'success');
    assert.equal((await reminderStore.list()).length, 1);

    const invalid = await manager.execute(LOCAL_REMINDER_CREATE_TOOL_ID, {
      text: 'Sin zona horaria', dueAt: '2026-09-24T07:00',
    }, {
      metadata: { source: 'llm-tool-call', toolId: LOCAL_REMINDER_CREATE_TOOL_ID, userInput: 'Recuérdame esto.' },
      authorization: { source: 'llm-tool-call' },
    });
    assert.equal(invalid.status, 'failure');
    const past = await manager.execute(LOCAL_REMINDER_CREATE_TOOL_ID, {
      text: 'Ya pasó', dueAt: '2026-09-22T07:00:00-05:00',
    }, {
      metadata: { source: 'llm-tool-call', toolId: LOCAL_REMINDER_CREATE_TOOL_ID, userInput: 'Recuérdame algo que ya pasó.' },
      authorization: { source: 'llm-tool-call' },
    });
    assert.equal(past.status, 'failure');
    assert.equal((await reminderStore.list()).length, 1);
  });
});

test('explicit natural reminder creates exactly one reminder and keeps tool payloads out of Session', async () => {
  await withStores(async ({ reminderStore, noteStore }) => {
    const requests: AIRequest[] = [];
    let calls = 0;
    const provider = new MockAIProvider({
      responder: (request) => {
        requests.push(request);
        calls += 1;
        return calls === 1
          ? toolResponse('local_reminder_create', { text: 'Pagar la luz', dueAt: '2026-09-24T07:00:00-05:00' })
          : calls === 2
            ? { text: 'Listo, te lo recordaré mañana a las 7.', provider: 'mock', model: 'mock-model', finishReason: 'stop' as const }
            : { text: 'Seguimos conversando.', provider: 'mock', model: 'mock-model', finishReason: 'stop' as const };
      },
    });
    const options = { reminderStore, noteStore, now: () => new Date(NOW) };
    const core = new AssistantCore({
      provider,
      toolManager: createLocalToolManager(options),
      toolAllowlist: getLocalToolAllowlist(options),
      localActionNow: options.now,
    });
    const session = core.createSession();

    await core.respond(session, 'Recuérdame mañana a las 7 pagar la luz.');
    await core.respond(session, '¿Qué sigue?');

    assert.equal((await reminderStore.list()).length, 1);
    assert.deepEqual(session.getMessages().map(({ role, content }) => ({ role, content })), [
      { role: 'user', content: 'Recuérdame mañana a las 7 pagar la luz.' },
      { role: 'assistant', content: 'Listo, te lo recordaré mañana a las 7.' },
      { role: 'user', content: '¿Qué sigue?' },
      { role: 'assistant', content: 'Seguimos conversando.' },
    ]);
    assert.deepEqual(requests[0]?.tools?.map(({ function: definition }) => definition.name), [
      'local_time', 'local_calculate', 'local_reminder_create', 'local_note_create',
    ]);
    assert.match(requests[0]?.messages.find(({ content }) => content.includes('Controlled host local time'))?.content ?? '', /2026-09-23T12:00:00.000Z/);
    assert.equal(requests[2]?.messages.some(({ role }) => role === 'tool'), false);
    assert.equal(requests[2]?.messages.some(({ content }) => content.includes('local_reminder_create')), false);
  });
});

test('explicit natural note creates through NoteStore and preserves the conversational flow', async () => {
  await withStores(async ({ reminderStore, noteStore }) => {
    let calls = 0;
    const provider = new MockAIProvider({
      responder: () => {
        calls += 1;
        return calls === 1
          ? toolResponse('local_note_create', { text: 'Comprar pan 🌸' })
          : { text: 'Nota guardada.', provider: 'mock', model: 'mock-model', finishReason: 'stop' as const };
      },
    });
    const options = { reminderStore, noteStore, now: () => new Date(NOW) };
    const core = new AssistantCore({ provider, toolManager: createLocalToolManager(options), toolAllowlist: getLocalToolAllowlist(options) });
    const session = core.createSession();
    const response = await core.respond(session, 'Guarda una nota: Comprar pan 🌸');

    assert.equal(response.text, 'Nota guardada.');
    assert.deepEqual((await noteStore.list()).map(({ text }) => text), ['Comprar pan 🌸']);
    assert.deepEqual(session.getMessages().map(({ role }) => role), ['user', 'assistant']);
  });
});

test('ambiguous, hypothetical, and question-shaped inputs cannot create local actions even when a provider requests one', async () => {
  await withStores(async ({ reminderStore, noteStore }) => {
    const cases = [
      { input: '¿Podrías recordarme mañana?', name: 'local_reminder_create', argumentsValue: { text: 'Pagar la luz', dueAt: '2026-09-24T07:00:00-05:00' } },
      { input: 'Si quisiera guardar una nota sobre comprar pan, ¿cómo sería?', name: 'local_note_create', argumentsValue: { text: 'Comprar pan' } },
      { input: '¿Qué recordatorio tengo?', name: 'local_reminder_create', argumentsValue: { text: 'Pagar la luz', dueAt: '2026-09-24T07:00:00-05:00' } },
    ];
    for (const entry of cases) {
      let calls = 0;
      const provider = new MockAIProvider({
        responder: () => {
          calls += 1;
          return calls === 1
            ? toolResponse(entry.name, entry.argumentsValue)
            : { text: 'Necesito una instrucción explícita y una fecha/hora concreta.', provider: 'mock', model: 'mock-model', finishReason: 'stop' as const };
        },
      });
      const options = { reminderStore, noteStore, now: () => new Date(NOW) };
      const core = new AssistantCore({ provider, toolManager: createLocalToolManager(options), toolAllowlist: getLocalToolAllowlist(options) });
      const response = await core.respond(core.createSession(), entry.input);
      assert.match(response.text, /instrucción explícita/u);
    }
    assert.equal((await reminderStore.list()).length, 0);
    assert.equal((await noteStore.list()).length, 0);
  });
});

test('a provider cannot duplicate a state-changing local action in one response', async () => {
  await withStores(async ({ reminderStore, noteStore }) => {
    let calls = 0;
    const provider = new MockAIProvider({
      responder: () => {
        calls += 1;
        return calls === 1
          ? {
            ...toolResponse('local_note_create', { text: 'Una sola vez' }),
            toolCalls: [
              { id: 'note-1', name: 'local_note_create', argumentsJson: JSON.stringify({ text: 'Una sola vez' }) },
              { id: 'note-2', name: 'local_note_create', argumentsJson: JSON.stringify({ text: 'Duplicado' }) },
            ],
          }
          : { text: 'He guardado una nota.', provider: 'mock', model: 'mock-model', finishReason: 'stop' as const };
      },
    });
    const options = { reminderStore, noteStore, now: () => new Date(NOW) };
    const core = new AssistantCore({ provider, toolManager: createLocalToolManager(options), toolAllowlist: getLocalToolAllowlist(options) });
    await core.respond(core.createSession(), 'Anota Una sola vez');
    assert.deepEqual((await noteStore.list()).map(({ text }) => text), ['Una sola vez']);
  });
});
