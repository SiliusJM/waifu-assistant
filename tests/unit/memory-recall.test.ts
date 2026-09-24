import assert from 'node:assert/strict';
import test from 'node:test';
import type { MemorySnapshot } from '../../src/memory/memory-types.js';
import {
  isExplicitMemoryRecallQuestion,
  MEMORY_RECALL_MAX_CHARACTERS,
  MEMORY_RECALL_MAX_ENTRIES,
  selectRelevantExplicitMemories,
} from '../../src/memory/memory-recall.js';

function snapshot(entries: readonly { readonly key: string; readonly value: string }[]): MemorySnapshot {
  return Object.freeze({ version: 1, entries: Object.freeze(entries.map((entry) => Object.freeze({ ...entry }))) });
}

test('recalls only explicitly saved keys relevant to a natural-language question', () => {
  const memories = snapshot([
    { key: 'favorite_game', value: 'Genshin Impact' },
    { key: 'home_city', value: 'Cuenca' },
  ]);

  assert.deepEqual(selectRelevantExplicitMemories('¿Cuál era el juego que me gustaba?', memories), [
    { key: 'favorite_game', value: 'Genshin Impact' },
  ]);
  assert.deepEqual(selectRelevantExplicitMemories('Calculate 50 * 3', memories), []);
});

test('key relevance handles Spanish diacritics, Unicode values, and current-user corrections without mutating memory', () => {
  const memories = snapshot([
    { key: 'name', value: 'Jhosé 🌸' },
    { key: 'city', value: 'Cuenca' },
  ]);
  const before = structuredClone(memories);

  assert.deepEqual(selectRelevantExplicitMemories('¿Cómo me llamo?', memories), [
    { key: 'name', value: 'Jhosé 🌸' },
  ]);
  assert.deepEqual(selectRelevantExplicitMemories('Ahora vivo en Guayaquil.', memories), [
    { key: 'city', value: 'Cuenca' },
  ]);
  assert.deepEqual(memories, before);
});

test('recall returns zero entries when nothing is clearly relevant', () => {
  assert.deepEqual(selectRelevantExplicitMemories('¿Qué hora es?', snapshot([
    { key: 'favorite_game', value: 'Genshin Impact' },
  ])), []);
  assert.deepEqual(selectRelevantExplicitMemories('¿Cuál era mi juego favorito?', undefined), []);
});

test('recall is deterministic and capped at three entries', () => {
  const memories = snapshot([
    { key: 'favorite_game', value: 'Genshin' },
    { key: 'favorite_book', value: 'Dune' },
    { key: 'favorite_color', value: 'azul' },
    { key: 'favorite_food', value: 'sushi' },
  ]);
  const result = selectRelevantExplicitMemories('Tell me my favorite things', memories);
  assert.equal(result.length, MEMORY_RECALL_MAX_ENTRIES);
  assert.deepEqual(result, memories.entries.slice(0, MEMORY_RECALL_MAX_ENTRIES));
});

test('recall respects the serialized character cap without truncating stored values', () => {
  const memories = snapshot([
    { key: 'favorite_long', value: 'é'.repeat(1000) },
    { key: 'favorite_second', value: '界'.repeat(1000) },
  ]);
  const result = selectRelevantExplicitMemories('What is my favorite information?', memories);
  const serializedLength = result.reduce(
    (total, { key, value }, index) => total + (index > 0 ? 1 : 0) + `- ${JSON.stringify(key)}: ${JSON.stringify(value)}`.length,
    0,
  );
  assert.ok(serializedLength <= MEMORY_RECALL_MAX_CHARACTERS);
  assert.ok(result.every(({ value }) => value.length === 1000));
  assert.equal(result.some(({ key }) => key === 'favorite_long'), true);
  assert.equal(result.some(({ key }) => key === 'favorite_second'), false);
});

test('credential-shaped keys and values are never selected', () => {
  const memories = snapshot([
    { key: 'api_key', value: 'sk-example-not-a-real-key' },
    { key: 'travel_plan', value: 'Authorization: Bearer example-token' },
    { key: 'favorite_game', value: 'Genshin Impact' },
  ]);
  assert.deepEqual(selectRelevantExplicitMemories('What is my favorite game and api key?', memories), [
    { key: 'favorite_game', value: 'Genshin Impact' },
  ]);
});

test('recognizes explicit memory recall questions to support an honest no-memory answer', () => {
  for (const input of [
    '¿Según tus memorias, cuál era mi código de prueba?',
    'What did I tell you about my city?',
    '¿Cómo me llamo?',
  ]) assert.equal(isExplicitMemoryRecallQuestion(input), true, input);
  for (const input of ['Calcula 50 * 3', '¿Qué recordatorios tengo?', 'Hola Yuki']) {
    assert.equal(isExplicitMemoryRecallQuestion(input), false, input);
  }
});
