import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalToolManager, executeLocalCalculation, formatCalculation } from '../../src/tools/local-tool-manager.js';
import { evaluateExpression } from '../../src/tools/calculator-tool.js';

test('calculator evaluates supported arithmetic without dynamic code execution', () => {
  const cases = [
    ['2 + 2', 4],
    ['25 * 4', 100],
    ['10 / 4', 2.5],
    ['(10 + 5) * 2', 30],
    ['-5 + 3', -2],
    ['2.5 * 4', 10],
  ] as const;
  for (const [expression, expected] of cases) {
    assert.equal(evaluateExpression(expression), expected);
  }
});

test('calculator rejects empty, invalid, unsafe and non-finite expressions', () => {
  for (const expression of ['', 'abc', 'process.exit()', '1 + foo', '2 +', '(2 + 3', '2 / 0', '1e3', '1 / (2 - 2)']) {
    assert.throws(() => evaluateExpression(expression));
  }
});

test('calculator executes through ToolManager and returns structured output', async () => {
  const manager = createLocalToolManager();
  const result = await executeLocalCalculation(manager, '25 * 4', { sessionId: 'calc-test' });

  assert.equal(result.status, 'success');
  if (result.status !== 'success') return;
  assert.deepEqual(result.value, { expression: '25 * 4', result: 100 });
  assert.equal(formatCalculation(result.value), '25 * 4 = 100');
});

test('calculator reports controlled failures through ToolManager', async () => {
  const manager = createLocalToolManager();
  const result = await executeLocalCalculation(manager, '5 / 0');

  assert.deepEqual(result, {
    status: 'failure',
    error: { code: 'TOOL_ARGUMENTS_ERROR', message: 'Division by zero is not allowed.', retryable: false },
  });
});

test('local calculator cannot be authorized by the time command', async () => {
  const manager = createLocalToolManager();
  const result = await manager.execute('local.calculate', { expression: '2+2' }, {
    metadata: { command: '/time' },
    authorization: { source: 'explicit-cli-command' },
  });

  assert.equal(result.status, 'failure');
  if (result.status === 'failure') assert.equal(result.error.code, 'TOOL_PERMISSION_ERROR');
});
