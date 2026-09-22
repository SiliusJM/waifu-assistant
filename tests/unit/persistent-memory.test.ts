import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, mkdir, writeFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AssistantError } from '../../src/shared/errors.js';
import {
  MEMORY_MAX_ENTRIES,
  MEMORY_MAX_VALUE_LENGTH,
  PersistentMemoryStore,
  type MemoryFileSystem,
} from '../../src/memory/index.js';

async function withStore(run: (store: PersistentMemoryStore, filePath: string, directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'waifu-memory-test-'));
  const filePath = join(directory, 'nested', 'memory.json');
  try {
    const store = new PersistentMemoryStore(filePath);
    await store.load();
    await run(store, filePath, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function assertCode(operation: Promise<unknown>, code: AssistantError['code']): Promise<void> {
  return assert.rejects(operation, (error: unknown) => error instanceof AssistantError && error.code === code);
}

test('persistent memory starts empty and supports CRUD, ordering, overwrite and reload', async () => {
  await withStore(async (store, filePath) => {
    assert.equal(await store.count(), 0);
    assert.equal(await store.get('missing'), undefined);
    await store.set('z', 'last');
    await store.set('a', 'first');
    await store.set('m', 'middle');
    await store.set('a', 'updated');
    assert.deepEqual(await store.list(), [
      { key: 'a', value: 'updated' },
      { key: 'm', value: 'middle' },
      { key: 'z', value: 'last' },
    ]);
    assert.equal(await store.delete('missing'), false);
    assert.equal(await store.delete('m'), true);

    const reloaded = new PersistentMemoryStore(filePath);
    await reloaded.load();
    assert.deepEqual(await reloaded.list(), [
      { key: 'a', value: 'updated' },
      { key: 'z', value: 'last' },
    ]);
  });
});

test('memory key validation accepts boundaries and rejects unsafe values', async () => {
  await withStore(async (store) => {
    for (const key of ['a', 'A', 'abc123', 'a_b', 'a-b', 'x'.repeat(64)]) {
      await store.set(key, 'ok');
    }
    for (const key of ['', 'x'.repeat(65), 'a b', 'a/b', 'a\\b', '../a', '.', '..', 'á', '🔥', '\t', '\n', '\0']) {
      await assertCode(store.set(key, 'bad'), 'MEMORY_CONFIGURATION_ERROR');
    }
  });
});

test('memory values preserve UTF-8 and special strings while enforcing limits', async () => {
  await withStore(async (store, filePath) => {
    const values = ['Jhon', 'José', 'こんにちは', 'Yuki 🌸', '"null"', '$(rm -rf /)', '<script>alert(1)</script>'];
    for (const [index, value] of values.entries()) await store.set(`value_${index}`, value);
    await store.set('one', 'x');
    await store.set('max', 'x'.repeat(MEMORY_MAX_VALUE_LENGTH));
    await assertCode(store.set('too_long', 'x'.repeat(MEMORY_MAX_VALUE_LENGTH + 1)), 'MEMORY_CONFIGURATION_ERROR');
    const reloaded = new PersistentMemoryStore(filePath);
    await reloaded.load();
    assert.equal(await reloaded.get('value_3'), 'Yuki 🌸');
    assert.equal(await reloaded.get('value_6'), '<script>alert(1)</script>');
    assert.equal((await reloaded.get('max'))?.length, MEMORY_MAX_VALUE_LENGTH);
  });
});

test('memory enforces the entry limit while permitting overwrite and replacement', async () => {
  await withStore(async (store) => {
    for (let index = 0; index < MEMORY_MAX_ENTRIES; index += 1) await store.set(`key_${index}`, String(index));
    await store.set('key_0', 'updated');
    await assertCode(store.set('key_100', 'overflow'), 'MEMORY_LIMIT_ERROR');
    assert.equal(await store.delete('key_0'), true);
    await store.set('key_100', 'replacement');
    assert.equal(await store.count(), MEMORY_MAX_ENTRIES);
  });
});

test('missing parent directories are created only when persisting', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'waifu-memory-parent-'));
  const filePath = join(directory, 'a', 'b', 'memory.json');
  try {
    const store = new PersistentMemoryStore(filePath);
    await store.load();
    assert.equal((await readdir(directory)).length, 0);
    await store.set('created', 'yes');
    assert.equal(await store.get('created'), 'yes');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('corrupt, empty, wrong-version and invalid-schema files are rejected without reset', async () => {
  const cases: Array<[string, string]> = [
    ['corrupt', '{bad-json'],
    ['empty', ''],
    ['version', JSON.stringify({ version: 99, entries: {} })],
    ['array', JSON.stringify([])],
    ['entries-array', JSON.stringify({ version: 1, entries: [] })],
    ['number-value', JSON.stringify({ version: 1, entries: { x: 123 } })],
  ];
  for (const [name, content] of cases) {
    const directory = await mkdtemp(join(tmpdir(), `waifu-memory-${name}-`));
    const filePath = join(directory, 'memory.json');
    try {
      await writeFile(filePath, content, 'utf8');
      const store = new PersistentMemoryStore(filePath);
      await assertCode(store.load(), 'MEMORY_CORRUPT_ERROR');
      assert.equal(await readFile(filePath, 'utf8'), content);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test('directory at memory file path is a controlled I/O error', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'waifu-memory-directory-'));
  const filePath = join(directory, 'memory.json');
  try {
    await mkdir(filePath);
    await assertCode(new PersistentMemoryStore(filePath).load(), 'MEMORY_IO_ERROR');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('atomic writes leave a valid file and no temporary artifacts', async () => {
  await withStore(async (store, _filePath, directory) => {
    await store.set('safe', 'value');
    const files = await readdir(directory, { recursive: true });
    assert.equal(files.some((file) => file.endsWith('.tmp') || file.endsWith('.bak')), false);
    const document = JSON.parse(await readFile(join(directory, 'nested', 'memory.json'), 'utf8')) as { version: number };
    assert.equal(document.version, 1);
  });
});

test('write failures are controlled and do not leave the final file partially written', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'waifu-memory-failure-'));
  const filePath = join(directory, 'memory.json');
  const failingFileSystem: MemoryFileSystem = {
    mkdir: async (path) => { await mkdir(path, { recursive: true }); },
    readFile: async (path) => readFile(path, 'utf8'),
    writeFile: async () => { throw new Error('controlled write failure'); },
    rename,
    rm: async (path) => { await rm(path, { force: true }); },
  };
  try {
    const store = new PersistentMemoryStore(filePath, failingFileSystem);
    await store.load();
    await assertCode(store.set('x', 'y'), 'MEMORY_IO_ERROR');
    await assert.rejects(readFile(filePath, 'utf8'));
    assert.equal((await readdir(directory)).some((file) => file.endsWith('.tmp')), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('repeated operations and deterministic seeded operations match an in-memory reference', async () => {
  await withStore(async (store) => {
    const reference = new Map<string, string>();
    for (let index = 0; index < 250; index += 1) {
      const key = `repeat_${index % 37}`;
      if (index % 5 === 0) {
        await store.delete(key);
        reference.delete(key);
      } else {
        const value = String(index);
        await store.set(key, value);
        reference.set(key, value);
      }
    }
    const next = (value: number): number => (value * 1664525 + 1013904223) >>> 0;
    let seed = 742;
    for (let index = 0; index < 500; index += 1) {
      seed = next(seed);
      const key = `generated_${seed % 47}`;
      if (seed % 3 === 0) {
        await store.delete(key);
        reference.delete(key);
      } else {
        const value = `value-${seed}`;
        await store.set(key, value);
        reference.set(key, value);
      }
      if (index % 17 === 0) {
        const current = await store.list();
        assert.deepEqual(current, [...reference.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => ({ key, value })));
      }
    }
    const current = await store.list();
    assert.deepEqual(current, [...reference.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => ({ key, value })));
  });
});

test('two store instances preserve explicit sequential updates', async () => {
  await withStore(async (_store, filePath) => {
    const first = new PersistentMemoryStore(filePath);
    const second = new PersistentMemoryStore(filePath);
    await first.load();
    await second.load();
    await first.set('first', 'one');
    await second.load();
    await second.set('second', 'two');
    const final = new PersistentMemoryStore(filePath);
    await final.load();
    assert.deepEqual(await final.list(), [{ key: 'first', value: 'one' }, { key: 'second', value: 'two' }]);
  });
});
