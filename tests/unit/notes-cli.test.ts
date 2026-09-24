import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

test('local note commands persist separately without provider calls, Session turns, or memory writes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'waifu-notes-cli-'));
  const notesPath = join(directory, 'notes.json');
  const memoryPath = join(directory, 'memory.json');
  const sessionsPath = join(directory, 'sessions.json');
  const remindersPath = join(directory, 'reminders.json');
  const noteText = "$(Get-Process); rm -rf; & \"quoted\" 'single' `backtick` $HOME 🌸";
  try {
    await writeFile(notesPath, JSON.stringify({
      version: 1,
      notes: [{
        id: 'n-aaaa0001', text: 'Existing note to show and delete',
        createdAt: '2026-09-23T17:00:00.000Z', updatedAt: '2026-09-23T17:00:00.000Z',
      }],
    }), 'utf8');
    const output = execFileSync(process.execPath, [resolve('dist/main.js'), '--interactive'], {
      cwd: process.cwd(),
      input: `/note-add ${noteText}\n/notes\n/note-show n-aaaa0001\n/note-delete n-aaaa0001\n/memory\n/history\n/exit\n`,
      encoding: 'utf8',
      timeout: 5000,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        WINDIR: process.env.WINDIR,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        AI_PROVIDER: 'mock',
        AI_PROVIDER_PROFILE: '',
        AI_BASE_URL: '',
        AI_API_KEY: '',
        AI_MODEL: '',
        YUKI_NOTES_PATH: notesPath,
        YUKI_MEMORY_PATH: memoryPath,
        YUKI_SESSIONS_PATH: sessionsPath,
        YUKI_REMINDERS_PATH: remindersPath,
      },
    });

    assert.match(output, /Nota creada: n-[a-f0-9]{8}/u);
    assert.ok(output.includes(noteText));
    assert.ok(output.includes('Nota: n-aaaa0001'));
    assert.ok(output.includes('Existing note to show and delete'));
    assert.ok(output.includes('Nota eliminada: n-aaaa0001'));
    assert.match(output, /No hay memorias guardadas\./u);
    assert.match(output, /No hay mensajes en la sesión actual\./u);
    assert.ok(!output.includes('AI stream request started'));
    const document = JSON.parse(await readFile(notesPath, 'utf8')) as {
      readonly version: number;
      readonly notes: readonly { readonly id: string; readonly text: string }[];
    };
    assert.equal(document.version, 1);
    assert.deepEqual(document.notes.map(({ text }) => text), [noteText]);
    await assert.rejects(readFile(memoryPath, 'utf8'), (error: unknown) =>
      typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT');
    await assert.rejects(readFile(sessionsPath, 'utf8'), (error: unknown) =>
      typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT');
    await assert.rejects(readFile(remindersPath, 'utf8'), (error: unknown) =>
      typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
