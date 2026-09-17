import assert from 'node:assert/strict';
import test from 'node:test';
import { ToolError } from '../../src/tools/errors.js';
import { ToolManager } from '../../src/tools/tool-manager.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';
import { validateToolArguments } from '../../src/tools/validation.js';
import type { Tool, ToolArgumentSchema, ToolAuthorizer } from '../../src/tools/tool-types.js';

const schema: ToolArgumentSchema = {
  type: 'object',
  properties: {
    text: { type: 'string', required: true, minLength: 1 },
    count: { type: 'number', minimum: 1 },
  },
};

function echoTool(onExecute: () => void = () => {}): Tool<{ text: string }, string> {
  return {
    id: 'test.echo',
    name: 'Echo',
    description: 'Returns the provided text.',
    risk: 'safe',
    argumentSchema: schema,
    execute: async (argumentsValue) => {
      onExecute();
      return { status: 'success', value: argumentsValue.text };
    },
  };
}

const allowAll: ToolAuthorizer = {
  authorize: () => ({
    allowed: true,
    authorization: { source: 'unit-test' },
  }),
};

test('tool registry registers, finds, lists and unregisters tools', () => {
  const registry = new ToolRegistry();
  const tool = echoTool();
  registry.register(tool);
  assert.equal(registry.get(tool.id), tool);
  assert.deepEqual(registry.list(), [tool]);
  assert.equal(registry.unregister(tool.id), true);
  assert.equal(registry.get(tool.id), undefined);
  assert.equal(registry.unregister(tool.id), false);
});

test('tool registry rejects duplicate and invalid tools', () => {
  const registry = new ToolRegistry();
  registry.register(echoTool());
  assert.throws(() => registry.register(echoTool()), (error: unknown) =>
    error instanceof ToolError && error.code === 'TOOL_CONFIGURATION_ERROR');
  assert.throws(() => registry.register({
    id: '',
    name: 'Invalid',
    description: 'Invalid',
    risk: 'safe',
    argumentSchema: schema,
    execute: async () => ({ status: 'success', value: undefined }),
  }), (error: unknown) => error instanceof ToolError && error.code === 'TOOL_CONFIGURATION_ERROR');
  assert.throws(() => registry.register({
    id: 42 as unknown as string,
    name: 'Invalid',
    description: 'Invalid',
    risk: 'safe',
    argumentSchema: schema,
    execute: async () => ({ status: 'success', value: undefined }),
  }), (error: unknown) => error instanceof ToolError && error.code === 'TOOL_CONFIGURATION_ERROR');
});

test('argument validation rejects malformed, missing, unknown, typed and invalid values', () => {
  assert.equal(validateToolArguments(schema, { text: 'ok', count: 2 }).valid, true);
  assert.equal(validateToolArguments(schema, []).valid, false);
  assert.equal(validateToolArguments(schema, {}).valid, false);
  assert.equal(validateToolArguments(schema, { text: 'ok', extra: true }).valid, false);
  assert.equal(validateToolArguments(schema, { text: 1 }).valid, false);
  assert.equal(validateToolArguments(schema, { text: '' }).valid, false);
  assert.equal(validateToolArguments(schema, { text: 'ok', count: 0 }).valid, false);
});

test('tool manager executes an authorized tool and normalizes its result', async () => {
  const registry = new ToolRegistry();
  registry.register(echoTool());
  const manager = new ToolManager({ registry, authorizer: allowAll });
  const result = await manager.execute<string>('test.echo', { text: 'hello' });
  assert.deepEqual(result, { status: 'success', value: 'hello' });
});

test('tool manager reports missing, invalid and denied executions', async () => {
  const registry = new ToolRegistry();
  registry.register(echoTool());
  const manager = new ToolManager({
    registry,
    authorizer: { authorize: () => ({ allowed: false, reason: 'User approval required.' }) },
  });

  const missing = await manager.execute('missing', {});
  assert.equal(missing.status, 'failure');
  if (missing.status === 'failure') assert.equal(missing.error.code, 'TOOL_NOT_FOUND_ERROR');

  const invalid = await manager.execute('test.echo', { unknown: 'value' });
  assert.equal(invalid.status, 'failure');
  if (invalid.status === 'failure') assert.equal(invalid.error.code, 'TOOL_ARGUMENTS_ERROR');

  const denied = await manager.execute('test.echo', { text: 'secret' });
  assert.equal(denied.status, 'failure');
  if (denied.status === 'failure') assert.equal(denied.error.code, 'TOOL_PERMISSION_ERROR');
});

test('tool manager reports unavailable and thrown execution errors without leaking details', async () => {
  const registry = new ToolRegistry();
  registry.register({ ...echoTool(), isAvailable: () => false });
  const manager = new ToolManager({ registry, authorizer: allowAll });
  const unavailable = await manager.execute('test.echo', { text: 'hello' });
  assert.equal(unavailable.status, 'failure');
  if (unavailable.status === 'failure') assert.equal(unavailable.error.code, 'TOOL_UNAVAILABLE_ERROR');

  const throwingRegistry = new ToolRegistry();
  throwingRegistry.register({
    ...echoTool(),
    execute: async () => { throw new Error('private implementation detail'); },
  });
  const throwingManager = new ToolManager({ registry: throwingRegistry, authorizer: allowAll });
  const failed = await throwingManager.execute('test.echo', { text: 'hello' });
  assert.equal(failed.status, 'failure');
  if (failed.status === 'failure') {
    assert.equal(failed.error.code, 'TOOL_EXECUTION_ERROR');
    assert.equal(failed.error.message.includes('private implementation detail'), false);
  }
});

test('tool manager preserves controlled failures and rejects malformed results', async () => {
  const registry = new ToolRegistry();
  registry.register({
    ...echoTool(),
    execute: async () => ({
      status: 'failure',
      error: { code: 'TOOL_EXECUTION_ERROR', message: 'Expected controlled failure.', retryable: false },
    }),
  });
  const manager = new ToolManager({ registry, authorizer: allowAll });
  const controlled = await manager.execute('test.echo', { text: 'hello' });
  assert.equal(controlled.status, 'failure');
  if (controlled.status === 'failure') assert.equal(controlled.error.code, 'TOOL_EXECUTION_ERROR');

  const malformedRegistry = new ToolRegistry();
  malformedRegistry.register({
    ...echoTool(),
    execute: async () => undefined as never,
  });
  const malformedManager = new ToolManager({ registry: malformedRegistry, authorizer: allowAll });
  const malformed = await malformedManager.execute('test.echo', { text: 'hello' });
  assert.equal(malformed.status, 'internal_error');
  if (malformed.status === 'internal_error') assert.equal(malformed.error.code, 'TOOL_INTERNAL_ERROR');
});

test('tool manager propagates authorization, session and correlation context', async () => {
  let observed: { sessionId?: string; correlationId?: string; source?: string } = {};
  const registry = new ToolRegistry();
  registry.register({
    ...echoTool(),
    execute: async (_argumentsValue, context) => {
      observed = {
        sessionId: context.sessionId,
        correlationId: context.correlationId,
        source: context.authorization?.source,
      };
      return { status: 'success', value: 'ok' };
    },
  });
  const manager = new ToolManager({ registry, authorizer: allowAll });
  await manager.execute('test.echo', { text: 'hello' }, {
    sessionId: 'session-1',
    correlationId: 'request-1',
  });
  assert.deepEqual(observed, {
    sessionId: 'session-1',
    correlationId: 'request-1',
    source: 'unit-test',
  });
});

test('tool manager turns cooperative cancellation and timeout into typed failures', async () => {
  const registry = new ToolRegistry();
  registry.register({
    ...echoTool(),
    execute: async (_argumentsValue, context) => new Promise((resolve) => {
      context.signal.addEventListener('abort', () => resolve({ status: 'success', value: 'late' }), { once: true });
    }),
  });
  const manager = new ToolManager({ registry, authorizer: allowAll });

  const cancelled = new AbortController();
  const cancellation = manager.execute('test.echo', { text: 'hello' }, { signal: cancelled.signal });
  cancelled.abort();
  const cancellationResult = await cancellation;
  assert.equal(cancellationResult.status, 'failure');
  if (cancellationResult.status === 'failure') {
    assert.equal(cancellationResult.error.code, 'TOOL_CANCELLATION_ERROR');
  }

  const timeoutResult = await manager.execute('test.echo', { text: 'hello' }, { timeoutMs: 5 });
  assert.equal(timeoutResult.status, 'failure');
  if (timeoutResult.status === 'failure') assert.equal(timeoutResult.error.code, 'TOOL_TIMEOUT_ERROR');
});

test('untrusted model text is rejected and never becomes system execution', async () => {
  let executed = false;
  const registry = new ToolRegistry();
  registry.register(echoTool(() => { executed = true; }));
  const manager = new ToolManager({ registry, authorizer: allowAll });
  const result = await manager.execute('test.echo', {
    command: 'PowerShell -Command Remove-Item important-file',
  });
  assert.equal(result.status, 'failure');
  assert.equal(executed, false);
});
