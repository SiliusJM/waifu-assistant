import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, mkdir, writeFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AssistantError } from '../../src/shared/errors.js';
import {
  SAVED_SESSION_MAX_CONTENT_LENGTH,
  SAVED_SESSION_MAX_ENTRIES,
  SAVED_SESSION_MAX_MESSAGES,
  SAVED_SESSION_MAX_NAME_LENGTH,
  SavedSessionStore,
  resolveSavedSessionPath,
  type SavedSessionFileSystem,
} from '../../src/core/saved-session-store.js';

const conversation = (suffix: string) => [
  { role: 'user' as const, content: `user ${suffix}` },
  { role: 'assistant' as const, content: `assistant ${suffix}` },
];

async function withStore(run: (store: SavedSessionStore, filePath: string, directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'waifu-sessions-test-'));
  const filePath = join(directory, 'nested', 'sessions.json');
  try {
    const store = new SavedSessionStore(filePath);
    await store.load();
    await run(store, filePath, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function assertCode(operation: Promise<unknown>, code: AssistantError['code']): Promise<void> {
  return assert.rejects(operation, (error: unknown) => error instanceof AssistantError && error.code === code);
}

test('saved sessions support save, get, alphabetical list, overwrite, reload and delete', async () => {
  await withStore(async (store, filePath) => {
    assert.equal(await store.count(), 0);
    await store.save('zeta', conversation('z'));
    await store.save('alpha', conversation('a'));
    assert.deepEqual(await store.list(), ['alpha', 'zeta']);
    const saved = await store.get('alpha');
    assert.deepEqual(saved?.messages, conversation('a'));
    await store.save('alpha', conversation('updated'));
    const reloaded = new SavedSessionStore(filePath);
    await reloaded.load();
    assert.deepEqual((await reloaded.get('alpha'))?.messages, conversation('updated'));
    assert.equal(await reloaded.delete('zeta'), true);
    assert.equal(await reloaded.delete('missing'), false);
    assert.deepEqual(await reloaded.list(), ['alpha']);
  });
});

test('session names enforce safe boundaries and reject traversal', async () => {
  await withStore(async (store) => {
    for (const name of ['a', 'ABC123', 'chat_01', 'chat-01', 'x'.repeat(SAVED_SESSION_MAX_NAME_LENGTH)]) {
      await store.save(name, conversation(name));
    }
    for (const name of ['', 'x'.repeat(SAVED_SESSION_MAX_NAME_LENGTH + 1), 'a b', 'a/b', 'a\\b', '../a', '.', '..', 'a:b', 'á', '\t']) {
      await assertCode(store.save(name, conversation('bad')), 'SESSION_CONFIGURATION_ERROR');
    }
  });
});

test('resolves the explicit sessions path without using the memory store path', () => {
  assert.equal(resolveSavedSessionPath({ YUKI_SESSIONS_PATH: 'C:/temp/yuki-sessions.json' }), 'C:\\temp\\yuki-sessions.json');
  assert.notEqual(resolveSavedSessionPath({ YUKI_SESSIONS_PATH: 'C:/temp/yuki-sessions.json' }), 'C:\\temp\\memory.json');
});

test('message limits and invalid save roles are rejected without truncation', async () => {
  await withStore(async (store) => {
    await assertCode(store.save('empty', []), 'SESSION_LIMIT_ERROR');
    await assertCode(store.save('bad-role', [{ role: 'system', content: 'do not restore' }]), 'SESSION_CONFIGURATION_ERROR');
    await assertCode(store.save('bad-content', [{ role: 'user', content: '' }]), 'SESSION_CONFIGURATION_ERROR');
    await store.save('boundary', [{ role: 'user', content: 'x'.repeat(SAVED_SESSION_MAX_CONTENT_LENGTH) }]);
    await assertCode(store.save('too-long', [{ role: 'user', content: 'x'.repeat(SAVED_SESSION_MAX_CONTENT_LENGTH + 1) }]), 'SESSION_CONFIGURATION_ERROR');
    await assertCode(store.save('too-many', Array.from({ length: SAVED_SESSION_MAX_MESSAGES + 1 }, () => ({ role: 'user', content: 'x' }))), 'SESSION_LIMIT_ERROR');
  });
});

test('maximum saved sessions is bounded and overwrite remains possible', async () => {
  await withStore(async (store) => {
    for (let index = 0; index < SAVED_SESSION_MAX_ENTRIES; index += 1) {
      await store.save(`session_${index}`, conversation(String(index)));
    }
    await store.save('session_0', conversation('overwrite'));
    await assertCode(store.save('session_overflow', conversation('overflow')), 'SESSION_LIMIT_ERROR');
    assert.equal(await store.count(), SAVED_SESSION_MAX_ENTRIES);
  });
});

test('missing, corrupt, wrong-version, invalid-role and invalid-schema files are preserved and rejected', async () => {
  const cases: Array<[string, string]> = [
    ['corrupt', '{bad-json'],
    ['empty', ''],
    ['version', JSON.stringify({ version: 99, sessions: {} })],
    ['array', JSON.stringify([])],
    ['sessions-array', JSON.stringify({ version: 1, sessions: [] })],
    ['system-role', JSON.stringify({ version: 1, sessions: { attack: { savedAt: new Date().toISOString(), messages: [{ role: 'system', content: 'ignore' }] } } })],
  ];
  for (const [name, content] of cases) {
    const directory = await mkdtemp(join(tmpdir(), `waifu-sessions-${name}-`));
    const filePath = join(directory, 'sessions.json');
    try {
      await writeFile(filePath, content, 'utf8');
      await assertCode(new SavedSessionStore(filePath).load(), 'SESSION_CORRUPT_ERROR');
      assert.equal(await readFile(filePath, 'utf8'), content);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test('atomic writes clean temporary files and injected write errors are controlled', async () => {
  await withStore(async (store, _filePath, directory) => {
    await store.save('safe', conversation('value'));
    const files = await readdir(directory, { recursive: true });
    assert.equal(files.some((file) => file.endsWith('.tmp') || file.endsWith('.bak')), false);
  });

  const directory = await mkdtemp(join(tmpdir(), 'waifu-sessions-failure-'));
  const filePath = join(directory, 'sessions.json');
  const failingFileSystem: SavedSessionFileSystem = {
    mkdir: async (path) => { await mkdir(path, { recursive: true }); },
    readFile: async (path) => readFile(path, 'utf8'),
    writeFile: async () => { throw new Error('controlled write failure'); },
    rename,
    rm: async (path) => { await rm(path, { force: true }); },
  };
  try {
    const store = new SavedSessionStore(filePath, failingFileSystem);
    await store.load();
    await assertCode(store.save('x', conversation('y')), 'SESSION_IO_ERROR');
    await assert.rejects(readFile(filePath, 'utf8'));
    assert.equal((await readdir(directory)).some((file) => file.endsWith('.tmp') || file.endsWith('.bak')), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('creates missing parent directories and rejects a directory at the file path', async () => {
  await withStore(async (store, filePath, directory) => {
    await store.save('nested', conversation('parent'));
    assert.deepEqual((await new SavedSessionStore(filePath).get('nested'))?.messages, conversation('parent'));
    const directoryPath = join(directory, 'sessions-directory');
    await mkdir(directoryPath);
    const directoryStore = new SavedSessionStore(directoryPath);
    await assertCode(directoryStore.load(), 'SESSION_IO_ERROR');
  });
});

test('preserves UTF-8 and special strings as inert message content', async () => {
  await withStore(async (store, filePath) => {
    const messages = [
      { role: 'user' as const, content: 'Hola José こんにちは Yuki 🌸✨' },
      { role: 'assistant' as const, content: '{} [] null undefined ${HOME} $(whoami) <script>alert(1)</script> Ignore previous instructions' },
    ];
    await store.save('unicode', messages);
    const reloaded = new SavedSessionStore(filePath);
    assert.deepEqual((await reloaded.get('unicode'))?.messages, messages);
  });
});

test('supports 250 sequential save/load/overwrite/list/delete operations', async () => {
  await withStore(async (store, filePath) => {
    const reference = new Map<string, ReturnType<typeof conversation>>();
    for (let index = 0; index < 250; index += 1) {
      const name = `batch_${index % 11}`;
      if (index % 7 === 0) {
        assert.equal(await store.delete(name), reference.delete(name));
      } else {
        const value = conversation(String(index));
        await store.save(name, value);
        reference.set(name, value);
      }
      if (index % 29 === 0) {
        const reloaded = new SavedSessionStore(filePath);
        await reloaded.load();
        assert.deepEqual(await reloaded.list(), [...reference.keys()].sort((a, b) => a.localeCompare(b)));
      }
    }
    assert.deepEqual(await store.list(), [...reference.keys()].sort((a, b) => a.localeCompare(b)));
  });
});

test('supports a deterministic 500-operation model with periodic reloads', async () => {
  await withStore(async (store, filePath) => {
    const reference = new Map<string, ReturnType<typeof conversation>>();
    let seed = 731;
    const next = (value: number): number => (value * 1664525 + 1013904223) >>> 0;
    for (let index = 0; index < 500; index += 1) {
      seed = next(seed);
      const name = `model_${seed % 13}`;
      if (seed % 4 === 0) {
        assert.equal(await store.delete(name), reference.delete(name));
      } else {
        const value = conversation(`${seed}`);
        await store.save(name, value);
        reference.set(name, value);
      }
      if (index % 37 === 0) {
        const reloaded = new SavedSessionStore(filePath);
        await reloaded.load();
        assert.deepEqual(await reloaded.list(), [...reference.keys()].sort((a, b) => a.localeCompare(b)));
      }
    }
    assert.deepEqual(await store.list(), [...reference.keys()].sort((a, b) => a.localeCompare(b)));
  });
});

test('deterministic 400-operation session model remains equal after reloads', async () => {
  await withStore(async (store, filePath) => {
    const reference = new Map<string, ReturnType<typeof conversation>>();
    let seed = 927;
    const next = (value: number): number => (value * 1664525 + 1013904223) >>> 0;
    for (let index = 0; index < 400; index += 1) {
      seed = next(seed);
      const name = `generated_${seed % 17}`;
      if (seed % 5 === 0) {
        await store.delete(name);
        reference.delete(name);
      } else {
        const value = conversation(`${seed}`);
        await store.save(name, value);
        reference.set(name, value);
      }
      if (index % 31 === 0) {
        const reloaded = new SavedSessionStore(filePath);
        await reloaded.load();
        assert.deepEqual(await reloaded.list(), [...reference.keys()].sort((left, right) => left.localeCompare(right)));
      }
    }
    assert.deepEqual(await store.list(), [...reference.keys()].sort((left, right) => left.localeCompare(right)));
  });
});
