import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MockAIProvider } from '../../src/ai/mock-ai-provider.js';
import type { AIRequest } from '../../src/ai/ai-types.js';
import { AssistantCore } from '../../src/core/assistant-core.js';
import { Session } from '../../src/core/session.js';
import { resolveProviderConfig, toSafeProviderConfig } from '../../src/config/provider-config.js';
import { NoteStore } from '../../src/notes/note-store.js';
import { PersistentMemoryStore } from '../../src/memory/memory-store.js';
import { ReminderStore } from '../../src/reminders/reminder-store.js';
import { createLocalToolManager, getLocalToolAllowlist } from '../../src/tools/local-tool-manager.js';
import type { LocalStatusProviderSummary } from '../../src/tools/local-status-summary-tool.js';

const NOW = '2026-09-24T12:00:00.000Z';
const TOOL_NAME = 'local_status_summary';

function safeProvider(config: ReturnType<typeof resolveProviderConfig>): LocalStatusProviderSummary {
  const safe = toSafeProviderConfig(config);
  return {
    profileId: safe.profileId,
    provider: safe.provider,
    model: safe.model,
    baseHost: safe.baseHost,
    credentialConfigured: safe.credentialConfigured,
  };
}

function statusToolCall(id = 'status-1') {
  return {
    text: '', provider: 'mock', model: 'scripted', finishReason: 'tool_calls' as const,
    toolCalls: [{ id, name: TOOL_NAME, argumentsJson: '{}' }],
  };
}

async function withStores(run: (stores: {
  readonly directory: string;
  readonly notes: NoteStore;
  readonly reminders: ReminderStore;
  readonly notePath: string;
  readonly reminderPath: string;
}) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'waifu-status-summary-'));
  const notePath = join(directory, 'notes.json');
  const reminderPath = join(directory, 'reminders.json');
  let nextReminderId = 0;
  const notes = new NoteStore(notePath, { now: () => new Date(NOW), idFactory: () => 'a1b2c3d4' });
  const reminders = new ReminderStore(reminderPath, {
    now: () => new Date(NOW), idFactory: () => `0102030${(++nextReminderId).toString(16)}`,
  });
  try {
    await notes.load();
    await reminders.load();
    await run({ directory, notes, reminders, notePath, reminderPath });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function queryStatus(options: {
  readonly provider?: LocalStatusProviderSummary;
  readonly notes: NoteStore;
  readonly reminders: ReminderStore;
  readonly input: string;
  readonly session?: Session;
  readonly memory?: Awaited<ReturnType<PersistentMemoryStore['snapshot']>>;
  readonly onRequest?: (request: AIRequest) => void;
  readonly finalText?: string;
}): Promise<{ readonly session: Session; readonly requests: readonly AIRequest[]; readonly answer: string }> {
  const requests: AIRequest[] = [];
  let call = 0;
  const provider = new MockAIProvider({
    responder: (request) => {
      requests.push(request);
      options.onRequest?.(request);
      call += 1;
      return call === 1
        ? statusToolCall()
        : { text: options.finalText ?? 'Aquí está el estado local.', provider: 'mock', model: 'scripted', finishReason: 'stop' as const };
    },
  });
  const status = {
    provider: options.provider ?? {
      profileId: 'mock', provider: 'mock', model: 'mock-model', baseHost: '', credentialConfigured: false,
    },
    noteStore: options.notes,
    reminderStore: options.reminders,
  };
  const toolOptions = { now: () => new Date(NOW), noteStore: options.notes, reminderStore: options.reminders, statusSummary: status };
  const core = new AssistantCore({
    provider,
    toolManager: createLocalToolManager(toolOptions),
    toolAllowlist: getLocalToolAllowlist(toolOptions),
  });
  const session = options.session ?? core.createSession();
  const response = await core.respond(session, options.input, { memory: options.memory });
  return { session, requests, answer: response.text };
}

function toolResult(request: AIRequest): Record<string, unknown> {
  const message = request.messages.at(-1);
  assert.equal(message?.role, 'tool');
  return JSON.parse(message?.content ?? '{}') as Record<string, unknown>;
}

test('combined status returns safe aggregates and current-session metadata without store or memory writes', async () => {
  await withStores(async ({ directory, notes, reminders, notePath, reminderPath }) => {
    await notes.add('Nota privada: contenido que no debe salir en el resumen');
    const next = await reminders.add('Texto privado pendiente', new Date('2026-09-25T09:00:00.000Z'));
    const completed = await reminders.add('Texto privado completado', new Date('2026-09-26T09:00:00.000Z'));
    await reminders.complete(completed.id);
    const noteBefore = await readFile(notePath, 'utf8');
    const reminderBefore = await readFile(reminderPath, 'utf8');

    const memory = new PersistentMemoryStore(join(directory, 'memory.json'));
    await memory.load();
    await memory.set('private-key', 'private-memory-value');
    const memoryBefore = await readFile(memory.filePath, 'utf8');
    const config = resolveProviderConfig({
      AI_PROVIDER: 'direct', AI_BASE_URL: 'https://router.example.test/v1', AI_MODEL: 'public-model',
    }, { resolve: () => 'test-credential-never-report' });
    const configBefore = JSON.stringify(toSafeProviderConfig(config));
    const session = new Session('session-safe-id');
    session.setTitle('Conversación café 東京 sk-or-v1-privatefixture123456');
    session.markSaved('daily-session');
    session.addMessage('user', 'Mensaje previo');
    session.addMessage('assistant', 'Respuesta previa');

    const result = await queryStatus({
      provider: safeProvider(config), notes, reminders, session,
      input: 'Dame un resumen de tu estado local.', memory: await memory.snapshot(),
    });
    const payload = toolResult(result.requests[1] as AIRequest);
    const value = payload.value as Record<string, unknown>;
    const provider = value.provider as Record<string, unknown>;
    const sessionValue = value.session as Record<string, unknown>;
    const noteValue = value.notes as Record<string, unknown>;
    const reminderValue = value.reminders as Record<string, unknown>;

    assert.deepEqual(Object.keys(value).sort(), ['notes', 'provider', 'reminders', 'session']);
    assert.deepEqual(Object.keys(provider).sort(), ['baseHost', 'credentialConfigured', 'model', 'profileId', 'provider']);
    assert.deepEqual(provider, {
      profileId: 'legacy', provider: 'direct', model: 'public-model', baseHost: 'router.example.test', credentialConfigured: true,
    });
    assert.deepEqual(sessionValue, {
      id: 'session-safe-id', title: 'Conversación café 東京 [REDACTED]', messageCount: 3, saved: true,
    });
    assert.deepEqual(noteValue, { count: 1 });
    assert.deepEqual(reminderValue, { pendingCount: 1, completedCount: 1, nextDueAt: next.dueAt });
    assert.equal(JSON.stringify(payload).includes('test-credential-never-report'), false);
    assert.equal(JSON.stringify(payload).includes('privatefixture123456'), false);
    assert.equal(JSON.stringify(payload).includes('private-memory-value'), false);
    assert.equal(JSON.stringify(payload).includes('Texto privado'), false);
    assert.equal(JSON.stringify(payload).includes('private-key'), false);
    assert.equal(result.requests.some((request) => request.messages.some(({ content }) => content.includes('<memory-data>'))), false);
    assert.equal(result.session.getMessages().some(({ content }) => content.includes('private-memory-value')), false);
    assert.deepEqual(result.session.getMessages().map(({ role }) => role), ['user', 'assistant', 'user', 'assistant']);
    assert.equal(result.session.getMessages().some(({ content }) => content.includes('local_status_summary')), false);
    assert.equal(result.session.getMessages().some(({ content }) => content.includes('Texto privado')), false);
    assert.equal(await readFile(notePath, 'utf8'), noteBefore);
    assert.equal(await readFile(reminderPath, 'utf8'), reminderBefore);
    assert.equal(await readFile(memory.filePath, 'utf8'), memoryBefore);
    assert.equal(JSON.stringify(toSafeProviderConfig(config)), configBefore);
  });
});

test('credential status question is read-only and reports only whether a credential is configured', async () => {
  await withStores(async ({ notes, reminders }) => {
    const config = resolveProviderConfig({
      AI_PROVIDER: 'direct', AI_BASE_URL: 'https://router.example.test/v1', AI_MODEL: 'safe-model',
    }, { resolve: () => 'credential-must-not-escape' });
    const result = await queryStatus({
      provider: safeProvider(config), notes, reminders,
      input: '¿Tienes configurada la credencial?',
    });
    const payload = toolResult(result.requests[1] as AIRequest).value as Record<string, unknown>;
    assert.deepEqual(payload.provider, {
      profileId: 'legacy', provider: 'direct', model: 'safe-model',
      baseHost: 'router.example.test', credentialConfigured: true,
    });
    assert.equal(JSON.stringify(payload).includes('credential-must-not-escape'), false);
    assert.deepEqual(result.session.getMessages().map(({ role }) => role), ['user', 'assistant']);
  });
});

test('provider, legacy, profile and mock status modes expose only safe public metadata', async () => {
  await withStores(async ({ notes, reminders }) => {
    const mockConfig = resolveProviderConfig({});
    const directConfig = resolveProviderConfig({
      AI_PROVIDER: 'direct', AI_BASE_URL: 'https://direct.example.test/v1', AI_MODEL: 'direct-model',
    }, { resolve: () => 'direct-secret-fixture' });
    const profileConfig = resolveProviderConfig({
      AI_PROVIDER_PROFILE: 'groq', GROQ_MODEL: 'profile-model', GROQ_API_KEY: 'profile-secret-fixture',
    });
    for (const [config, expected] of [
      [mockConfig, { provider: 'mock', profileId: 'legacy', model: 'mock-model', baseHost: '', credentialConfigured: false }],
      [directConfig, { provider: 'direct', profileId: 'legacy', model: 'direct-model', baseHost: 'direct.example.test', credentialConfigured: true }],
      [profileConfig, { provider: 'direct', profileId: 'groq', model: 'profile-model', baseHost: 'api.groq.com', credentialConfigured: true }],
    ] as const) {
      const result = await queryStatus({ provider: safeProvider(config), notes, reminders, input: '¿Qué proveedor y modelo estás usando?' });
      const provider = (toolResult(result.requests[1] as AIRequest).value as { provider: Record<string, unknown> }).provider;
      assert.deepEqual(provider, expected);
      assert.equal(JSON.stringify(provider).includes('secret-fixture'), false);
      assert.equal(JSON.stringify(provider).includes('apiKey'), false);
      assert.equal(JSON.stringify(provider).includes('baseURL'), false);
    }
  });
});

test('status queries expose empty counts and an unsaved Unicode-titled session', async () => {
  await withStores(async ({ notes, reminders }) => {
    const session = new Session('unsaved-session-id');
    session.setTitle('Yuki en español 🌙');
    const result = await queryStatus({
      notes, reminders, session, input: '¿Qué sesión tengo abierta?',
    });
    const payload = toolResult(result.requests[1] as AIRequest).value as Record<string, unknown>;
    assert.deepEqual(payload.session, {
      id: 'unsaved-session-id', title: 'Yuki en español 🌙', messageCount: 1, saved: false,
    });
    assert.deepEqual(payload.notes, { count: 0 });
    assert.deepEqual(payload.reminders, { pendingCount: 0, completedCount: 0, nextDueAt: null });
  });
});

test('provider-change requests cannot invoke the status tool or alter configuration', async () => {
  await withStores(async ({ notes, reminders }) => {
    const config = resolveProviderConfig({
      AI_PROVIDER: 'direct', AI_BASE_URL: 'https://current.example.test/v1', AI_MODEL: 'current-model',
    }, { resolve: () => 'credential-fixture' });
    const before = JSON.stringify(toSafeProviderConfig(config));
    const result = await queryStatus({
      provider: safeProvider(config), notes, reminders,
      input: 'Cámbiate a Groq y usa otro modelo.',
      finalText: 'No cambié nada: esta consulta solo informa el estado local.',
    });
    const denied = toolResult(result.requests[1] as AIRequest);
    assert.equal(denied.status, 'failure');
    assert.deepEqual(denied.error, {
      code: 'TOOL_PERMISSION_ERROR',
      message: 'This read-only status tool cannot change provider settings and is available only for status questions.',
      retryable: false,
    });
    assert.match(result.answer, /No cambié nada/u);
    assert.equal(JSON.stringify(toSafeProviderConfig(config)), before);
    assert.equal(JSON.stringify(denied).includes('credential-fixture'), false);
    assert.deepEqual(result.session.getMessages().map(({ role }) => role), ['user', 'assistant']);
  });
});
