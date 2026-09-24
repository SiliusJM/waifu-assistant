import assert from 'node:assert/strict';
import test from 'node:test';
import type { AIProvider } from '../../src/ai/ai-provider.js';
import type { AIResponse, AIStreamEvent } from '../../src/ai/ai-types.js';
import { AssistantCore } from '../../src/core/assistant-core.js';
import { CAPABILITY_CATALOG, formatCapabilityHelp, resolveNaturalCapabilityHelp } from '../../src/core/capability-catalog.js';
import { ConversationRunner, LOCAL_COMMAND_HELP } from '../../src/core/conversation-runner.js';

async function* inputs(values: readonly string[]): AsyncIterable<string> {
  yield* values;
}

function countingProvider(): AIProvider & { readonly calls: number } {
  let calls = 0;
  return {
    name: 'capability-discovery-test',
    get calls(): number { return calls; },
    async complete(): Promise<AIResponse> {
      calls += 1;
      return { text: 'provider reply', provider: 'capability-discovery-test', model: 'test', finishReason: 'stop' };
    },
    async *stream(): AsyncIterable<AIStreamEvent> {
      calls += 1;
      yield { type: 'text_delta', delta: 'provider reply' };
      yield {
        type: 'completed',
        response: { text: 'provider reply', provider: 'capability-discovery-test', model: 'test', finishReason: 'stop' },
      };
    },
  };
}

test('clear natural help questions describe implemented capabilities from the shared catalogue', () => {
  const examples: readonly [string, string][] = [
    ['¿Qué puedes hacer?', '/note-add'],
    ['¿Qué comandos tienes?', '/help'],
    ['¿Cómo creo un recordatorio?', '/remind'],
    ['¿Cómo guardo una nota?', '/note-add'],
    ['¿Cómo busco una conversación?', '/session-search'],
    ['¿Cómo exporto una conversación?', '/export'],
    ['¿Cómo veo tu estado?', '/status'],
    ['¿Cómo uso la calculadora o consulto la hora?', '/calc'],
  ];
  for (const [query, expected] of examples) {
    assert.ok(resolveNaturalCapabilityHelp(query)?.includes(expected), `query was not answered with ${expected}: ${query}`);
  }
});

test('/help is rendered from the same catalogue and includes the existing explicit commands', () => {
  const help = formatCapabilityHelp();
  assert.equal(LOCAL_COMMAND_HELP, help);
  for (const command of [
    '/help', '/cancel', '/exit', '/history', '/clear', '/remember', '/memory', '/forget',
    '/save-session', '/sessions', '/session-info', '/rename', '/load-session', '/delete-session',
    '/session-search', '/export', '/note-add', '/notes', '/note-show', '/note-delete',
    '/remind', '/reminders', '/reminder-complete', '/reminder-delete', '/time', '/calc', '/status',
  ]) assert.ok(help.includes(command), `existing command missing from help: ${command}`);
  assert.doesNotMatch(help, /Internet\/Search|Internet habilitado|navegación web disponible|voz disponible|avatar disponible|cloud sync disponible/iu);
  assert.equal(CAPABILITY_CATALOG.length, 7);
});

test('data queries and natural actions are not misclassified as capability help', () => {
  assert.equal(resolveNaturalCapabilityHelp('¿Qué recordatorios tengo?'), undefined);
  assert.equal(resolveNaturalCapabilityHelp('¿Qué notas tengo guardadas?'), undefined);
  assert.equal(resolveNaturalCapabilityHelp('Recuérdame mañana comprar pan'), undefined);
  assert.equal(resolveNaturalCapabilityHelp('Guarda una nota: comprar pan'), undefined);
});

test('unavailable capabilities are described honestly without promising future support', () => {
  for (const query of [
    '¿Puedes navegar por Internet?',
    '¿Puedes hacer Search?',
    '¿Tienes voz?',
    '¿Tienes avatar?',
  ]) {
    const answer = resolveNaturalCapabilityHelp(query) ?? '';
    assert.match(answer, /no (?:está habilitada|están habilitadas|está habilitado) en esta versión/u, query);
    assert.doesNotMatch(answer, /pronto|en el futuro|será disponible/u, query);
  }
});

test('destructive and provider-change help answers are local, read-only, and do not expose private data', async () => {
  const provider = countingProvider();
  const runner = new ConversationRunner(new AssistantCore({ provider }));
  const visible: string[] = [];
  const result = await runner.run(inputs([
    '¿Cómo borro una nota?',
    '¿Cómo cambio de provider?',
    '¿Puedes navegar por Internet?',
    '/exit',
  ]), { onDelta: (text) => { visible.push(text); } });

  assert.equal(result.status, 'completed');
  assert.equal(provider.calls, 0);
  assert.match(visible[0] ?? '', /\/note-delete <id>/u);
  assert.match(visible[1] ?? '', /configuran localmente/u);
  assert.match(visible[2] ?? '', /no está habilitada/u);
  assert.doesNotMatch(visible.join('\n'), /API_KEY|Authorization|secret-fixture|Persistent Memory contents/u);
  assert.deepEqual(result.session.getMessages().map(({ role }) => role), [
    'user', 'assistant', 'user', 'assistant', 'user', 'assistant',
  ]);
  assert.equal(result.responses.length, 3);
  assert.ok(result.responses.every(({ provider: usedProvider, model }) => usedProvider === 'local-capability-help' && model === 'local'));
});

test('natural help clears a pending clarification and never performs its action', async () => {
  const provider = countingProvider();
  const runner = new ConversationRunner(new AssistantCore({ provider }));
  const outputs: string[] = [];
  const clarifications = {
    pending: false,
    clear(): void { this.pending = false; },
    async handle(input: string): Promise<string | undefined> {
      if (input === 'Recuérdame mañana comprar pan') {
        this.pending = true;
        return '¿A qué hora?';
      }
      if (this.pending) return 'would execute if not cleared';
      return undefined;
    },
  };
  await runner.run(inputs([
    'Recuérdame mañana comprar pan',
    '¿Cómo creo un recordatorio?',
    '8',
    '/exit',
  ]), {
    clarification: clarifications,
    onDelta: (text) => { outputs.push(text); },
  });

  assert.equal(provider.calls, 1);
  assert.match(outputs[1] ?? '', /\/remind/u);
  assert.equal(outputs.includes('would execute if not cleared'), false);
});
