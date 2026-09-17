import assert from 'node:assert/strict';
import test from 'node:test';
import { Session } from '../../src/core/session.js';
import { MockInteractionSource } from '../../src/realtime/mock-interaction-source.js';
import { RealtimeEngine } from '../../src/realtime/realtime-engine.js';
import {
  CANONICAL_AUDIO_FORMAT,
  MockAudioInputProvider,
  MockAudioOutputProvider,
  MockSTTProvider,
  MockTTSProvider,
  VoiceError,
  VoiceService,
  type AudioInputProvider,
  type AudioChunk,
  type VoiceEvent,
} from '../../src/voice/index.js';
import type { Logger } from '../../src/shared/logger.js';

const silentLogger: Logger = { info() {}, warn() {}, error() {} };

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}

function voiceService(overrides: Partial<ConstructorParameters<typeof VoiceService>[0]> = {}): VoiceService {
  return new VoiceService({
    input: new MockAudioInputProvider(),
    stt: new MockSTTProvider(),
    tts: new MockTTSProvider(),
    output: new MockAudioOutputProvider(),
    logger: silentLogger,
    ...overrides,
  });
}

test('voice transcription emits partial/final events with correlation and session separation', async () => {
  const service = voiceService();
  const handle = service.startTranscription(
    { sessionId: 'conversation-1' },
    { correlationId: 'voice-correlation-1' },
  );
  const [events, result] = await Promise.all([collect(handle.events()), handle.result()]);

  assert.equal(result.status, 'completed');
  if (result.status === 'completed') assert.equal(result.value.text, 'hello');
  assert.equal(handle.voiceSession.sessionId, 'conversation-1');
  assert.equal(handle.voiceSession.correlationId, 'voice-correlation-1');
  assert.equal(handle.voiceSession.transcriptionState, 'completed');
  assert.equal(events.some((event) => event.type === 'transcription_partial'), true);
  assert.equal(events.find((event) => event.type === 'transcription_completed')?.payload.text, 'hello');
  assert.equal(new Set(events.map((event) => event.correlationId)).size, 1);
  assert.equal(events.at(-1)?.type, 'voice_completed');
});

test('voice service rejects non-canonical input formats without exposing provider details', async () => {
  const invalidInput: AudioInputProvider = {
    name: 'invalid-input',
    async *capture(): AsyncIterable<AudioChunk> {
      yield {
        data: new Uint8Array([1]),
        format: { ...CANONICAL_AUDIO_FORMAT, sampleRateHz: 8000 },
        sequence: 0,
        capturedAt: new Date().toISOString(),
      };
    },
    async stop(): Promise<void> {},
  };
  const service = voiceService({ input: invalidInput });
  const handle = service.startTranscription({ sessionId: 'conversation-1' });
  const [events, result] = await Promise.all([collect(handle.events()), handle.result()]);

  assert.equal(result.status, 'failed');
  if (result.status === 'failed') assert.equal(result.code, 'VOICE_AUDIO_FORMAT_ERROR');
  assert.equal(events.at(-1)?.type, 'voice_failed');
});

test('voice synthesis produces an artifact and stops output during cleanup', async () => {
  const output = new MockAudioOutputProvider();
  const service = voiceService({ output });
  const handle = service.startSynthesis(
    { sessionId: 'conversation-1', text: 'safe response', voice: 'test-voice', language: 'es' },
    { correlationId: 'synthesis-correlation' },
  );
  const [events, result] = await Promise.all([collect(handle.events()), handle.result()]);

  assert.equal(result.status, 'completed');
  if (result.status === 'completed') assert.equal(result.value.data.byteLength, 4);
  assert.equal(output.played.length, 1);
  assert.equal(output.stopCount, 1);
  assert.equal(events.at(-1)?.type, 'voice_completed');
  assert.equal(events.some((event) => event.type === 'synthesis_completed'), true);
  assert.equal(events.some((event) => event.type === 'audio_output_started'), true);
});

test('voice operation cancellation propagates during capture and cleans input', async () => {
  const input = new MockAudioInputProvider({ chunks: [new Uint8Array([1])], delayMs: 50 });
  const service = voiceService({ input });
  const handle = service.startTranscription({ sessionId: 'conversation-1' });
  const iterator = handle.events()[Symbol.asyncIterator]();
  let next = await iterator.next();
  while (!next.done && next.value.type !== 'audio_input_started') next = await iterator.next();
  assert.equal(handle.cancel('user stopped capture'), true);
  const events: VoiceEvent[] = [];
  while (!(next = await iterator.next()).done) events.push(next.value);
  const result = await handle.result();

  assert.equal(result.status, 'cancelled');
  assert.equal(input.stopCount, 1);
  assert.equal(events.at(-1)?.type, 'voice_cancelled');
});

test('voice operation cancellation propagates during STT', async () => {
  const service = voiceService({ stt: new MockSTTProvider({ delayMs: 50 }) });
  const handle = service.startTranscription({ sessionId: 'conversation-1' });
  const iterator = handle.events()[Symbol.asyncIterator]();
  let next = await iterator.next();
  while (!next.done && next.value.type !== 'transcription_started') next = await iterator.next();
  assert.equal(handle.cancel('user stopped transcription'), true);
  const result = await handle.result();
  await collect(handle.events());
  assert.equal(result.status, 'cancelled');
});

test('voice operation cancellation propagates during TTS and playback', async () => {
  const ttsService = voiceService({ tts: new MockTTSProvider({ delayMs: 50 }) });
  const ttsHandle = ttsService.startSynthesis({ sessionId: 'conversation-1', text: 'cancel me' });
  const ttsIterator = ttsHandle.events()[Symbol.asyncIterator]();
  let next = await ttsIterator.next();
  while (!next.done && next.value.type !== 'synthesis_started') next = await ttsIterator.next();
  assert.equal(ttsHandle.cancel('user stopped synthesis'), true);
  assert.equal((await ttsHandle.result()).status, 'cancelled');
  await collect(ttsHandle.events());

  const output = new MockAudioOutputProvider({ delayMs: 50 });
  const outputService = voiceService({ output });
  const outputHandle = outputService.startSynthesis({ sessionId: 'conversation-1', text: 'cancel playback' });
  const outputIterator = outputHandle.events()[Symbol.asyncIterator]();
  next = await outputIterator.next();
  while (!next.done && next.value.type !== 'audio_output_started') next = await outputIterator.next();
  assert.equal(outputHandle.cancel('user stopped playback'), true);
  assert.equal((await outputHandle.result()).status, 'cancelled');
  await collect(outputHandle.events());
  assert.equal(output.stopCount, 1);
});

test('voice service applies stage timeouts and typed errors', async () => {
  const captureService = voiceService({ input: new MockAudioInputProvider({ delayMs: 30 }) });
  const captureHandle = captureService.startTranscription({ sessionId: 'conversation-1' }, { captureTimeoutMs: 5 });
  const captureResult = await captureHandle.result();
  await collect(captureHandle.events());
  assert.equal(captureResult.status, 'failed');
  if (captureResult.status === 'failed') assert.equal(captureResult.code, 'VOICE_TIMEOUT_ERROR');

  const ttsService = voiceService({ tts: new MockTTSProvider({ delayMs: 30 }) });
  const ttsHandle = ttsService.startSynthesis({ sessionId: 'conversation-1', text: 'timeout' }, { synthesisTimeoutMs: 5 });
  const ttsResult = await ttsHandle.result();
  await collect(ttsHandle.events());
  assert.equal(ttsResult.status, 'failed');
  if (ttsResult.status === 'failed') assert.equal(ttsResult.code, 'VOICE_TIMEOUT_ERROR');

  const outputService = voiceService({ output: new MockAudioOutputProvider({ delayMs: 30 }) });
  const outputHandle = outputService.startSynthesis({ sessionId: 'conversation-1', text: 'timeout playback' }, { playbackTimeoutMs: 5 });
  const outputResult = await outputHandle.result();
  await collect(outputHandle.events());
  assert.equal(outputResult.status, 'failed');
  if (outputResult.status === 'failed') assert.equal(outputResult.code, 'VOICE_TIMEOUT_ERROR');
});

test('voice providers normalize failures and logs contain no complete transcript or audio', async () => {
  const logLines: string[] = [];
  const logger: Logger = {
    info: (_message, context) => logLines.push(JSON.stringify(context)),
    warn: (_message, context) => logLines.push(JSON.stringify(context)),
    error: (_message, context) => logLines.push(JSON.stringify(context)),
  };
  const service = voiceService({
    stt: new MockSTTProvider({ failure: new Error('secret transcript detail') }),
    logger,
  });
  const handle = service.startTranscription({ sessionId: 'conversation-1' });
  const result = await handle.result();
  await collect(handle.events());

  assert.equal(result.status, 'failed');
  if (result.status === 'failed') {
    assert.equal(result.code, 'VOICE_STT_ERROR');
    assert.equal(result.message.includes('secret transcript detail'), false);
  }
  assert.equal(logLines.join('\n').includes('secret transcript detail'), false);
  assert.equal(logLines.join('\n').includes('hello'), false);
});

test('voice transcription integrates explicitly with RealtimeEngine using the same correlation ID', async () => {
  const service = voiceService({ stt: new MockSTTProvider({ partials: [], finalText: 'run this text' }) });
  const voiceHandle = service.startTranscription(
    { sessionId: 'conversation-1' },
    { correlationId: 'shared-correlation' },
  );
  const transcription = await voiceHandle.result();
  await collect(voiceHandle.events());
  assert.equal(transcription.status, 'completed');
  if (transcription.status !== 'completed') return;

  const realtime = new RealtimeEngine({
    source: new MockInteractionSource({ chunks: [transcription.value.text] }),
    logger: silentLogger,
  });
  const interaction = realtime.start(
    { session: new Session('conversation-1'), input: transcription.value.text },
    { correlationId: voiceHandle.correlationId },
  );
  const [events, result] = await Promise.all([collect(interaction.events()), interaction.result()]);
  assert.equal(result.status, 'completed');
  assert.equal(new Set(events.map((event) => event.correlationId)).size, 1);
  assert.equal(events[0]?.correlationId, 'shared-correlation');
});

test('voice terminal completion is idempotent against a cancellation race', async () => {
  const service = voiceService();
  let cancellationAttempt: boolean | undefined;
  const handle = service.startSynthesis({ sessionId: 'conversation-1', text: 'done' });
  const unsubscribe = service.events.subscribe('voice_completed', (event) => {
    cancellationAttempt = handle.cancel('late cancellation');
    assert.equal(event.payload.state, 'completed');
  });
  const [events, result] = await Promise.all([collect(handle.events()), handle.result()]);
  unsubscribe();

  assert.equal(cancellationAttempt, false);
  assert.equal(result.status, 'completed');
  assert.equal(handle.cancel('late cancellation'), false);
  assert.equal(events.filter((event) => event.type === 'voice_completed').length, 1);
  assert.equal(events.some((event) => event.type === 'voice_cancelled'), false);
});

test('voice service validates configuration and exposes typed errors', () => {
  assert.throws(
    () => voiceService({ defaultTimeoutMs: 0 }),
    (error: unknown) => error instanceof VoiceError && error.code === 'VOICE_CONFIGURATION_ERROR',
  );
  assert.throws(
    () => voiceService().startTranscription({ sessionId: ' ' }),
    (error: unknown) => error instanceof VoiceError && error.code === 'VOICE_CONFIGURATION_ERROR',
  );
  assert.throws(
    () => voiceService().startSynthesis({ sessionId: 'conversation-1', text: ' ' }),
    (error: unknown) => error instanceof VoiceError && error.code === 'VOICE_CONFIGURATION_ERROR',
  );
});

test('voice service removes caller listeners and clears completed stage timers', async () => {
  const listenerCalls: string[] = [];
  const signal = {
    aborted: false,
    addEventListener(): void { listenerCalls.push('add'); },
    removeEventListener(): void { listenerCalls.push('remove'); },
  } as unknown as AbortSignal;
  const service = voiceService();
  const handle = service.startTranscription(
    { sessionId: 'conversation-1' },
    { signal, captureTimeoutMs: 50 },
  );

  const result = await handle.result();
  assert.equal(result.status, 'completed');
  await new Promise((resolve) => setTimeout(resolve, 75));
  assert.deepEqual(listenerCalls, ['add', 'remove']);
  assert.equal(handle.state, 'completed');
});
