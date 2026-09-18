import assert from 'node:assert/strict';
import test from 'node:test';
import { Session } from '../../src/core/session.js';
import { RealtimeEngine } from '../../src/realtime/realtime-engine.js';
import { MockInteractionSource } from '../../src/realtime/mock-interaction-source.js';
import type { Logger } from '../../src/shared/logger.js';
import {
  BoundedAsyncQueue,
  CANONICAL_AUDIO_FORMAT,
  MockAudioInputProvider,
  MockAudioOutputProvider,
  MockSTTProvider,
  MockStreamingAudioInputProvider,
  MockStreamingAudioOutputProvider,
  MockStreamingSTTProvider,
  MockStreamingTTSProvider,
  MockTTSProvider,
  VoiceConcurrencyCoordinator,
  VoiceError,
  VoiceService,
} from '../../src/voice/index.js';

const silentLogger: Logger = { info() {}, warn() {}, error() {} };

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}

function streamingService(overrides: Partial<NonNullable<ConstructorParameters<typeof VoiceService>[0]['streaming']>> = {}): VoiceService {
  return new VoiceService({
    input: new MockAudioInputProvider(),
    stt: new MockSTTProvider(),
    tts: new MockTTSProvider(),
    output: new MockAudioOutputProvider(),
    logger: silentLogger,
    streaming: {
      input: new MockStreamingAudioInputProvider(),
      stt: new MockStreamingSTTProvider(),
      tts: new MockStreamingTTSProvider(),
      output: new MockStreamingAudioOutputProvider(),
      logger: silentLogger,
      ...overrides,
    },
  });
}

test('streaming transcription emits partial/final events with monotonic metadata', async () => {
  const input = new MockStreamingAudioInputProvider({ chunks: [new Uint8Array([1]), new Uint8Array([2])] });
  const service = streamingService({ input });
  const handle = service.startStreamingTranscription(
    { sessionId: 'conversation-1', language: 'es' },
    { correlationId: 'streaming-correlation' },
  );
  const [events, result] = await Promise.all([collect(handle.events()), handle.result()]);

  assert.equal(result.status, 'completed');
  if (result.status === 'completed') assert.equal(result.value.text, 'streamed final');
  assert.equal(input.stopCount, 1);
  assert.equal(handle.voiceSession.mode, 'streaming');
  assert.equal(events.some((event) => event.type === 'transcription_partial'), true);
  assert.equal(events.some((event) => event.type === 'transcription_final'), true);
  assert.equal(new Set(events.map((event) => event.correlationId)).size, 1);
  assert.deepEqual(
    events.map((event) => event.sequence),
    events.map((event) => event.sequence).sort((left, right) => left - right),
  );
  assert.equal(handle.metrics().marks.first_STT_partial !== undefined, true);
});

test('streaming synthesis supports complete text and incremental playback', async () => {
  const output = new MockStreamingAudioOutputProvider();
  const service = streamingService({ output });
  const handle = service.startStreamingSynthesis({ sessionId: 'conversation-1', text: 'hello stream' });
  const [events, result] = await Promise.all([collect(handle.events()), handle.result()]);

  assert.equal(result.status, 'completed');
  if (result.status === 'completed') assert.equal(result.value.chunkCount, 1);
  assert.equal(output.played.length, 1);
  assert.equal(output.stopCount, 0);
  assert.equal(events.some((event) => event.type === 'tts_chunk_ready'), true);
  assert.equal(events.some((event) => event.type === 'playback_started'), true);
  assert.equal(events.at(-1)?.type, 'voice_completed');
});

test('streaming synthesis accepts text fragments until explicit endInput', async () => {
  const service = streamingService();
  const handle = service.startStreamingSynthesis({ sessionId: 'conversation-1' });
  await handle.pushText('hello ');
  await handle.pushText('world');
  await handle.endInput();
  const result = await handle.result();

  assert.equal(result.status, 'completed');
  if (result.status === 'completed') assert.equal(result.value.chunkCount, 2);
});

test('bounded audio queue applies backpressure and cancellation without drops', async () => {
  const queue = new BoundedAsyncQueue<number>(1);
  assert.equal(await queue.enqueue(1), true);
  let accepted: boolean | undefined;
  const pending = queue.enqueue(2).then((value) => { accepted = value; });
  await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(accepted, undefined);
  assert.deepEqual(await queue.next(), { done: false, value: 1 });
  await pending;
  assert.equal(accepted, true);
  assert.deepEqual(await queue.next(), { done: false, value: 2 });

  const controller = new AbortController();
  await queue.enqueue(3);
  const blocked = queue.enqueue(4, controller.signal);
  controller.abort();
  assert.equal(await blocked, false);
  queue.close();
});

test('streaming buffer policies validate as milliseconds, not timeouts', () => {
  for (const name of ['captureChunkDurationMs', 'playbackBufferMs', 'maxPendingMs'] as const) {
    assert.throws(
      () => streamingService({ [name]: 0 }),
      (error: unknown) => error instanceof VoiceError && error.code === 'VOICE_CONFIGURATION_ERROR',
    );
  }

  const service = streamingService();
  assert.throws(
    () => service.startStreamingSynthesis(
      { sessionId: 'conversation-1', text: 'invalid buffer policy' },
      { playbackBufferMs: Number.NaN },
    ),
    (error: unknown) => error instanceof VoiceError && error.code === 'VOICE_CONFIGURATION_ERROR',
  );
});

test('interruption during capture stops input and reports its cause', async () => {
  const input = new MockStreamingAudioInputProvider({ delayMs: 50 });
  const service = streamingService({ input });
  const handle = service.startStreamingTranscription({ sessionId: 'conversation-1' });
  const iterator = handle.events()[Symbol.asyncIterator]();
  let next = await iterator.next();
  while (!next.done && next.value.type !== 'audio_input_started') next = await iterator.next();

  assert.equal(handle.interrupt('barge-in'), true);
  const result = await handle.result();
  const events = await collect(handle.events());

  assert.equal(result.status, 'cancelled');
  if (result.status === 'cancelled') assert.equal(result.reasonCode, 'interrupted');
  assert.equal(input.stopCount, 1);
  assert.equal(handle.metrics().marks.interruption_effective_capture_stop !== undefined, true);
  assert.equal(handle.metrics().durationsMs.interruption_latency, undefined);
  assert.equal(events.some((event) => event.type === 'interruption_completed'), true);
});

test('interruption during playback stops immediately and discards remaining chunks', async () => {
  const output = new MockStreamingAudioOutputProvider({ delayMs: 50 });
  const service = streamingService({ output });
  const handle = service.startStreamingSynthesis({ sessionId: 'conversation-1', text: 'first' });
  const iterator = handle.events()[Symbol.asyncIterator]();
  let next = await iterator.next();
  while (!next.done && next.value.type !== 'playback_started') next = await iterator.next();

  assert.equal(handle.interrupt('user barge-in'), true);
  const result = await handle.result();
  await collect(handle.events());

  assert.equal(result.status, 'cancelled');
  if (result.status === 'cancelled') assert.equal(result.reasonCode, 'interrupted');
  assert.equal(output.stopCount, 1);
  assert.equal(handle.metrics().marks.interruption_effective_playback_stop !== undefined, true);
  assert.equal(handle.metrics().durationsMs.interruption_latency !== undefined, true);
});

test('explicit supersede releases the old session before the replacement starts', async () => {
  const coordinator = new VoiceConcurrencyCoordinator();
  const output = new MockStreamingAudioOutputProvider({ delayMs: 10 });
  const service = streamingService({ coordinator, output });
  const first = service.startStreamingSynthesis({ sessionId: 'conversation-1', text: 'old response' });
  const firstEvents = collect(first.events());
  const firstIterator = first.events()[Symbol.asyncIterator]();
  let next = await firstIterator.next();
  while (!next.done && next.value.type !== 'playback_started') next = await firstIterator.next();

  const replacement = service.startStreamingSynthesis(
    { sessionId: 'conversation-1', text: 'new response' },
    { supersede: true },
  );
  const [firstResult, replacementResult] = await Promise.all([first.result(), replacement.result()]);
  await Promise.all([firstEvents, collect(replacement.events())]);

  assert.equal(firstResult.status, 'cancelled');
  if (firstResult.status === 'cancelled') assert.equal(firstResult.reasonCode, 'superseded');
  assert.equal(replacementResult.status, 'completed');
  assert.equal(coordinator.activeSessionCount, 0);
  assert.equal(coordinator.activePlaybackCount, 0);
});

test('active session is rejected when supersede is not explicitly authorized', async () => {
  const service = streamingService({ input: new MockStreamingAudioInputProvider({ delayMs: 30 }) });
  const first = service.startStreamingTranscription({ sessionId: 'conversation-1' });
  const second = service.startStreamingTranscription({ sessionId: 'conversation-1' });
  const secondResult = await second.result();
  first.cancel('cleanup');
  await first.result();

  assert.equal(secondResult.status, 'failed');
  if (secondResult.status === 'failed') assert.equal(secondResult.code, 'VOICE_CONCURRENCY_ERROR');
});

test('playback is exclusive per device but can be superseded explicitly', async () => {
  const coordinator = new VoiceConcurrencyCoordinator();
  const output = new MockStreamingAudioOutputProvider({ delayMs: 20 });
  const service = streamingService({ coordinator, output });
  const first = service.startStreamingSynthesis({ sessionId: 'conversation-1', text: 'one' });
  const firstIterator = first.events()[Symbol.asyncIterator]();
  let next = await firstIterator.next();
  while (!next.done && next.value.type !== 'playback_started') next = await firstIterator.next();

  const second = service.startStreamingSynthesis(
    { sessionId: 'conversation-2', text: 'two' },
    { supersede: true },
  );
  const [firstResult, secondResult] = await Promise.all([first.result(), second.result()]);
  await Promise.all([collect(first.events()), collect(second.events())]);

  assert.equal(firstResult.status, 'cancelled');
  assert.equal(secondResult.status, 'completed');
  assert.equal(coordinator.activePlaybackCount, 0);
});

test('shutdown propagates to active streaming operations and cleans resources', async () => {
  const controller = new AbortController();
  const input = new MockStreamingAudioInputProvider({ delayMs: 50 });
  const service = streamingService({ input });
  const handle = service.startStreamingTranscription(
    { sessionId: 'conversation-1' },
    { shutdownSignal: controller.signal },
  );
  const iterator = handle.events()[Symbol.asyncIterator]();
  let next = await iterator.next();
  while (!next.done && next.value.type !== 'audio_input_started') next = await iterator.next();
  controller.abort();
  const result = await handle.result();
  for (;;) {
    const current = await iterator.next();
    if (current.done) break;
  }

  assert.equal(result.status, 'cancelled');
  if (result.status === 'cancelled') assert.equal(result.reasonCode, 'shutdown');
  assert.equal(input.stopCount, 1);
});

test('streaming capture timeout is typed and cleans the active input', async () => {
  const input = new MockStreamingAudioInputProvider({ delayMs: 50 });
  const service = streamingService({ input });
  const handle = service.startStreamingTranscription(
    { sessionId: 'conversation-1' },
    { captureTimeoutMs: 5 },
  );
  const result = await handle.result();
  await collect(handle.events());

  assert.equal(result.status, 'failed');
  if (result.status === 'failed') assert.equal(result.code, 'VOICE_TIMEOUT_ERROR');
  assert.equal(input.stopCount, 1);
});

test('streaming provider failures are categorized without leaking details', async () => {
  const output = new MockStreamingAudioOutputProvider({ failure: new Error('private output detail') });
  const service = streamingService({ output });
  const handle = service.startStreamingSynthesis({ sessionId: 'conversation-1', text: 'failure' });
  const result = await handle.result();
  await collect(handle.events());

  assert.equal(result.status, 'failed');
  if (result.status === 'failed') {
    assert.equal(result.code, 'VOICE_OUTPUT_ERROR');
    assert.equal(result.message.includes('private output detail'), false);
  }
});

test('streaming services preserve explicit integration with RealtimeEngine', async () => {
  const service = streamingService({
    stt: new MockStreamingSTTProvider({ finalText: 'explicit text' }),
  });
  const voice = service.startStreamingTranscription(
    { sessionId: 'conversation-1' },
    { correlationId: 'shared-streaming-correlation' },
  );
  const transcription = await voice.result();
  await collect(voice.events());
  assert.equal(transcription.status, 'completed');
  if (transcription.status !== 'completed') return;

  const realtime = new RealtimeEngine({
    source: new MockInteractionSource({ chunks: [transcription.value.text] }),
    logger: silentLogger,
  });
  const interaction = realtime.start(
    { session: new Session('conversation-1'), input: transcription.value.text },
    { correlationId: voice.correlationId },
  );
  const [events, result] = await Promise.all([collect(interaction.events()), interaction.result()]);
  assert.equal(result.status, 'completed');
  assert.equal(events.every((event) => event.correlationId === 'shared-streaming-correlation'), true);
});

test('streaming service requires explicit streaming providers', () => {
  const service = new VoiceService({
    input: new MockAudioInputProvider(),
    stt: new MockSTTProvider(),
    tts: new MockTTSProvider(),
    output: new MockAudioOutputProvider(),
    logger: silentLogger,
  });
  assert.throws(
    () => service.startStreamingTranscription({ sessionId: 'conversation-1' }),
    (error: unknown) => error instanceof VoiceError && error.code === 'VOICE_CONFIGURATION_ERROR',
  );
  assert.deepEqual(CANONICAL_AUDIO_FORMAT, { encoding: 'pcm_s16le', sampleRateHz: 16000, channels: 1 });
});
