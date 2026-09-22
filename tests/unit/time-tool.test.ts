import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalToolManager, executeLocalTime, formatLocalTime } from '../../src/tools/local-tool-manager.js';

test('local time tool is registered and returns structured host-clock data', async () => {
  const manager = createLocalToolManager(() => new Date('2026-09-22T18:30:04.000Z'));
  const result = await executeLocalTime(manager, { sessionId: 'time-test' });

  assert.equal(result.status, 'success');
  if (result.status !== 'success') return;
  assert.equal(result.value.iso, '2026-09-22T18:30:04.000Z');
  assert.equal(typeof result.value.localTime, 'string');
  assert.ok(result.value.localTime.length > 0);
  assert.equal(typeof result.value.timeZone, 'string');
  assert.equal(typeof result.value.offsetMinutes, 'number');
  assert.match(formatLocalTime(result.value), /^Hora local: .+ \([+-]\d{2}:\d{2}\)$/);
});

test('local time tool requires the explicit command authorization', async () => {
  const manager = createLocalToolManager(() => new Date('2026-09-22T18:30:04.000Z'));
  const result = await manager.execute('local.time', {}, { sessionId: 'time-test' });

  assert.deepEqual(result, {
    status: 'failure',
    error: {
      code: 'TOOL_PERMISSION_ERROR',
      message: 'The tool requires an explicit local command.',
      retryable: false,
    },
  });
});
