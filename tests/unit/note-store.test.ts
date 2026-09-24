import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { AssistantError } from '../../src/shared/errors.js';
import {
  formatNoteList,
  formatNotePreview,
  NOTE_MAX_ENTRIES,
  NOTE_MAX_TEXT_LENGTH,
  NoteStore,
  resolveNotesPath,
  type NoteFileSystem,
} from '../../src/notes/note-store.js';

const NOW = new Date('2026-09-23T17:00:00.000Z');

async function withStore(run: (store: NoteStore, path: string, directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'waifu-notes-test-'));
  const path = join(directory, 'nested', 'notes.json');
  let nextId = 0;
  try {
    const store = new NoteStore(path, {
      now: () => new Date(NOW),
      idFactory: () => `0000000${(++nextId).toString(16)}`,
    });
    await store.load();
    await run(store, path, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function assertNoteError(operation: Promise<unknown>, code: AssistantError['code']): Promise<void> {
  return assert.rejects(operation, (error: unknown) => error instanceof AssistantError && error.code === code);
}

test('creates notes with unique short IDs, trims only outer whitespace, and persists Unicode', async () => {
  await withStore(async (store, path) => {
    const first = await store.add('  Comprar adaptador HDMI  ');
    const second = await store.add('Comprar adaptador HDMI');
    const unicode = await store.add('  Mamá: 你好 🌸 e\u0301  ');

    assert.equal(first.id, 'n-00000001');
    assert.equal(second.id, 'n-00000002');
    assert.notEqual(first.id, second.id);
    assert.equal(first.text, 'Comprar adaptador HDMI');
    assert.equal(unicode.text, 'Mamá: 你好 🌸 e\u0301');
    assert.equal(first.createdAt, NOW.toISOString());
    assert.equal(first.updatedAt, first.createdAt);

    const reloaded = new NoteStore(path);
    await reloaded.load();
    assert.equal((await reloaded.show(unicode.id)).text, unicode.text);
  });
});

test('rejects empty, whitespace-only, and over-limit note text without truncating', async () => {
  await withStore(async (store) => {
    await assertNoteError(store.add(''), 'NOTE_CONFIGURATION_ERROR');
    await assertNoteError(store.add(' \n\t '), 'NOTE_CONFIGURATION_ERROR');
    const atLimit = await store.add('🌸'.repeat(NOTE_MAX_TEXT_LENGTH));
    assert.equal([...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(atLimit.text)].length, NOTE_MAX_TEXT_LENGTH);
    await assertNoteError(store.add('🌸'.repeat(NOTE_MAX_TEXT_LENGTH + 1)), 'NOTE_CONFIGURATION_ERROR');
    assert.equal((await store.list()).length, 1);
  });
});

test('lists newest notes first with stable tie ordering and bounded grapheme-safe previews', async () => {
  await withStore(async (store, path) => {
    let clock = new Date(NOW);
    const ordered = new NoteStore(path, {
      now: () => new Date(clock),
      idFactory: (() => { let id = 10; return () => `${(++id).toString(16).padStart(8, '0')}`; })(),
    });
    await ordered.load();
    const older = await ordered.add('Older note');
    clock = new Date(clock.getTime() + 1000);
    const newer = await ordered.add(`👩‍👩‍👧‍👦${' project'.repeat(20)}`);
    const tied = await ordered.add('Same timestamp, next ID');
    assert.deepEqual((await ordered.list()).map(({ id }) => id), [newer.id, tied.id, older.id]);
    const output = formatNoteList(await ordered.list());
    assert.match(output, new RegExp(`\\[${newer.id}\\]`));
    assert.ok(output.includes('…'));
    assert.ok(!output.includes(' project'.repeat(10)));
    assert.equal(formatNotePreview('👩‍👩‍👧‍👦x', 1), '👩‍👩‍👧‍👦…');
    assert.equal(formatNotePreview(`e\u0301x`, 1), 'e\u0301…');
    assert.equal(formatNoteList([]), 'No hay notas guardadas.');
  });
});

test('show and delete operate by ID and report missing notes safely', async () => {
  await withStore(async (store) => {
    const note = await store.add('Solo una nota');
    assert.equal((await store.show(note.id)).text, 'Solo una nota');
    await assertNoteError(store.show('n-ffffffff'), 'NOTE_NOT_FOUND_ERROR');
    await assertNoteError(store.show('not-an-id'), 'NOTE_CONFIGURATION_ERROR');
    assert.equal(await store.delete(note.id), true);
    assert.equal(await store.delete(note.id), false);
    await assertNoteError(store.delete('../notes.json'), 'NOTE_CONFIGURATION_ERROR');
  });
});

test('corrupt JSON is a controlled error and is not replaced', async () => {
  await withStore(async (_store, path) => {
    await mkdir(dirname(path), { recursive: true });
    const corrupt = '{not-json';
    await writeFile(path, corrupt, 'utf8');
    const store = new NoteStore(path);
    await assertNoteError(store.load(), 'NOTE_CORRUPT_ERROR');
    assert.equal(await readFile(path, 'utf8'), corrupt);
  });
});

test('maximum note count is enforced and completed inventory remains bounded', async () => {
  await withStore(async (_store, path) => {
    await mkdir(dirname(path), { recursive: true });
    const notes = Array.from({ length: NOTE_MAX_ENTRIES }, (_, index) => {
      const timestamp = new Date(NOW.getTime() + index).toISOString();
      return { id: `n-${index.toString(16).padStart(8, '0')}`, text: `Note ${index}`, createdAt: timestamp, updatedAt: timestamp };
    });
    await writeFile(path, JSON.stringify({ version: 1, notes }), 'utf8');
    const store = new NoteStore(path, { now: () => new Date(NOW) });
    await store.load();
    assert.equal((await store.list()).length, NOTE_MAX_ENTRIES);
    await assertNoteError(store.add('Over limit'), 'NOTE_LIMIT_ERROR');
  });
});

test('failed atomic replacement restores the previous valid notes file and memory state', async () => {
  await withStore(async (_store, path) => {
    let failReplacement = false;
    const fileSystem: NoteFileSystem = {
      mkdir: async (directory) => { await mkdir(directory, { recursive: true }); },
      readFile: async (file) => readFile(file, 'utf8'),
      writeFile: async (file, data) => { await writeFile(file, data, 'utf8'); },
      rename: async (from, to) => {
        if (failReplacement && to === path && from.endsWith('.tmp')) {
          failReplacement = false;
          throw new Error('controlled replacement failure');
        }
        await rename(from, to);
      },
      rm: async (file) => { await rm(file, { force: true }); },
    };
    const store = new NoteStore(path, { fileSystem, now: () => new Date(NOW), idFactory: (() => { let id = 0; return () => `0000000${(++id).toString(16)}`; })() });
    await store.load();
    const first = await store.add('Previous note');
    const original = await readFile(path, 'utf8');
    failReplacement = true;
    await assertNoteError(store.add('Would fail'), 'NOTE_IO_ERROR');
    assert.equal(await readFile(path, 'utf8'), original);
    assert.deepEqual((await store.list()).map(({ id }) => id), [first.id]);
    assert.deepEqual(await readdir(dirname(path)), ['notes.json']);
  });
});

test('notes storage defaults outside the repository and supports a test override', () => {
  assert.equal(resolveNotesPath({}), resolve(homedir(), '.waifu-assistant', 'notes.json'));
  assert.equal(resolveNotesPath({ YUKI_NOTES_PATH: 'C:/temp/yuki-notes.json' }), resolve('C:/temp/yuki-notes.json'));
});
