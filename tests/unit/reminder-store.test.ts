import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { AssistantError } from '../../src/shared/errors.js';
import {
  formatDueReminderNotice,
  parseReminderCommand,
  parseReminderDueAt,
  REMINDER_MAX_ENTRIES,
  ReminderStore,
  resolveReminderPath,
  type ReminderFileSystem,
} from '../../src/reminders/reminder-store.js';

const NOW = new Date(2026, 8, 23, 12, 0, 0);

let nextId = 0;
function newId(): string {
  nextId += 1;
  return `0000000${nextId.toString(16).padStart(1, '0')}`;
}

async function withStore(run: (store: ReminderStore, filePath: string, directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'waifu-reminders-test-'));
  const filePath = join(directory, 'nested', 'reminders.json');
  nextId = 0;
  try {
    const store = new ReminderStore(filePath, { now: () => new Date(NOW), idFactory: newId });
    await store.load();
    await run(store, filePath, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function assertReminderError(operation: () => unknown, code: AssistantError['code']): void {
  assert.throws(operation, (error: unknown) => error instanceof AssistantError && error.code === code);
}

function assertAsyncReminderError(operation: Promise<unknown>, code: AssistantError['code']): Promise<void> {
  return assert.rejects(operation, (error: unknown) => error instanceof AssistantError && error.code === code);
}

test('explicit date/time parser accepts valid local input and rejects invalid, past and empty input', () => {
  const parsed = parseReminderCommand('/remind 2026-09-24 20:00 Jugar fútbol', NOW);
  assert.equal(parsed.text, 'Jugar fútbol');
  assert.equal(parsed.dueAt.getFullYear(), 2026);
  assert.equal(parsed.dueAt.getMonth(), 8);
  assert.equal(parsed.dueAt.getDate(), 24);
  assert.equal(parsed.dueAt.getHours(), 20);
  assert.equal(parsed.dueAt.getMinutes(), 0);

  assertReminderError(() => parseReminderDueAt({ date: '2026-02-30', time: '20:00' }, NOW), 'REMINDER_CONFIGURATION_ERROR');
  assertReminderError(() => parseReminderDueAt({ date: '2026-09-24', time: '25:00' }, NOW), 'REMINDER_CONFIGURATION_ERROR');
  assertReminderError(() => parseReminderDueAt({ date: '2026-09-23', time: '11:59' }, NOW), 'REMINDER_CONFIGURATION_ERROR');
  assertReminderError(() => parseReminderCommand('/remind 2026-09-24 20:00   ', NOW), 'REMINDER_CONFIGURATION_ERROR');
});

test('time-only reminder selects the next future local occurrence', () => {
  const laterToday = parseReminderDueAt({ time: '20:00' }, NOW);
  assert.equal(laterToday.getDate(), NOW.getDate());
  assert.equal(laterToday.getHours(), 20);

  const tomorrow = parseReminderDueAt({ time: '11:00' }, NOW);
  assert.equal(tomorrow.getDate(), NOW.getDate() + 1);
  assert.equal(tomorrow.getHours(), 11);
});

test('reminders persist, sort by due time, preserve Unicode, and delete only by ID', async () => {
  await withStore(async (store, filePath) => {
    const later = await store.add('Revisar el proyecto 🌸', new Date(2026, 8, 25, 10, 0));
    const sooner = await store.add('Llamar a mamá', new Date(2026, 8, 24, 9, 0));
    assert.match(later.id, /^r-[a-f0-9]{8}$/u);
    assert.deepEqual((await store.list()).map(({ id }) => id), [sooner.id, later.id]);

    const reloaded = new ReminderStore(filePath, { now: () => new Date(NOW), idFactory: newId });
    await reloaded.load();
    assert.deepEqual((await reloaded.list()).map(({ text }) => text), ['Llamar a mamá', 'Revisar el proyecto 🌸']);
    assert.equal(await reloaded.delete(sooner.id), true);
    assert.equal(await reloaded.delete(sooner.id), false);
    assert.deepEqual((await reloaded.list()).map(({ id }) => id), [later.id]);
  });
});

test('reminder text is bounded and past reminders are rejected', async () => {
  await withStore(async (store) => {
    await assertAsyncReminderError(store.add('   ', new Date(2026, 8, 24, 9, 0)), 'REMINDER_CONFIGURATION_ERROR');
    await assertAsyncReminderError(store.add('x'.repeat(501), new Date(2026, 8, 24, 9, 0)), 'REMINDER_CONFIGURATION_ERROR');
    await assertAsyncReminderError(store.add('Ya pasó', new Date(NOW.getTime() - 1)), 'REMINDER_CONFIGURATION_ERROR');
  });
});

test('due reminders are shown locally and remain pending in storage', async () => {
  await withStore(async (store) => {
    const dueAt = new Date(NOW.getTime() - 60_000);
    const reminder = await store.add('Entrega pendiente', new Date(NOW.getTime() + 60_000));
    // Simulate an item that became overdue after it was created.
    const document = JSON.parse(await readFile(store.filePath, 'utf8')) as { reminders: { id: string; dueAt: string }[] };
    const saved = document.reminders.find(({ id }) => id === reminder.id);
    assert.ok(saved);
    saved.dueAt = dueAt.toISOString();
    await writeFile(store.filePath, JSON.stringify({ version: 1, reminders: document.reminders }, null, 2) + '\n');

    const reloaded = new ReminderStore(store.filePath, { now: () => new Date(NOW), idFactory: newId });
    await reloaded.load();
    const due = await reloaded.listDue(NOW);
    const notice = formatDueReminderNotice(due);
    assert.match(notice, /Recordatorios pendientes:/u);
    assert.match(notice, new RegExp(reminder.id, 'u'));
    assert.match(notice, /Entrega pendiente/u);
    assert.equal((await reloaded.list())[0]?.status, 'pending');
    assert.equal((await reloaded.list()).length, 1);
  });
});

test('corrupt reminder storage is reported and not silently overwritten', async () => {
  await withStore(async (_store, filePath) => {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, '{broken', 'utf8');
    const before = await readFile(filePath, 'utf8');
    const corrupt = new ReminderStore(filePath);
    await assertAsyncReminderError(corrupt.load(), 'REMINDER_CORRUPT_ERROR');
    assert.equal(await readFile(filePath, 'utf8'), before);
  });
});

test('storage enforces the maximum and cleans atomic temporary files', async () => {
  await withStore(async (store, filePath, directory) => {
    await store.add('Una tarea', new Date(2026, 8, 24, 9, 0));
    const files = await readdir(join(directory, 'nested'));
    assert.deepEqual(files, ['reminders.json']);
    assert.equal((JSON.parse(await readFile(filePath, 'utf8')) as { reminders: unknown[] }).reminders.length, 1);

    const atLimit = Array.from({ length: REMINDER_MAX_ENTRIES }, (_, index) => ({
      id: `r-${index.toString(16).padStart(8, '0')}`,
      text: `Reminder ${index}`,
      dueAt: '2026-09-24T10:00:00.000Z',
      createdAt: '2026-09-23T12:00:00.000Z',
      status: 'pending',
    }));
    await writeFile(filePath, JSON.stringify({ version: 1, reminders: atLimit }), 'utf8');
    const bounded = new ReminderStore(filePath);
    await bounded.load();
    await assertAsyncReminderError(bounded.add('One too many', new Date(2026, 8, 26, 9, 0)), 'REMINDER_LIMIT_ERROR');
  });
});

test('failed atomic replacement restores the previous valid file and in-memory state', async () => {
  await withStore(async (store, filePath) => {
    const original = await store.add('Conservar', new Date(2026, 8, 24, 9, 0));
    const originalFile = await readFile(filePath, 'utf8');
    const fileSystem: ReminderFileSystem = {
      mkdir: async (path) => { await mkdir(path, { recursive: true }); },
      readFile: async (path) => readFile(path, 'utf8'),
      writeFile: async (path, data) => { await writeFile(path, data, 'utf8'); },
      rename: async (from, to) => {
        if (from.endsWith('.tmp')) throw new Error('injected atomic replacement failure');
        await rename(from, to);
      },
      rm: async (path) => { await rm(path, { force: true }); },
    };
    const failing = new ReminderStore(filePath, { fileSystem, now: () => new Date(NOW), idFactory: newId });
    await failing.load();
    await assertAsyncReminderError(failing.add('No debe persistirse', new Date(2026, 8, 25, 9, 0)), 'REMINDER_IO_ERROR');
    assert.equal(await readFile(filePath, 'utf8'), originalFile);
    assert.deepEqual((await failing.list()).map(({ id }) => id), [original.id]);
  });
});

test('default reminder storage is under the user data directory and supports an explicit path', () => {
  assert.equal(resolveReminderPath({}), resolve(homedir(), '.waifu-assistant', 'reminders.json'));
  assert.equal(resolveReminderPath({ YUKI_REMINDERS_PATH: 'C:/temp/yuki-reminders.json' }), resolve('C:/temp/yuki-reminders.json'));
});
