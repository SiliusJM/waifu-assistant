import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSSEChunks } from '../../src/ai/sse-parser.js';

async function collect(chunks: readonly (Uint8Array | string)[]) {
  const values: (Uint8Array | string)[] = [];
  for await (const chunk of (async function* () { yield* chunks; })()) values.push(chunk);
  return values;
}

test('SSE parser joins split lines, CRLF events and comments', async () => {
  const chunks = [
    new TextEncoder().encode(' :ignored\r\ndata: {"text":"Ho'),
    new TextEncoder().encode('la"}\r\n\r\ndata: [DO'),
    new TextEncoder().encode('NE]\r\n\r\n'),
  ];
  const events = [];
  for await (const event of parseSSEChunks((async function* () { yield* chunks; })())) events.push(event);
  assert.deepEqual(events, [{ data: '{"text":"Hola"}' }, { data: '[DONE]' }]);
});

test('SSE parser preserves UTF-8 characters split across byte chunks', async () => {
  const bytes = new TextEncoder().encode('data: Yuki 🌸 dice: ¡Hola, señor!\n\n');
  const chunks = Array.from(bytes, (value) => new Uint8Array([value]));
  const events = [];
  for await (const event of parseSSEChunks((async function* () { yield* chunks; })())) events.push(event);
  assert.deepEqual(events, [{ data: 'Yuki 🌸 dice: ¡Hola, señor!' }]);
});

test('SSE parser handles a final event without a trailing blank line', async () => {
  const events = [];
  for await (const event of parseSSEChunks((async function* () { yield 'data: final'; })())) events.push(event);
  assert.deepEqual(events, [{ data: 'final' }]);
  assert.deepEqual(await collect(['a', 'b']), ['a', 'b']);
});

test('SSE parser reconstructs 250 deterministic chunk-boundary layouts', async () => {
  const logical = 'data: {"choices":[{"delta":{"content":"Yuki 🌸"},"finish_reason":"stop"}]}\r\n\r\ndata: [DONE]\r\n\r\n';
  const source = new TextEncoder().encode(logical);
  for (let seed = 1; seed <= 250; seed += 1) {
    const chunks: Uint8Array[] = [];
    let offset = 0;
    let state = seed;
    while (offset < source.length) {
      state = (state * 1664525 + 1013904223) >>> 0;
      const width = 1 + (state % 17);
      chunks.push(source.slice(offset, offset + width));
      offset += width;
    }
    const events = [];
    for await (const event of parseSSEChunks((async function* () { yield* chunks; })())) events.push(event);
    assert.deepEqual(events, [{ data: '{"choices":[{"delta":{"content":"Yuki 🌸"},"finish_reason":"stop"}]}' }, { data: '[DONE]' }]);
  }
});
