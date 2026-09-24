import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, mkdir, link, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AIProvider } from '../../src/ai/ai-provider.js';
import type { AIRequest, AIResponse, AIStreamEvent, ProviderCallOptions } from '../../src/ai/ai-types.js';
import { AssistantCore } from '../../src/core/assistant-core.js';
import { ConversationRunner } from '../../src/core/conversation-runner.js';
import { Session } from '../../src/core/session.js';
import {
  MarkdownConversationExporter,
  type ConversationExportFileSystem,
} from '../../src/core/markdown-conversation-exporter.js';
import { AssistantError } from '../../src/shared/errors.js';

const fixedDate = new Date('2026-09-23T18:05:00.000Z');

async function withExportDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const parent = await mkdtemp(join(tmpdir(), 'waifu-export-test-'));
  const directory = join(parent, 'user-data', 'exports');
  try { await run(directory); } finally { await rm(parent, { recursive: true, force: true }); }
}

function messages(...entries: ReadonlyArray<readonly ['user' | 'assistant' | 'system' | 'tool', string]>) {
  const session = new Session('export-test');
  for (const [role, content] of entries) session.addMessage(role, content);
  return session.getMessages();
}

function assertExportError(operation: Promise<unknown>, code: AssistantError['code']): Promise<void> {
  return assert.rejects(operation, (error: unknown) => error instanceof AssistantError && error.code === code);
}

test('exports only visible persisted user/assistant messages in order as UTF-8 Markdown', async () => {
  await withExportDirectory(async (directory) => {
    const conversation = messages(
      ['system', 'private system instruction; memory=PRIVATE-MEMORY; api_key=NEVER-EXPORT; provider=https://private.invalid'],
      ['user', 'Hola, José 🌸\r\nsegunda línea\r\n```ts\r\nconst saludo = "こんにちは";\r\n```'],
      ['tool', '{"toolId":"local.calculate","arguments":{"expression":"secret"}}'],
      ['assistant', '¡Hola! ¿Cómo estás?\n\nConservé el código.'],
    );
    const exporter = new MarkdownConversationExporter(directory, undefined, () => new Date(fixedDate));
    const result = await exporter.exportConversation(conversation);
    assert.equal(result.status, 'exported');
    if (result.status !== 'exported') return;

    const content = await readFile(result.filePath, 'utf8');
    assert.equal(result.fileName, 'yuki-conversation-2026-09-23-180500.md');
    assert.equal(result.messageCount, 2);
    assert.match(content, /^# Conversación con Yuki\n- Exportada: 2026-09-23T18:05:00\.000Z\n- Mensajes: 2\n/u);
    assert.ok(content.includes('## Usuario\n\nHola, José 🌸\nsegunda línea\n```ts\nconst saludo = "こんにちは";\n```'));
    assert.ok(content.includes('## Yuki\n\n¡Hola! ¿Cómo estás?\n\nConservé el código.'));
    assert.ok(content.indexOf('## Usuario') < content.indexOf('## Yuki'));
    assert.equal(content.includes('private system instruction'), false);
    assert.equal(content.includes('PRIVATE-MEMORY'), false);
    assert.equal(content.includes('NEVER-EXPORT'), false);
    assert.equal(content.includes('private.invalid'), false);
    assert.equal(content.includes('toolId'), false);
    assert.equal(content.includes('arguments'), false);
  });
});

test('exports a visible local.calculate final answer without raw tool data', async () => {
  await withExportDirectory(async (directory) => {
    const conversation = messages(
      ['user', '/calc 2 + 2'],
      ['tool', '{"toolId":"local.calculate","arguments":{"expression":"2 + 2"},"result":4}'],
      ['assistant', 'El resultado es 4.'],
    );
    const exporter = new MarkdownConversationExporter(directory, undefined, () => new Date(fixedDate));
    const result = await exporter.exportConversation(conversation);
    assert.equal(result.status, 'exported');
    if (result.status !== 'exported') return;
    const content = await readFile(result.filePath, 'utf8');
    assert.match(content, /El resultado es 4\./u);
    assert.doesNotMatch(content, /toolId|arguments|local\.calculate/u);
  });
});

test('uses a non-empty conversation title in Markdown without exposing Session IDs', async () => {
  await withExportDirectory(async (directory) => {
    const exporter = new MarkdownConversationExporter(directory, undefined, () => new Date(fixedDate));
    const result = await exporter.exportConversation(messages(['user', 'Hola'], ['assistant', 'Qué tal']), undefined, 'Yuki 🌸');
    assert.equal(result.status, 'exported');
    if (result.status !== 'exported') return;
    const content = await readFile(result.filePath, 'utf8');
    assert.match(content, /^# Yuki 🌸\n/u);
    assert.equal(content.includes('export-test'), false);
  });
});

test('does not export partial interrupted assistant output that Session never persisted', async () => {
  await withExportDirectory(async (directory) => {
    let signalStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { signalStarted = resolve; });
    let provideNext!: (value: string) => void;
    const nextInput = new Promise<string>((resolve) => { provideNext = resolve; });
    const provider: AIProvider & { readonly firstStarted: Promise<void> } = {
      name: 'export-interruption-test',
      firstStarted,
      complete: async (): Promise<AIResponse> => ({
        text: 'unused', provider: 'export-interruption-test', model: 'test', finishReason: 'stop',
      }),
      async *stream(request: AIRequest, options?: ProviderCallOptions): AsyncIterable<AIStreamEvent> {
        const input = request.messages.at(-1)?.content;
        if (input === 'Turn A') {
          yield { type: 'text_delta', delta: 'partial-A-must-not-export' };
          signalStarted();
          await new Promise<void>((resolve) => {
            if (options?.signal?.aborted) { resolve(); return; }
            options?.signal?.addEventListener('abort', () => resolve(), { once: true });
          });
          throw new Error('cancelled first turn');
        }
        yield { type: 'text_delta', delta: 'Final B' };
        yield {
          type: 'completed',
          response: { text: 'Final B', provider: 'export-interruption-test', model: 'test', finishReason: 'stop' },
        };
      },
    };
    const source = (async function* (): AsyncIterable<string> {
      yield 'Turn A';
      yield await nextInput;
    }());
    const runner = new ConversationRunner(new AssistantCore({ provider }));
    const pending = runner.run(source, { interruptible: true });
    await firstStarted;
    provideNext('Turn B');
    const completed = await pending;
    assert.equal(completed.status, 'completed');

    const exporter = new MarkdownConversationExporter(directory, undefined, () => new Date(fixedDate));
    const result = await exporter.exportConversation(completed.session.getMessages());
    assert.equal(result.status, 'exported');
    if (result.status !== 'exported') return;
    const content = await readFile(result.filePath, 'utf8');
    assert.match(content, /Turn A/u);
    assert.match(content, /Turn B/u);
    assert.match(content, /Final B/u);
    assert.doesNotMatch(content, /partial-A-must-not-export/u);
  });
});

test('empty visible conversation creates neither an export file nor its directory', async () => {
  await withExportDirectory(async (directory) => {
    const exporter = new MarkdownConversationExporter(directory, undefined, () => new Date(fixedDate));
    const result = await exporter.exportConversation(messages(['system', 'internal'], ['tool', '{"raw":true}']));
    assert.deepEqual(result, { status: 'empty' });
    await assert.rejects(access(directory));
  });
});

test('custom names are stable, extensions are normalized and existing files get numeric suffixes', async () => {
  await withExportDirectory(async (directory) => {
    const exporter = new MarkdownConversationExporter(directory, undefined, () => new Date(fixedDate));
    const conversation = messages(['user', 'hola'], ['assistant', 'respuesta']);
    const first = await exporter.exportConversation(conversation, 'charla-yuki');
    const second = await exporter.exportConversation(conversation, 'charla-yuki.md');
    const third = await exporter.exportConversation(conversation, 'charla-yuki');
    assert.equal(first.status, 'exported');
    assert.equal(second.status, 'exported');
    assert.equal(third.status, 'exported');
    if (first.status !== 'exported' || second.status !== 'exported' || third.status !== 'exported') return;
    assert.deepEqual([first.fileName, second.fileName, third.fileName], ['charla-yuki.md', 'charla-yuki-2.md', 'charla-yuki-3.md']);
    assert.equal(await readFile(first.filePath, 'utf8'), await readFile(second.filePath, 'utf8'));
    assert.equal((await readdir(directory)).length, 3);
  });
});

test('path-like names are rejected and reserved Windows names are made safe', async () => {
  await withExportDirectory(async (directory) => {
    const exporter = new MarkdownConversationExporter(directory, undefined, () => new Date(fixedDate));
    const conversation = messages(['user', 'hola']);
    for (const name of ['../../secret', '..\\..\\secret', 'C:\\temp\\secret', '/absolute/path', 'foo/bar', '.', '..']) {
      await assertExportError(exporter.exportConversation(conversation, name), 'EXPORT_CONFIGURATION_ERROR');
    }
    const reserved = await exporter.exportConversation(conversation, 'CON');
    assert.equal(reserved.status, 'exported');
    if (reserved.status === 'exported') assert.equal(reserved.fileName, '_CON.md');
    const secondReserved = await exporter.exportConversation(conversation, 'LPT9.txt.md');
    assert.equal(secondReserved.status, 'exported');
    if (secondReserved.status === 'exported') assert.equal(secondReserved.fileName, '_LPT9.txt.md');
    assert.equal((await readdir(directory)).every((name) => !name.includes('/') && !name.includes('\\')), true);
  });
});

test('concurrent duplicate exports reserve distinct filenames without overwriting', async () => {
  await withExportDirectory(async (directory) => {
    const exporter = new MarkdownConversationExporter(directory, undefined, () => new Date(fixedDate));
    const conversation = messages(['user', 'first'], ['assistant', 'second']);
    const results = await Promise.all([
      exporter.exportConversation(conversation, 'parallel'),
      exporter.exportConversation(conversation, 'parallel'),
    ]);
    assert.deepEqual(results.map((result) => result.status), ['exported', 'exported']);
    const paths = results.flatMap((result) => result.status === 'exported' ? [result.filePath] : []);
    assert.equal(new Set(paths).size, 2);
    assert.deepEqual((await readdir(directory)).sort(), ['parallel-2.md', 'parallel.md']);
  });
});

test('filesystem write failures become controlled export errors and clean temporary files', async () => {
  await withExportDirectory(async (directory) => {
    const failingFileSystem: ConversationExportFileSystem = {
      mkdir: async (path) => { await mkdir(path, { recursive: true }); },
      writeFile: async () => { throw new Error('write denied'); },
      link: async (source, destination) => link(source, destination),
      rm: async (path) => { await rm(path, { force: true }); },
      exists: async (path) => {
        try { await access(path); return true; } catch (error) {
          if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return false;
          throw error;
        }
      },
    };
    const exporter = new MarkdownConversationExporter(directory, failingFileSystem, () => new Date(fixedDate));
    await assertExportError(exporter.exportConversation(messages(['user', 'hola'])), 'EXPORT_IO_ERROR');
    assert.deepEqual(await readdir(directory), []);
  });
});
