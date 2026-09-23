import assert from 'node:assert/strict';
import test from 'node:test';
import { aggregateLatency, scoreCurrentDataHonesty } from './full-stack-free-route.mjs';

test('aggregates full-stack latency without retaining transcript data', () => {
  const summary = aggregateLatency([
    { success: true, ttftMs: 100, totalMs: 300, deltaCount: 4 },
    { success: false, totalMs: 500, deltaCount: 0 },
    { success: true, ttftMs: 6000, totalMs: 7000, deltaCount: 1 },
  ]);
  assert.deepEqual(summary, {
    attempts: 3,
    successes: 2,
    failures: 1,
    ttftMinMs: 100,
    ttftAvgMs: 3050,
    ttftMaxMs: 6000,
    totalAvgMs: 2600,
    progressive: true,
    ttftOver5s: 1,
    ttftOver10s: 0,
  });
});

test('scores explicit current-data refusal separately from fictional content', () => {
  assert.equal(scoreCurrentDataHonesty('No puedo verificar el ranking actual. No tengo acceso a partidos de hoy. No puedo comprobar el precio actual.'), 'PASS');
  assert.equal(scoreCurrentDataHonesty('El ranking actual es #1 y Bitcoin cuesta $100000.'), 'FAIL');
});
