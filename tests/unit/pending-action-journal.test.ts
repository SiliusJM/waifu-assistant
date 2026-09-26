import assert from 'node:assert/strict';
import { mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { PendingActionJournal, PENDING_ACTION_MAX_ENTRIES, resolvePendingActionsPath, type PendingActionFileSystem } from '../../src/actions/pending-action-journal.js';
import { handlePendingActionCommand } from '../../src/actions/pending-action-cli.js';
import { AssistantCore } from '../../src/core/assistant-core.js';
import { ConversationRunner } from '../../src/core/conversation-runner.js';
import { Session } from '../../src/core/session.js';
import { MockAIProvider } from '../../src/ai/mock-ai-provider.js';
import { PersistentMemoryStore } from '../../src/memory/memory-store.js';

const DUE_AT = '2030-01-02T03:04:05.000Z';
const NOW = '2029-12-01T00:00:00.000Z';

function uuid(counter: number): string {
  return `00000000-0000-4000-8000-${counter.toString(16).padStart(12, '0')}`;
}

async function fixture(options: { readonly now?: () => Date; readonly fileSystem?: PendingActionFileSystem } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'wa-pending-actions-'));
  const filePath = join(directory, 'pending-actions.json');
  let id = 1;
  const journal = new PendingActionJournal(filePath, {
    now: options.now ?? (() => new Date(NOW)),
    idFactory: () => uuid(id++),
    ...(options.fileSystem ? { fileSystem: options.fileSystem } : {}),
  });
  return { directory, filePath, journal, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

async function createAction(journal: PendingActionJournal, text = 'Enviar informe mañana'): Promise<string> {
  return (await journal.create({ type: 'local.reminder.create', payload: { text, dueAt: DUE_AT } })).id;
}

async function inputs(values: readonly string[]): Promise<AsyncIterable<string>> {
  return { async *[Symbol.asyncIterator]() { yield* values; } };
}

test('missing journal loads as an empty ready journal without creating files', async () => {
  const f = await fixture();
  try {
    const loaded = await f.journal.load();
    assert.deepEqual(loaded, { status: 'ready', actions: [], recoveredExecutingCount: 0, recoveryPersisted: true });
    await assert.rejects(stat(f.filePath), { code: 'ENOENT' });
  } finally { await f.cleanup(); }
});

test('valid empty journal loads and persists the versioned schema on first action', async () => {
  const f = await fixture();
  try {
    await writeFile(f.filePath, JSON.stringify({ version: 1, actions: [] }), 'utf8');
    assert.equal((await f.journal.load()).status, 'ready');
    const id = await createAction(f.journal);
    const document = JSON.parse(await readFile(f.filePath, 'utf8')) as { version: number; actions: { id: string }[] };
    assert.equal(document.version, 1);
    assert.equal(document.actions[0]?.id, id);
  } finally { await f.cleanup(); }
});

test('prepared action persists with a unique operation ID and idempotency key', async () => {
  const f = await fixture();
  try {
    const id = await createAction(f.journal);
    const saved = (await f.journal.get(id))!;
    assert.match(saved.id, /^pa-/u);
    assert.equal(saved.state, 'prepared');
    assert.match(saved.idempotencyKey, /^[0-9a-f-]{36}$/iu);
    assert.equal((await new PendingActionJournal(f.filePath).load()).actions[0]?.id, id);
  } finally { await f.cleanup(); }
});

test('awaiting confirmation persists and stays unauthorized after restart', async () => {
  const f = await fixture();
  try {
    const id = await createAction(f.journal);
    await f.journal.transition(id, 'awaiting_confirmation');
    const restarted = new PendingActionJournal(f.filePath);
    const loaded = await restarted.load();
    assert.equal(loaded.status, 'ready');
    assert.equal((await restarted.get(id))?.state, 'awaiting_confirmation');
    await assert.rejects(restarted.beginExecution(id), /Invalid pending action transition/u);
  } finally { await f.cleanup(); }
});

test('confirmed state survives restart but is never executed automatically', async () => {
  const f = await fixture();
  try {
    const id = await createAction(f.journal);
    await f.journal.transition(id, 'awaiting_confirmation');
    await f.journal.confirm(id);
    const restarted = new PendingActionJournal(f.filePath);
    const result = await restarted.load();
    assert.equal(result.status, 'ready');
    assert.equal((await restarted.get(id))?.state, 'confirmed');
  } finally { await f.cleanup(); }
});

test('executing action becomes reconciliation_required on restart and is not retried', async () => {
  const f = await fixture();
  try {
    const id = await createAction(f.journal);
    await f.journal.transition(id, 'awaiting_confirmation');
    await f.journal.confirm(id);
    await f.journal.beginExecution(id);
    const restarted = new PendingActionJournal(f.filePath);
    const result = await restarted.load();
    assert.equal(result.status, 'ready');
    assert.equal(result.recoveredExecutingCount, 1);
    assert.equal((await restarted.get(id))?.state, 'reconciliation_required');
    assert.equal((await restarted.listRecoverable()).some((action) => action.id === id), true);
    await assert.rejects(restarted.beginExecution(id), /reconciliation outcome must be resolved explicitly/u);
    await assert.rejects(restarted.transition(id, 'failed'), /reconciliation outcome must be resolved explicitly/u);
    assert.equal((await JSON.parse(await readFile(f.filePath, 'utf8')) as { actions: { state: string }[] }).actions[0]?.state, 'reconciliation_required');
  } finally { await f.cleanup(); }
});

test('reconciliation can only close through the explicit resolution API', async () => {
  const f = await fixture();
  try {
    const id = await createAction(f.journal);
    await f.journal.transition(id, 'awaiting_confirmation');
    await f.journal.confirm(id);
    await f.journal.beginExecution(id);
    const restarted = new PendingActionJournal(f.filePath);
    await restarted.load();
    assert.equal((await restarted.resolveReconciliation(id, 'completed')).state, 'completed');
  } finally { await f.cleanup(); }
});

test('completed actions are retained for a bounded interval but not shown as pending', async () => {
  const f = await fixture();
  try {
    const id = await createAction(f.journal);
    await f.journal.transition(id, 'awaiting_confirmation');
    await f.journal.confirm(id);
    await f.journal.beginExecution(id);
    await f.journal.complete(id);
    assert.equal((await f.journal.get(id))?.state, 'completed');
    assert.deepEqual(await f.journal.listRecoverable(), []);
  } finally { await f.cleanup(); }
});

test('cancelled and discarded actions are not shown as pending', async () => {
  const f = await fixture();
  try {
    const cancelledId = await createAction(f.journal);
    await f.journal.cancel(cancelledId);
    const discardedId = await createAction(f.journal, 'Preparar documento');
    await f.journal.discard(discardedId);
    assert.deepEqual(await f.journal.listRecoverable(), []);
  } finally { await f.cleanup(); }
});

test('failed action is retained as terminal and excluded from recovery summary', async () => {
  const f = await fixture();
  try {
    const id = await createAction(f.journal);
    await f.journal.fail(id);
    assert.equal((await f.journal.get(id))?.state, 'failed');
    assert.deepEqual(await f.journal.listRecoverable(), []);
  } finally { await f.cleanup(); }
});

test('corrupt JSON is reported without crashing or overwriting the source', async () => {
  const f = await fixture();
  try {
    await writeFile(f.filePath, '{broken', 'utf8');
    const result = await f.journal.load();
    assert.equal(result.status, 'corrupt');
    assert.equal(await readFile(f.filePath, 'utf8'), '{broken');
  } finally { await f.cleanup(); }
});

test('empty journal file is treated as corrupt and preserved', async () => {
  const f = await fixture();
  try {
    await writeFile(f.filePath, '', 'utf8');
    assert.equal((await f.journal.load()).status, 'corrupt');
    assert.equal(await readFile(f.filePath, 'utf8'), '');
  } finally { await f.cleanup(); }
});

test('unknown journal version is reported without migration or overwrite', async () => {
  const f = await fixture();
  try {
    const source = JSON.stringify({ version: 99, actions: [] });
    await writeFile(f.filePath, source, 'utf8');
    assert.equal((await f.journal.load()).status, 'unsupported-version');
    assert.equal(await readFile(f.filePath, 'utf8'), source);
  } finally { await f.cleanup(); }
});

test('invalid state and unknown action type are rejected as corrupt data', async () => {
  const f = await fixture();
  try {
    const action = {
      id: `pa-${uuid(1)}`, type: 'local.reminder.create', state: 'launch-shell',
      createdAt: NOW, updatedAt: NOW, payload: { text: 'safe', dueAt: DUE_AT }, idempotencyKey: uuid(2),
    };
    await writeFile(f.filePath, JSON.stringify({ version: 1, actions: [action] }), 'utf8');
    assert.equal((await f.journal.load()).status, 'corrupt');
    const g = await fixture();
    try {
      await writeFile(g.filePath, JSON.stringify({ version: 1, actions: [{ ...action, state: 'prepared', type: 'shell.exec' }] }), 'utf8');
      assert.equal((await g.journal.load()).status, 'corrupt');
    } finally { await g.cleanup(); }
  } finally { await f.cleanup(); }
});

test('duplicate persisted action IDs invalidate the journal', async () => {
  const f = await fixture();
  try {
    const action = {
      id: `pa-${uuid(1)}`, type: 'local.reminder.create', state: 'prepared',
      createdAt: NOW, updatedAt: NOW, payload: { text: 'safe', dueAt: DUE_AT }, idempotencyKey: uuid(2),
    };
    await writeFile(f.filePath, JSON.stringify({ version: 1, actions: [action, action] }), 'utf8');
    assert.equal((await f.journal.load()).status, 'corrupt');
  } finally { await f.cleanup(); }
});

test('payload schema blocks extra fields, oversized content and obvious credential values', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.journal.create({ type: 'local.reminder.create', payload: { text: 'password: do-not-save', dueAt: DUE_AT } }), /invalid or may contain a secret/u);
    await assert.rejects(f.journal.create({ type: 'local.reminder.create', payload: { text: 'ok', dueAt: DUE_AT, apiKey: 'secret' } as never }), /invalid or may contain a secret/u);
    await assert.rejects(f.journal.create({ type: 'local.reminder.create', payload: { text: 'x'.repeat(5000), dueAt: DUE_AT } }), /invalid or may contain a secret|size limit/u);
    await assert.rejects(f.journal.create({ type: 'local.reminder.create', payload: { text: 'ok', dueAt: 'tomorrow' } }), /invalid or may contain a secret/u);
  } finally { await f.cleanup(); }
});

test('top-level action count is bounded and refuses overflow without losing entries', async () => {
  const f = await fixture();
  try {
    for (let index = 0; index < PENDING_ACTION_MAX_ENTRIES; index += 1) await createAction(f.journal, `Action ${index}`);
    await assert.rejects(createAction(f.journal, 'overflow'), /journal is full/u);
    assert.equal((await f.journal.list()).length, PENDING_ACTION_MAX_ENTRIES);
  } finally { await f.cleanup(); }
});

test('concurrent actions on one journal instance serialize without dropping writes', async () => {
  const f = await fixture();
  try {
    const ids = await Promise.all([createAction(f.journal, 'parallel A'), createAction(f.journal, 'parallel B')]);
    assert.notEqual(ids[0], ids[1]);
    assert.deepEqual(new Set((await f.journal.list()).map(({ id }) => id)), new Set(ids));
  } finally { await f.cleanup(); }
});

test('duplicate generated operation IDs are rejected without replacing existing action', async () => {
  const f = await fixture();
  try {
    const sequence = [uuid(80), uuid(81), uuid(80), uuid(82)];
    const journal = new PendingActionJournal(f.filePath, { idFactory: () => sequence.shift() ?? uuid(83), now: () => new Date(NOW) });
    const id = await createAction(journal);
    await assert.rejects(createAction(journal, 'duplicate'), /unique pending action ID/u);
    assert.deepEqual((await journal.list()).map(({ id: savedId }) => savedId), [id]);
  } finally { await f.cleanup(); }
});

test('terminal entries older than retention are cleaned while active entries remain', async () => {
  const f = await fixture();
  try {
    let clock = new Date(NOW);
    const journal = new PendingActionJournal(f.filePath, { now: () => new Date(clock), idFactory: (() => { let n = 20; return () => uuid(n++); })() });
    const terminalId = await createAction(journal);
    await journal.discard(terminalId);
    const activeId = await createAction(journal, 'still active');
    clock = new Date(new Date(NOW).getTime() + 31 * 24 * 60 * 60 * 1000);
    const restarted = new PendingActionJournal(f.filePath, { now: () => new Date(clock) });
    await restarted.load();
    assert.equal(await restarted.get(terminalId), undefined);
    assert.equal((await restarted.get(activeId))?.state, 'prepared');
  } finally { await f.cleanup(); }
});

test('atomic rename failure preserves the old valid journal and cleans temporary files', async () => {
  const f = await fixture();
  try {
    const id = await createAction(f.journal);
    const before = await readFile(f.filePath, 'utf8');
    const fs: PendingActionFileSystem = {
      mkdir: async (path, mode) => { await mkdir(path, { recursive: true, mode }); },
      stat: async (path) => stat(path),
      readFile: async (path) => readFile(path, 'utf8'),
      open: async (path, flags, mode) => open(path, flags, mode),
      rename: async () => { throw new Error('injected rename failure'); },
      rm: async (path) => { await rm(path, { force: true }); },
    };
    const failingJournal = new PendingActionJournal(f.filePath, { fileSystem: fs });
    assert.equal((await failingJournal.load()).status, 'ready');
    await assert.rejects(failingJournal.transition(id, 'awaiting_confirmation'), /saved atomically/u);
    assert.equal(await readFile(f.filePath, 'utf8'), before);
    assert.deepEqual(await readdir(dirname(f.filePath)), ['pending-actions.json']);
  } finally { await f.cleanup(); }
});

test('recovery summary identifies pending and reconciliation work without authorizing it', async () => {
  const f = await fixture();
  try {
    const id = await createAction(f.journal);
    await f.journal.transition(id, 'awaiting_confirmation');
    assert.match((await f.journal.load()).status, /ready/u);
    const message = (await import('../../src/actions/pending-action-journal.js')).formatPendingActionStartupNotice({
      status: 'ready', actions: await f.journal.list(), recoveredExecutingCount: 0, recoveryPersisted: true,
    });
    assert.match(message ?? '', /No se ejecutarán automáticamente/u);
    assert.equal((await f.journal.get(id))?.state, 'awaiting_confirmation');
  } finally { await f.cleanup(); }
});

test('pending commands are local, inspectable, and confirm without executing', async () => {
  const f = await fixture();
  try {
    const id = await createAction(f.journal);
    await f.journal.transition(id, 'awaiting_confirmation');
    assert.match((await handlePendingActionCommand(f.journal, `/pending ${id}`)) ?? '', new RegExp(id));
    assert.match((await handlePendingActionCommand(f.journal, `/confirm-action ${id}`)) ?? '', /No se ejecutó/u);
    assert.equal((await f.journal.get(id))?.state, 'confirmed');
    assert.equal(await handlePendingActionCommand(f.journal, '/confirm-action'), 'Uso: /confirm-action <id>');
  } finally { await f.cleanup(); }
});

test('pending commands do not call the provider or add command text to Session', async () => {
  const f = await fixture();
  try {
    const confirmId = await createAction(f.journal, 'confirm path');
    await f.journal.transition(confirmId, 'awaiting_confirmation');
    const deferId = await createAction(f.journal, 'defer path');
    await f.journal.transition(deferId, 'awaiting_confirmation');
    const discardId = await createAction(f.journal, 'discard path');
    const provider = new MockAIProvider({ responseText: 'unexpected' });
    const core = new AssistantCore({ provider });
    const runner = new ConversationRunner(core);
    const commandResults: string[] = [];
    const result = await runner.run(await inputs([
      '/pending', `/confirm-action ${confirmId}`, `/defer-action ${deferId}`,
      `/discard-action ${discardId}`, '/exit',
    ]), {
      onCommand: async (command) => {
        const output = await handlePendingActionCommand(f.journal, command);
        if (output) commandResults.push(output);
      },
    });
    assert.equal(result.responses.length, 0);
    assert.deepEqual(result.session.getMessages(), []);
    assert.equal(commandResults.length, 4);
    assert.equal((await f.journal.get(confirmId))?.state, 'confirmed');
    assert.equal((await f.journal.get(deferId))?.state, 'prepared');
    assert.equal((await f.journal.get(discardId))?.state, 'discarded');
  } finally { await f.cleanup(); }
});

test('journal is isolated from Session clear and Persistent Memory forget', async () => {
  const f = await fixture();
  const memoryPath = join(f.directory, 'memory.json');
  try {
    const id = await createAction(f.journal);
    const session = new Session('session-test');
    session.addMessage('user', 'temporary conversation');
    const memory = new PersistentMemoryStore(memoryPath);
    await memory.load();
    await memory.set('temporary', 'value');
    await session.clear();
    await memory.delete('temporary');
    const reloaded = new PendingActionJournal(f.filePath);
    assert.equal((await reloaded.load()).actions[0]?.id, id);
    assert.deepEqual(session.getMessages(), []);
    assert.equal(await memory.count(), 0);
  } finally { await f.cleanup(); }
});

test('path override is absolute, external to repository, and defaults alongside local app data', () => {
  assert.throws(() => resolvePendingActionsPath({ YUKI_PENDING_ACTIONS_PATH: 'relative.json' }), /absolute/u);
  assert.throws(() => resolvePendingActionsPath({ YUKI_PENDING_ACTIONS_PATH: join(process.cwd(), 'pending-actions.json') }), /outside the repository/u);
  assert.equal(resolvePendingActionsPath({ YUKI_PENDING_ACTIONS_PATH: join(tmpdir(), 'pending-actions-test.json') }), resolve(tmpdir(), 'pending-actions-test.json'));
  assert.match(resolvePendingActionsPath({}), /\.waifu-assistant[\\/]pending-actions\.json$/u);
});

test('defer returns an awaiting action to prepared; invalid state jumps remain rejected', async () => {
  const f = await fixture();
  try {
    const id = await createAction(f.journal);
    await f.journal.transition(id, 'awaiting_confirmation');
    assert.equal((await f.journal.defer(id)).state, 'prepared');
    await assert.rejects(f.journal.transition(id, 'completed'), /Invalid pending action transition/u);
  } finally { await f.cleanup(); }
});

test('remote identifiers are optional validated opaque metadata, never execution instructions', async () => {
  const f = await fixture();
  try {
    const id = await createAction(f.journal);
    const saved = await readFile(f.filePath, 'utf8');
    assert.doesNotMatch(saved, /child_process|shell|commandLine|authorization|apiKey/iu);
    assert.equal((await f.journal.get(id))?.remoteId, undefined);
  } finally { await f.cleanup(); }
});
