import assert from 'node:assert/strict';
import test from 'node:test';
import { AssistantCore } from '../../src/core/assistant-core.js';
import { Session } from '../../src/core/session.js';
import { MockAIProvider } from '../../src/ai/mock-ai-provider.js';
import { ToolManager } from '../../src/tools/tool-manager.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';
import { AssistantCoreAdapter } from '../../src/realtime/assistant-core-adapter.js';
import { EventBus } from '../../src/realtime/event-bus.js';
import { InteractionScheduler } from '../../src/realtime/interaction-scheduler.js';
import { InteractionStream } from '../../src/realtime/interaction-stream.js';
import { MockInteractionSource } from '../../src/realtime/mock-interaction-source.js';
import { RealtimeEngine } from '../../src/realtime/realtime-engine.js';
import { RealtimeError } from '../../src/realtime/realtime-errors.js';
import { assertInteractionTransition } from '../../src/realtime/state-machine.js';
import { ToolManagerAdapter, type ToolObservationSink } from '../../src/realtime/tool-manager-adapter.js';
import type {
  InteractionSourceContext,
  RealtimeEvent,
  RealtimeInteractionRequest,
} from '../../src/realtime/realtime-types.js';
import type { Logger } from '../../src/shared/logger.js';

const silentLogger: Logger = { info() {}, warn() {}, error() {} };

function request(session = new Session()): RealtimeInteractionRequest {
  return { session, input: 'hello' };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}

function sourceContext(signal: AbortSignal): InteractionSourceContext {
  return {
    signal,
    interactionId: 'interaction-1',
    correlationId: 'correlation-1',
    sessionId: 'session-1',
    logger: silentLogger,
  };
}

test('event bus publishes typed events and unsubscribes cleanly', () => {
  const bus = new EventBus<{ value: { readonly number: number } }>();
  const received: number[] = [];
  const unsubscribe = bus.subscribe('value', (event) => received.push(event.number));
  bus.publish('value', { number: 1 });
  unsubscribe();
  bus.publish('value', { number: 2 });
  assert.deepEqual(received, [1]);
  bus.clear();
});

test('interaction stream applies bounded backpressure without dropping events', async () => {
  const stream = new InteractionStream<number>({ capacity: 1 });
  await stream.enqueue(1);
  let accepted = false;
  const pending = stream.enqueue(2).then((value) => { accepted = value; });
  await Promise.resolve();
  assert.equal(accepted, false);
  assert.deepEqual(await stream.next(), { done: false, value: 1 });
  await pending;
  assert.equal(accepted, true);
  assert.deepEqual(await stream.next(), { done: false, value: 2 });
  stream.close();
  assert.deepEqual(await stream.next(), { done: true, value: undefined });
  assert.equal(await stream.enqueue(3), false);
});

test('interaction stream releases a blocked producer when its signal is cancelled', async () => {
  const stream = new InteractionStream<number>({ capacity: 1 });
  const controller = new AbortController();
  await stream.enqueue(1);
  const pending = stream.enqueue(2, controller.signal);
  controller.abort();
  assert.equal(await pending, false);
  stream.close();
});

test('state machine accepts valid transitions and rejects invalid ones', () => {
  assert.doesNotThrow(() => assertInteractionTransition('created', 'running'));
  assert.doesNotThrow(() => assertInteractionTransition('running', 'streaming'));
  assert.throws(
    () => assertInteractionTransition('completed', 'running'),
    (error: unknown) => error instanceof RealtimeError && error.code === 'REALTIME_STATE_ERROR',
  );
});

test('realtime engine emits correlated ordered events and completes once', async () => {
  const engine = new RealtimeEngine({
    source: new MockInteractionSource({ chunks: ['one', 'two'] }),
    logger: silentLogger,
  });
  const publishedDeltas: string[] = [];
  const unsubscribe = engine.events.subscribe('text_delta', (event) => publishedDeltas.push(event.payload.delta));
  const handle = engine.start(request(), { correlationId: 'correlation-1' });
  const eventsPromise = collect(handle.events());
  const result = await handle.result();
  const events = await eventsPromise;
  unsubscribe();

  assert.equal(result.status, 'completed');
  assert.equal(handle.state, 'completed');
  assert.equal(engine.get(handle.id), undefined);
  assert.deepEqual(events.map((event) => event.type), [
    'interaction_admitted',
    'state_changed',
    'interaction_started',
    'state_changed',
    'text_delta',
    'text_delta',
    'interaction_completed',
  ]);
  assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(new Set(events.map((event) => event.interactionId)).size, 1);
  assert.equal(new Set(events.map((event) => event.correlationId)).size, 1);
  assert.equal(events[0]?.correlationId, 'correlation-1');
  assert.deepEqual(publishedDeltas, ['one', 'two']);
});

test('terminal completion reservation wins a deterministic cancellation race', async () => {
  const engine = new RealtimeEngine({
    source: new MockInteractionSource({ chunks: ['done'] }),
    logger: silentLogger,
  });
  let cancellationAttempt: boolean | undefined;
  const unsubscribe = engine.events.subscribe('interaction_completed', (event) => {
    cancellationAttempt = engine.cancel(event.interactionId, 'race after completion event');
  });
  const handle = engine.start(request());
  const [events, result] = await Promise.all([collect(handle.events()), handle.result()]);
  unsubscribe();

  assert.equal(cancellationAttempt, false);
  assert.equal(result.status, 'completed');
  assert.equal(handle.cancel('late cancellation'), false);
  assert.equal(events.filter((event) => event.type === 'interaction_completed').length, 1);
  assert.equal(events.some((event) => event.type === 'interaction_cancelled'), false);
  assert.equal(events.some((event) => event.type === 'interaction_failed'), false);
});

test('terminal completion remains stable when timeout fires during terminal backpressure', async () => {
  const engine = new RealtimeEngine({
    source: new MockInteractionSource({ chunks: ['buffered'] }),
    streamCapacity: 1,
    defaultTimeoutMs: 20,
    logger: silentLogger,
  });
  const handle = engine.start(request());
  const iterator = handle.events()[Symbol.asyncIterator]();
  const events: RealtimeEvent[] = [];

  for (let index = 0; index < 4; index += 1) {
    const next = await iterator.next();
    assert.equal(next.done, false);
    if (!next.done) events.push(next.value);
  }
  assert.deepEqual(events.map((event) => event.type), [
    'interaction_admitted',
    'state_changed',
    'interaction_started',
    'state_changed',
  ]);

  await new Promise((resolve) => setTimeout(resolve, 40));
  let next = await iterator.next();
  while (!next.done) {
    events.push(next.value);
    next = await iterator.next();
  }
  const result = await handle.result();

  assert.equal(result.status, 'completed');
  assert.equal(handle.cancel('late cancellation'), false);
  assert.deepEqual(events.map((event) => event.type).slice(-2), ['text_delta', 'interaction_completed']);
  assert.equal(events.some((event) => event.type === 'interaction_failed'), false);
  assert.equal(events.some((event) => event.type === 'interaction_cancelled'), false);
});

test('admission is an event and cancellation before start is terminal', async () => {
  const engine = new RealtimeEngine({
    source: new MockInteractionSource({ chunks: ['never'], delayMs: 20 }),
    logger: silentLogger,
  });
  const handle = engine.start(request());
  assert.equal(handle.cancel('cancelled before start'), true);
  assert.equal(handle.cancel('duplicate cancellation'), false);
  const events = await collect(handle.events());
  const result = await handle.result();
  assert.equal(result.status, 'cancelled');
  assert.deepEqual(events.map((event) => event.type), [
    'interaction_admitted',
    'state_changed',
    'interaction_cancelled',
  ]);
  assert.equal(events.some((event) => event.type === 'interaction_started'), false);
});

test('realtime engine cancels during streaming and emits no later events', async () => {
  const engine = new RealtimeEngine({
    source: new MockInteractionSource({ chunks: ['first', 'second'], delayMs: 15 }),
    logger: silentLogger,
  });
  const handle = engine.start(request());
  const iterator = handle.events()[Symbol.asyncIterator]();
  const events: RealtimeEvent[] = [];
  let next = await iterator.next();
  while (!next.done) {
    events.push(next.value);
    if (next.value.type === 'text_delta') {
      assert.equal(handle.cancel('user interruption'), true);
      break;
    }
    next = await iterator.next();
  }
  while (!(next = await iterator.next()).done) events.push(next.value);
  const result = await handle.result();
  assert.equal(result.status, 'cancelled');
  assert.deepEqual(events.map((event) => event.type).slice(-3), [
    'text_delta',
    'state_changed',
    'interaction_cancelled',
  ]);
});

test('realtime engine maps timeout and source failures to terminal errors', async () => {
  const timeoutEngine = new RealtimeEngine({
    source: new MockInteractionSource({ chunks: ['late'], delayMs: 30 }),
    defaultTimeoutMs: 5,
    logger: silentLogger,
  });
  const timeoutHandle = timeoutEngine.start(request());
  const timeoutEvents = collect(timeoutHandle.events());
  const timeoutResult = await timeoutHandle.result();
  await timeoutEvents;
  assert.equal(timeoutResult.status, 'failed');
  if (timeoutResult.status === 'failed') assert.equal(timeoutResult.code, 'REALTIME_TIMEOUT_ERROR');

  const failureEngine = new RealtimeEngine({
    source: new MockInteractionSource({ failure: new Error('private source detail') }),
    logger: silentLogger,
  });
  const failureHandle = failureEngine.start(request());
  const failureEvents = await collect(failureHandle.events());
  const failureResult = await failureHandle.result();
  assert.equal(failureResult.status, 'failed');
  if (failureResult.status === 'failed') {
    assert.equal(failureResult.code, 'REALTIME_EXECUTION_ERROR');
    assert.equal(failureResult.message.includes('private source detail'), false);
  }
  assert.equal(failureEvents.at(-1)?.type, 'interaction_failed');
});

test('realtime engine classifies invalid source output as a stream error', async () => {
  const engine = new RealtimeEngine({
    source: {
      async *run() {
        yield { type: 'unexpected' } as never;
      },
    },
    logger: silentLogger,
  });
  const handle = engine.start(request());
  await collect(handle.events());
  const result = await handle.result();
  assert.equal(result.status, 'failed');
  if (result.status === 'failed') assert.equal(result.code, 'REALTIME_STREAM_ERROR');
});

test('scheduler rejects per-session and global concurrency limits deterministically', () => {
  const scheduler = new InteractionScheduler({ maxGlobalInteractions: 2, maxInteractionsPerSession: 1 });
  scheduler.admit('one', 'session-one');
  assert.throws(
    () => scheduler.admit('two', 'session-one'),
    (error: unknown) => error instanceof RealtimeError && error.code === 'REALTIME_CONCURRENCY_ERROR',
  );
  scheduler.admit('two', 'session-two');
  assert.throws(
    () => scheduler.admit('three', 'session-three'),
    (error: unknown) => error instanceof RealtimeError && error.code === 'REALTIME_CONCURRENCY_ERROR',
  );
  assert.equal(scheduler.release('one'), true);
  assert.equal(scheduler.release('one'), false);
  assert.equal(scheduler.activeCount, 1);
});

test('realtime engine rejects interactions when configured limits are reached', async () => {
  const engine = new RealtimeEngine({
    source: new MockInteractionSource({ chunks: ['done'], delayMs: 15 }),
    maxGlobalInteractions: 2,
    maxInteractionsPerSession: 1,
    logger: silentLogger,
  });
  const first = engine.start(request(new Session('session-one')));
  assert.throws(
    () => engine.start(request(new Session('session-one'))),
    (error: unknown) => error instanceof RealtimeError && error.code === 'REALTIME_CONCURRENCY_ERROR',
  );
  const second = engine.start(request(new Session('session-two')));
  assert.throws(
    () => engine.start(request(new Session('session-three'))),
    (error: unknown) => error instanceof RealtimeError && error.code === 'REALTIME_CONCURRENCY_ERROR',
  );
  await Promise.all([collect(first.events()), collect(second.events()), first.result(), second.result()]);
});

test('assistant core adapter preserves core responsibility and provides a source stream', async () => {
  const adapter = new AssistantCoreAdapter(new AssistantCore({
    provider: new MockAIProvider({ responseText: 'from core' }),
  }));
  const outputs = await collect(adapter.run(request(), sourceContext(new AbortController().signal)));
  assert.equal(outputs[0]?.type, 'text_delta');
  assert.equal(outputs[1]?.type, 'completed');
});

test('tool manager adapter emits observation events and propagates cancellation', async () => {
  const registry = new ToolRegistry();
  registry.register({
    id: 'test.wait',
    name: 'Wait',
    description: 'Waits until cancelled.',
    risk: 'safe',
    argumentSchema: { type: 'object', properties: {} },
    execute: async (_argumentsValue, context) => new Promise((resolve) => {
      context.signal.addEventListener('abort', () => resolve({ status: 'success', value: 'late' }), { once: true });
    }),
  });
  const manager = new ToolManager({
    registry,
    authorizer: { authorize: () => ({ allowed: true }) },
    logger: silentLogger,
  });
  const observations: string[] = [];
  const sink: ToolObservationSink = {
    toolStarted: (toolId) => observations.push('started:' + toolId),
    toolCompleted: (toolId, result) => observations.push(result.status + ':' + toolId),
  };
  const adapter = new ToolManagerAdapter(manager, sink);
  const controller = new AbortController();
  const operation = adapter.execute('test.wait', {}, sourceContext(controller.signal));
  controller.abort();
  const result = await operation;
  assert.equal(result.status, 'failure');
  if (result.status === 'failure') assert.equal(result.error.code, 'TOOL_CANCELLATION_ERROR');
  assert.deepEqual(observations, ['started:test.wait', 'failure:test.wait']);
});

test('realtime runtime never interprets arbitrary text as a system operation', async () => {
  const engine = new RealtimeEngine({
    source: new MockInteractionSource({ chunks: ['PowerShell -Command dangerous-action'] }),
    logger: silentLogger,
  });
  const handle = engine.start(request());
  const events = await collect(handle.events());
  const result = await handle.result();
  assert.equal(result.status, 'completed');
  assert.equal(events.filter((event) => event.type === 'tool_started').length, 0);
  assert.equal(events.find((event) => event.type === 'text_delta')?.payload.delta, 'PowerShell -Command dangerous-action');
});
