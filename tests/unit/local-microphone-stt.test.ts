import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MockAIProvider } from '../../src/ai/mock-ai-provider.js';
import { AssistantCore } from '../../src/core/assistant-core.js';
import { ConversationRunner } from '../../src/core/conversation-runner.js';
import { PushToTalkController } from '../../src/voice/local/push-to-talk-controller.js';
import { createLocalMicrophoneVoiceService } from '../../src/voice/local/local-voice-service.js';
import { convertFloatInputToPcm16Mono, type CpalRuntime } from '../../src/voice/local/windows-microphone-input-provider.js';
import { SherpaWhisperSTTProvider, type SherpaRuntime } from '../../src/voice/local/sherpa-whisper-stt-provider.js';
import { resolveWhisperTinyModelPaths, WHISPER_TINY_MODEL } from '../../src/voice/local/whisper-tiny-model.js';
import { VoiceConversationOrchestrator, type VoiceConversationEvent } from '../../src/voice/voice-conversation-orchestrator.js';
import { CANONICAL_AUDIO_FORMAT } from '../../src/voice/voice-types.js';
import { VoiceError } from '../../src/voice/voice-errors.js';

function fakeCpal(samples = new Float32Array(6400).fill(0.25)): CpalRuntime & { readonly counts: { closed: number; started: number } } {
  const counts = { closed: 0, started: 0 };
  const config = {
    channels: () => 2,
    sampleRate: () => 32000,
    sampleFormat: () => ({ value: 'f32' }),
    containsRate: (rate: number) => rate === 32000,
    tryWithSampleRate: (rate: number) => rate === 32000 ? config : null,
    tryWithStandardSampleRate: () => config,
    withMaxSampleRate: () => config,
  };
  const device = {
    defaultInputConfig: () => config,
    supportedInputConfigs: () => [config],
    buildInputStream: (_config: unknown, _format: string, onData: (data: Float32Array) => void) => ({
      play: () => { counts.started += 1; onData(samples); },
      close: () => { counts.closed += 1; },
    }),
    close: () => {},
  };
  const host = { defaultInputDevice: () => device, close: () => {} };
  return { defaultHost: () => host, SampleFormat: { F32: { value: 'f32' } }, counts } as unknown as CpalRuntime & { readonly counts: { closed: number; started: number } };
}

interface FakeInputCallbacks {
  readonly onData: (data: Float32Array) => void;
  readonly onError: (error: { code?: string; operation?: string }) => void;
}

interface LifecycleCpalOptions {
  readonly emitOnPlay?: boolean;
  readonly duringBuild?: () => void;
  readonly throwDeviceSelectionOnce?: boolean;
  readonly throwOnFirstPlay?: boolean;
  readonly errorDuringClose?: boolean;
  readonly deferClose?: boolean;
}

function lifecycleCpal(options: LifecycleCpalOptions = {}): CpalRuntime & {
  readonly state: {
    readonly callbacks: FakeInputCallbacks[];
    readonly closeResolvers: Array<() => void>;
    readonly counts: { hostsOpened: number; hostsClosed: number; devicesClosed: number; streamsBuilt: number; streamsClosed: number; started: number };
  };
} {
  const counts = { hostsOpened: 0, hostsClosed: 0, devicesClosed: 0, streamsBuilt: 0, streamsClosed: 0, started: 0 };
  const callbacks: FakeInputCallbacks[] = [];
  const closeResolvers: Array<() => void> = [];
  const samples = new Float32Array(19200).fill(0.25);
  const config = {
    channels: () => 2,
    sampleRate: () => 32000,
    sampleFormat: () => ({ value: 'f32' }),
    containsRate: (rate: number) => rate === 32000,
    tryWithSampleRate: (rate: number) => rate === 32000 ? config : null,
    tryWithStandardSampleRate: () => config,
    withMaxSampleRate: () => config,
  };
  const runtime = {
    defaultHost: () => {
      const hostNumber = ++counts.hostsOpened;
      return {
        defaultInputDevice: () => {
          if (options.throwDeviceSelectionOnce && hostNumber === 1) {
            throw Object.assign(new Error('native detail must not escape'), { code: 'DEVICE_BUSY', operation: 'defaultInputDevice' });
          }
          return {
            defaultInputConfig: () => config,
            supportedInputConfigs: () => [config],
            buildInputStream: (_inputConfig: unknown, _format: string, onData: FakeInputCallbacks['onData'], onError: FakeInputCallbacks['onError']) => {
              counts.streamsBuilt += 1;
              options.duringBuild?.();
              callbacks.push({ onData, onError });
              const streamNumber = counts.streamsBuilt;
              return {
                play: () => {
                  counts.started += 1;
                  if (options.throwOnFirstPlay && streamNumber === 1) {
                    throw Object.assign(new Error('native detail must not escape'), { code: 'DEVICE_BUSY', operation: 'play' });
                  }
                  if (options.emitOnPlay ?? true) onData(samples);
                },
                close: () => {
                  counts.streamsClosed += 1;
                  if (options.errorDuringClose) onError({ code: 'XRUN', operation: 'inputStream' });
                  if (options.deferClose) return new Promise<void>((resolve) => closeResolvers.push(resolve));
                },
              };
            },
            close: () => { counts.devicesClosed += 1; },
          };
        },
        close: () => { counts.hostsClosed += 1; },
      };
    },
    SampleFormat: { F32: { value: 'f32' } },
    state: { callbacks, closeResolvers, counts },
  };
  return runtime as unknown as CpalRuntime & typeof runtime;
}

async function temporaryModelFiles(): Promise<{ readonly directory: string; readonly paths: { encoder: string; decoder: string; tokens: string } }> {
  const directory = await mkdtemp(join(tmpdir(), 'waifu-local-stt-test-'));
  const paths = { encoder: join(directory, 'encoder.onnx'), decoder: join(directory, 'decoder.onnx'), tokens: join(directory, 'tokens.txt') };
  await Promise.all(Object.values(paths).map((path) => writeFile(path, 'test-model-placeholder')));
  return { directory, paths };
}

test('Whisper Tiny model is pinned to one multilingual offline revision with bounded external files', () => {
  assert.equal(WHISPER_TINY_MODEL.language, 'auto');
  assert.match(WHISPER_TINY_MODEL.revision, /^[a-f0-9]{40}$/u);
  assert.deepEqual(WHISPER_TINY_MODEL.files.map(({ name }) => name), [
    'tiny-encoder.int8.onnx', 'tiny-decoder.int8.onnx', 'tiny-tokens.txt',
  ]);
  assert.ok(WHISPER_TINY_MODEL.files.every(({ sha256, maxBytes }) => /^[a-f0-9]{64}$/u.test(sha256) && maxBytes > 0));
});

test('model paths must be absolute and outside the repository', () => {
  const repository = join(tmpdir(), 'waifu-test-repository');
  assert.throws(() => resolveWhisperTinyModelPaths('relative-models', repository), /absolute external/u);
  assert.throws(() => resolveWhisperTinyModelPaths(join(repository, 'models'), repository), /outside the repository/u);
  assert.equal(resolveWhisperTinyModelPaths(join(tmpdir(), 'waifu-models'), repository).tokens.endsWith('tiny-tokens.txt'), true);
});

test('microphone conversion downmixes, resamples and emits canonical little-endian PCM16', () => {
  const converted = convertFloatInputToPcm16Mono(new Float32Array([0.5, 0.5, -1, -1]), 2, 16000);
  assert.deepEqual(CANONICAL_AUDIO_FORMAT, { encoding: 'pcm_s16le', sampleRateHz: 16000, channels: 1 });
  const view = new DataView(converted.data.buffer);
  assert.equal(view.getInt16(0, true), 16384);
  assert.equal(view.getInt16(2, true), -32768);
  const downsampled = convertFloatInputToPcm16Mono(new Float32Array(96000).fill(0.1), 1, 48000);
  assert.equal(downsampled.data.byteLength / 2, 32000);
});

test('microphone conversion averages interleaved channels without losing a single active channel', () => {
  const pcm16 = (input: Float32Array): number => new DataView(
    convertFloatInputToPcm16Mono(input, 2, 16000).data.buffer,
  ).getInt16(0, true);

  assert.equal(pcm16(new Float32Array([0.5, 0])), 8192, 'left-only signal is retained at the standard downmix level');
  assert.equal(pcm16(new Float32Array([0, 0.5])), 8192, 'right-only signal is retained at the standard downmix level');
  assert.equal(pcm16(new Float32Array([0.5, 0.5])), 16384, 'matching channels retain their original amplitude');
  assert.equal(pcm16(new Float32Array([0.5, -0.5])), 0, 'opposite-polarity channels cancel during an averaging downmix');
});

test('microphone conversion preserves Float32 amplitude and the 48 kHz to 16 kHz sample ratio', () => {
  const values = new Float32Array([
    0, 0,
    0.25, 0.25,
    0.5, 0.5,
    -0.5, -0.5,
    0.9999, 0.9999,
    -1, -1,
  ]);
  const direct = convertFloatInputToPcm16Mono(values, 2, 16000);
  const directView = new DataView(direct.data.buffer);
  assert.deepEqual(Array.from({ length: direct.data.byteLength / 2 }, (_, index) => directView.getInt16(index * 2, true)), [
    0, 8192, 16384, -16384, 32764, -32768,
  ]);

  const resampled = convertFloatInputToPcm16Mono(new Float32Array(48_000 * 2).fill(0.5), 2, 48_000);
  assert.equal(resampled.data.byteLength / 2, 16_000, '48 kHz source frames are decimated at the expected 3:1 ratio');
  assert.equal(new DataView(resampled.data.buffer).getInt16(0, true), 16384, 'resampling does not apply an additional amplitude scale');
});

test('Windows microphone provider exposes bounded capture and a graceful explicit stop', async () => {
  const runtime = fakeCpal();
  const { WindowsMicrophoneInputProvider } = await import('../../src/voice/local/windows-microphone-input-provider.js');
  const microphone = new WindowsMicrophoneInputProvider({ runtime, queueCapacity: 2 });
  const stream = await microphone.startCapture({ signal: new AbortController().signal, correlationId: 'test' });
  const iterator = stream.chunks()[Symbol.asyncIterator]();
  const first = await iterator.next();
  assert.equal(first.done, false);
  assert.equal(first.value?.format.encoding, 'pcm_s16le');
  assert.equal(first.value?.data.byteLength, 3200);
  await microphone.stopCapture();
  assert.equal((await iterator.next()).done, true);
  assert.equal(runtime.counts.closed, 1);
});

test('aborting microphone capture discards queued audio and releases the native stream', async () => {
  const runtime = fakeCpal();
  const { WindowsMicrophoneInputProvider } = await import('../../src/voice/local/windows-microphone-input-provider.js');
  const microphone = new WindowsMicrophoneInputProvider({ runtime, queueCapacity: 2 });
  const controller = new AbortController();
  const stream = await microphone.startCapture({ signal: controller.signal, correlationId: 'cancel-test' });
  controller.abort();
  const iterator = stream.chunks()[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).done, true);
  assert.equal(runtime.counts.closed, 1);
});

test('a normal stop drains the final partial PCM chunk already received from CPAL', async () => {
  const runtime = fakeCpal(new Float32Array(800).fill(0.25));
  const { WindowsMicrophoneInputProvider } = await import('../../src/voice/local/windows-microphone-input-provider.js');
  const microphone = new WindowsMicrophoneInputProvider({ runtime, queueCapacity: 2 });
  const stream = await microphone.startCapture({ signal: new AbortController().signal, correlationId: 'partial-stop' });
  await microphone.stopCapture();
  const iterator = stream.chunks()[Symbol.asyncIterator]();
  const finalChunk = await iterator.next();
  assert.equal(finalChunk.done, false);
  assert.equal(finalChunk.value?.data.byteLength, 400);
  assert.equal((await iterator.next()).done, true);
});

test('microphone readiness waits for real input and the same provider can stop and reopen', async () => {
  const runtime = lifecycleCpal({ emitOnPlay: false });
  const { WindowsMicrophoneInputProvider } = await import('../../src/voice/local/windows-microphone-input-provider.js');
  const lifecycle: Array<{ stage: string; elapsedMs: number }> = [];
  const microphone = new WindowsMicrophoneInputProvider({ runtime, onLifecycle: (event) => lifecycle.push(event) });

  for (let capture = 0; capture < 2; capture += 1) {
    let ready = false;
    const stream = await microphone.startCapture({ signal: new AbortController().signal, correlationId: `reopen-${capture}` });
    const readiness = microphone.waitUntilReady().then(() => { ready = true; });
    assert.equal(ready, false, 'play() alone must not report input readiness');
    runtime.state.callbacks[capture]?.onData(new Float32Array(19200).fill(0.25));
    await readiness;
    assert.equal(ready, true);
    const iterator = stream.chunks()[Symbol.asyncIterator]();
    for (let chunk = 0; chunk < 3; chunk += 1) assert.equal((await iterator.next()).done, false);
    await stream.stop();
    runtime.state.callbacks[capture]?.onData(new Float32Array(19200).fill(0.25));
    runtime.state.callbacks[capture]?.onError({ code: 'XRUN', operation: 'staleCallback' });
    assert.equal((await iterator.next()).done, true, 'callbacks arriving after stop must not revive the queue');
  }

  assert.deepEqual(runtime.state.counts, {
    hostsOpened: 2, hostsClosed: 2, devicesClosed: 2, streamsBuilt: 2, streamsClosed: 2, started: 2,
  });
  assert.deepEqual(lifecycle.slice(0, 6).map(({ stage }) => stage), [
    'host-created', 'device-selected', 'stream-created', 'play-called', 'first-callback', 'readiness-resolved',
  ]);
  assert.ok(lifecycle.every(({ elapsedMs }) => Number.isFinite(elapsedMs) && elapsedMs >= 0));
});

test('microphone readiness waiters registered before and after start resolve on real input', async () => {
  const runtime = lifecycleCpal({ emitOnPlay: false });
  const { WindowsMicrophoneInputProvider } = await import('../../src/voice/local/windows-microphone-input-provider.js');
  const microphone = new WindowsMicrophoneInputProvider({ runtime });
  let readyBefore = false;
  const beforeStart = microphone.waitUntilReady().then(() => { readyBefore = true; });
  const stream = await microphone.startCapture({ signal: new AbortController().signal, correlationId: 'await-before-start' });
  let readyAfter = false;
  const afterStart = microphone.waitUntilReady().then(() => { readyAfter = true; });
  assert.equal(readyBefore, false);
  assert.equal(readyAfter, false);
  runtime.state.callbacks[0]?.onData(new Float32Array(19200).fill(0.25));
  await Promise.all([beforeStart, afterStart]);
  assert.equal(readyBefore, true);
  assert.equal(readyAfter, true);
  await stream.stop();
  assert.equal(runtime.state.counts.streamsClosed, 1);
});

test('readiness timeout starts only after play and not while native setup is in progress', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const runtime = lifecycleCpal({ emitOnPlay: false, duringBuild: () => t.mock.timers.tick(6000) });
    const { WindowsMicrophoneInputProvider } = await import('../../src/voice/local/windows-microphone-input-provider.js');
    const lifecycle: string[] = [];
    const microphone = new WindowsMicrophoneInputProvider({
      runtime,
      readinessTimeoutMs: 5000,
      onLifecycle: (event) => lifecycle.push(event.stage),
    });
    const readiness = microphone.waitUntilReady();
    const stream = await microphone.startCapture({ signal: new AbortController().signal, correlationId: 'deadline-after-play' });
    runtime.state.callbacks[0]?.onData(new Float32Array(19200).fill(0.25));
    await readiness;
    await stream.stop();
    assert.deepEqual(lifecycle.slice(0, 6), [
      'host-created', 'device-selected', 'stream-created', 'play-called', 'first-callback', 'readiness-resolved',
    ]);
    assert.equal(runtime.state.counts.streamsClosed, 1);
  } finally {
    t.mock.timers.reset();
  }
});

test('readiness timeout is bounded, cleans up once, and ignores late callbacks', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const runtime = lifecycleCpal({ emitOnPlay: false });
    const diagnostics: unknown[] = [];
    const lifecycle: string[] = [];
    const { WindowsMicrophoneInputProvider } = await import('../../src/voice/local/windows-microphone-input-provider.js');
    const microphone = new WindowsMicrophoneInputProvider({
      runtime,
      readinessTimeoutMs: 5000,
      onDiagnostic: (event) => diagnostics.push(event),
      onLifecycle: (event) => lifecycle.push(event.stage),
    });
    const stream = await microphone.startCapture({ signal: new AbortController().signal, correlationId: 'readiness-timeout' });
    const readiness = microphone.waitUntilReady().then(() => undefined, (error: unknown) => error);
    t.mock.timers.tick(5000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const result = await readiness;
    assert.ok(result instanceof VoiceError && result.code === 'VOICE_TIMEOUT_ERROR');
    runtime.state.callbacks[0]?.onData(new Float32Array(19200).fill(0.25));
    runtime.state.callbacks[0]?.onError({ code: 'XRUN', operation: 'lateCallback' });
    await Promise.all([stream.stop(), microphone.stopCapture()]);
    const iterator = stream.chunks()[Symbol.asyncIterator]();
    await assert.rejects(iterator.next(), (error: unknown) => error instanceof VoiceError && error.code === 'VOICE_TIMEOUT_ERROR');
    assert.equal(runtime.state.counts.streamsClosed, 1);
    assert.equal(runtime.state.counts.hostsClosed, 1);
    assert.deepEqual(diagnostics, []);
    assert.deepEqual(lifecycle, ['host-created', 'device-selected', 'stream-created', 'play-called']);
  } finally {
    t.mock.timers.reset();
  }
});

test('readiness timeout configuration is bounded to 5–15 seconds', async () => {
  const { WindowsMicrophoneInputProvider } = await import('../../src/voice/local/windows-microphone-input-provider.js');
  const runtime = lifecycleCpal();
  for (const timeout of [4999, 15001]) {
    assert.throws(
      () => new WindowsMicrophoneInputProvider({ runtime, readinessTimeoutMs: timeout }),
      (error: unknown) => error instanceof VoiceError && error.code === 'VOICE_CONFIGURATION_ERROR',
    );
  }
  assert.doesNotThrow(() => new WindowsMicrophoneInputProvider({ runtime, readinessTimeoutMs: 5000 }));
  assert.doesNotThrow(() => new WindowsMicrophoneInputProvider({ runtime, readinessTimeoutMs: 15000 }));
});

test('device-selection failure preserves only safe native diagnostics and closes the host before retry', async () => {
  const runtime = lifecycleCpal({ throwDeviceSelectionOnce: true });
  const diagnostics: unknown[] = [];
  const { WindowsMicrophoneInputProvider } = await import('../../src/voice/local/windows-microphone-input-provider.js');
  const microphone = new WindowsMicrophoneInputProvider({ runtime, onDiagnostic: (event) => diagnostics.push(event) });

  await assert.rejects(
    microphone.startCapture({ signal: new AbortController().signal, correlationId: 'native-device-error' }),
    (error: unknown) => error instanceof VoiceError && error.code === 'VOICE_CAPTURE_ERROR',
  );
  assert.deepEqual(diagnostics, [{ stage: 'device-select', code: 'DEVICE_BUSY', operation: 'defaultInputDevice' }]);
  assert.equal(JSON.stringify(diagnostics).includes('native detail'), false);
  assert.equal(runtime.state.counts.hostsClosed, 1, 'host must close when device selection throws');

  await microphone.startCapture({ signal: new AbortController().signal, correlationId: 'retry-device-error' });
  await microphone.stopCapture();
  assert.equal(runtime.state.counts.hostsOpened, 2);
  assert.equal(runtime.state.counts.hostsClosed, 2);
});

test('stream-start native errors remain opt-in diagnostics and cleanup permits a retry', async () => {
  const runtime = lifecycleCpal({ throwOnFirstPlay: true });
  const diagnostics: unknown[] = [];
  const { WindowsMicrophoneInputProvider } = await import('../../src/voice/local/windows-microphone-input-provider.js');
  const microphone = new WindowsMicrophoneInputProvider({ runtime, onDiagnostic: (event) => diagnostics.push(event) });

  await assert.rejects(
    microphone.startCapture({ signal: new AbortController().signal, correlationId: 'native-play-error' }),
    (error: unknown) => error instanceof VoiceError && error.code === 'VOICE_CAPTURE_ERROR',
  );
  assert.deepEqual(diagnostics, [{ stage: 'stream-start', code: 'DEVICE_BUSY', operation: 'play' }]);
  await microphone.startCapture({ signal: new AbortController().signal, correlationId: 'retry-play-error' });
  await microphone.stopCapture();
  assert.equal(runtime.state.counts.streamsClosed, 2);
  assert.equal(runtime.state.counts.hostsClosed, 2);
});

test('asynchronous CPAL stream errors expose native code and operation without changing the public capture error', async () => {
  const runtime = lifecycleCpal({ emitOnPlay: false });
  const diagnostics: unknown[] = [];
  const { WindowsMicrophoneInputProvider } = await import('../../src/voice/local/windows-microphone-input-provider.js');
  const microphone = new WindowsMicrophoneInputProvider({ runtime, onDiagnostic: (event) => diagnostics.push(event) });
  const stream = await microphone.startCapture({ signal: new AbortController().signal, correlationId: 'native-callback-error' });
  const pendingChunk = stream.chunks()[Symbol.asyncIterator]().next();
  runtime.state.callbacks[0]?.onError({ code: 'XRUN', operation: 'inputStream' });
  await assert.rejects(
    pendingChunk,
    (error: unknown) => error instanceof VoiceError && error.code === 'VOICE_CAPTURE_ERROR',
  );
  await microphone.stopCapture();
  assert.deepEqual(diagnostics, [{ stage: 'stream-callback', code: 'XRUN', operation: 'inputStream' }]);

  await microphone.startCapture({ signal: new AbortController().signal, correlationId: 'retry-callback-error' });
  await microphone.stopCapture();
  assert.equal(runtime.state.counts.hostsOpened, 2);
  assert.equal(runtime.state.counts.hostsClosed, 2);
});

test('aborted capture can be reopened and concurrent opens are rejected without a second native stream', async () => {
  const runtime = lifecycleCpal({ emitOnPlay: false });
  const { WindowsMicrophoneInputProvider } = await import('../../src/voice/local/windows-microphone-input-provider.js');
  const microphone = new WindowsMicrophoneInputProvider({ runtime });
  const controller = new AbortController();
  const first = microphone.startCapture({ signal: controller.signal, correlationId: 'cancel-reopen' });
  await first;
  await assert.rejects(
    microphone.startCapture({ signal: new AbortController().signal, correlationId: 'concurrent-open' }),
    (error: unknown) => error instanceof VoiceError && error.code === 'VOICE_CONCURRENCY_ERROR',
  );
  controller.abort();
  await microphone.stopCapture();
  await microphone.startCapture({ signal: new AbortController().signal, correlationId: 'after-cancel' });
  await Promise.all([microphone.stopCapture(), microphone.stopCapture()]);
  assert.equal(runtime.state.counts.streamsBuilt, 2);
  assert.equal(runtime.state.counts.streamsClosed, 2);
  assert.equal(runtime.state.counts.hostsClosed, 2);
});

test('native errors delivered during close are ignored as stale callbacks', async () => {
  const runtime = lifecycleCpal({ emitOnPlay: false, errorDuringClose: true });
  const diagnostics: unknown[] = [];
  const { WindowsMicrophoneInputProvider } = await import('../../src/voice/local/windows-microphone-input-provider.js');
  const microphone = new WindowsMicrophoneInputProvider({ runtime, onDiagnostic: (event) => diagnostics.push(event) });
  await microphone.startCapture({ signal: new AbortController().signal, correlationId: 'close-callback' });
  await Promise.all([microphone.stopCapture(), microphone.stopCapture()]);
  assert.deepEqual(diagnostics, []);
  assert.equal(runtime.state.counts.streamsClosed, 1);
});

test('stop awaits native stream closure before allowing a reopen', async () => {
  const runtime = lifecycleCpal({ emitOnPlay: false, deferClose: true });
  const { WindowsMicrophoneInputProvider } = await import('../../src/voice/local/windows-microphone-input-provider.js');
  const microphone = new WindowsMicrophoneInputProvider({ runtime });
  await microphone.startCapture({ signal: new AbortController().signal, correlationId: 'deferred-close' });
  const stopping = microphone.stopCapture();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await assert.rejects(
    microphone.startCapture({ signal: new AbortController().signal, correlationId: 'while-closing' }),
    (error: unknown) => error instanceof VoiceError && error.code === 'VOICE_CONCURRENCY_ERROR',
  );
  runtime.state.closeResolvers[0]?.();
  await stopping;
  await microphone.startCapture({ signal: new AbortController().signal, correlationId: 'after-closing' });
  const secondStopping = microphone.stopCapture();
  await new Promise<void>((resolve) => setImmediate(resolve));
  runtime.state.closeResolvers[1]?.();
  await secondStopping;
  assert.equal(runtime.state.counts.hostsClosed, 2);
});

test('a bounded raw callback queue fails safely when the consumer cannot keep up', async () => {
  const runtime = lifecycleCpal({ emitOnPlay: false });
  const { WindowsMicrophoneInputProvider } = await import('../../src/voice/local/windows-microphone-input-provider.js');
  const microphone = new WindowsMicrophoneInputProvider({ runtime, queueCapacity: 1 });
  const stream = await microphone.startCapture({ signal: new AbortController().signal, correlationId: 'raw-backpressure' });
  const callback = runtime.state.callbacks[0];
  callback?.onData(new Float32Array(19200).fill(0.25));
  callback?.onData(new Float32Array(19200).fill(0.25));
  callback?.onData(new Float32Array(19200).fill(0.25));
  await assert.rejects(
    stream.chunks()[Symbol.asyncIterator]().next(),
    (error: unknown) => error instanceof VoiceError && error.code === 'VOICE_BACKPRESSURE_ERROR',
  );
  await microphone.stopCapture();
  assert.equal(runtime.state.counts.streamsClosed, 1);
});

test('microphone provider returns a controlled typed error when no device exists', async () => {
  const runtime = {
    defaultHost: () => ({ defaultInputDevice: () => null, close() {} }),
    SampleFormat: { F32: { value: 'f32' } },
  } as unknown as CpalRuntime;
  const { WindowsMicrophoneInputProvider } = await import('../../src/voice/local/windows-microphone-input-provider.js');
  await assert.rejects(
    new WindowsMicrophoneInputProvider({ runtime }).startCapture({ signal: new AbortController().signal, correlationId: 'test' }),
    (error: unknown) => error instanceof VoiceError && error.code === 'VOICE_CAPTURE_ERROR',
  );
});

test('Sherpa provider validates local files and decodes a final Spanish transcript offline', async () => {
  const temporary = await temporaryModelFiles();
  let receivedConfig: unknown;
  let receivedSamples = 0;
  const runtime: SherpaRuntime = {
    OfflineRecognizer: {
      async createAsync(config) {
        receivedConfig = config;
        return {
          createStream: () => ({ acceptWaveform: ({ samples }) => { receivedSamples = samples.length; } }),
          decodeAsync: async () => ({ text: 'Hola, Yuki.' }),
        };
      },
    },
  };
  try {
    const provider = new SherpaWhisperSTTProvider(temporary.paths, runtime);
    const session = await provider.start({ sessionId: 's1' }, { signal: new AbortController().signal, correlationId: 'c1' });
    const samples = new Uint8Array(320);
    const view = new DataView(samples.buffer);
    for (let i = 0; i < samples.byteLength; i += 2) view.setInt16(i, 1024, true);
    await session.pushAudio({ data: samples, format: CANONICAL_AUDIO_FORMAT, sequence: 0, capturedAt: new Date(0).toISOString() });
    await session.endInput();
    const events = [];
    for await (const event of session.events()) events.push(event);
    assert.deepEqual(events, [{ type: 'final', text: 'Hola, Yuki.' }]);
    assert.equal(receivedSamples, 160);
    assert.equal((receivedConfig as { modelConfig: { whisper: { language: string; task: string } } }).modelConfig.whisper.language, '');
    assert.equal(JSON.stringify(events).includes('1024'), false);
    await session.close();
  } finally {
    await rm(temporary.directory, { recursive: true, force: true });
  }
});

test('multilingual Whisper autodetection preserves Spanish, English, Japanese, romaji and technical entities verbatim', async () => {
  const temporary = await temporaryModelFiles();
  const transcripts = [
    'Hola Yuki, esta es una prueba en español.',
    'Yuki, check this error in Spring Boot.',
    '愛より確かなものなんてない',
    'Yuki revisa el QueryDSL y findByDocumentNumber.',
    'Pon Ai yori tashikana mono nante nai.',
    'Busca 愛より確かなものなんてない en YouTube.',
    "Pon 'Burn It Down' de Linkin Park y revisa osu!.",
  ];
  let decoded = 0;
  const configs: Array<{ modelConfig: { whisper: { language: string; task: string } } }> = [];
  const runtime: SherpaRuntime = {
    OfflineRecognizer: {
      async createAsync(config) {
        configs.push(config as typeof configs[number]);
        return {
          createStream: () => ({ acceptWaveform() {} }),
          decodeAsync: async () => ({ text: transcripts[decoded++] }),
        };
      },
    },
  };
  try {
    const provider = new SherpaWhisperSTTProvider(temporary.paths, runtime);
    for (const [index, expected] of transcripts.entries()) {
      const session = await provider.start(
        { sessionId: `multilingual-${index}` },
        { signal: new AbortController().signal, correlationId: `multilingual-${index}` },
      );
      await session.pushAudio({
        data: new Uint8Array([0, 4]),
        format: CANONICAL_AUDIO_FORMAT,
        sequence: 0,
        capturedAt: new Date(0).toISOString(),
      });
      await session.endInput();
      const events = [];
      for await (const event of session.events()) events.push(event);
      assert.deepEqual(events, [{ type: 'final', text: expected }]);
      await session.close();
    }
    assert.equal(configs.length, 1, 'the shared autodetect recognizer is initialized once');
    assert.equal(configs[0]?.modelConfig.whisper.language, '');
    assert.equal(configs[0]?.modelConfig.whisper.task, 'transcribe');
  } finally {
    await rm(temporary.directory, { recursive: true, force: true });
  }
});

test('an explicit Whisper language hint remains isolated from the default auto recognizer', async () => {
  const temporary = await temporaryModelFiles();
  const languages: string[] = [];
  const runtime: SherpaRuntime = {
    OfflineRecognizer: {
      async createAsync(config) {
        languages.push(config.modelConfig.whisper.language);
        return { createStream: () => ({ acceptWaveform() {} }), async decodeAsync() { return { text: '' }; } };
      },
    },
  };
  try {
    const provider = new SherpaWhisperSTTProvider(temporary.paths, runtime);
    await provider.prepare();
    await provider.start({ sessionId: 'explicit-es', language: 'es' }, {
      signal: new AbortController().signal,
      correlationId: 'explicit-es',
    });
    assert.deepEqual(languages, ['', 'es']);
  } finally {
    await rm(temporary.directory, { recursive: true, force: true });
  }
});

test('Sherpa provider reports a missing local model without downloading or initializing native runtime', async () => {
  const provider = new SherpaWhisperSTTProvider({ encoder: 'missing-encoder', decoder: 'missing-decoder', tokens: 'missing-tokens' }, {
    OfflineRecognizer: { async createAsync() { throw new Error('must not load'); } },
  });
  await assert.rejects(
    provider.start({ sessionId: 's1' }, { signal: new AbortController().signal, correlationId: 'c1' }),
    (error: unknown) => error instanceof VoiceError && error.code === 'VOICE_STT_ERROR',
  );
});

test('local voice setup validates model before opening the microphone', async () => {
  const cpal = fakeCpal();
  const local = createLocalMicrophoneVoiceService({
    encoder: join(tmpdir(), 'missing-encoder.onnx'),
    decoder: join(tmpdir(), 'missing-decoder.onnx'),
    tokens: join(tmpdir(), 'missing-tokens.txt'),
  }, { cpalRuntime: cpal, sherpaRuntime: { OfflineRecognizer: { async createAsync() { throw new Error('must not initialize'); } } } });
  await assert.rejects(local.stt.prepare(), /speech model is missing/u);
  assert.equal(cpal.counts.started, 0);
});

test('Sherpa provider treats an empty utterance as no transcript rather than invented text', async () => {
  const temporary = await temporaryModelFiles();
  const runtime: SherpaRuntime = {
    OfflineRecognizer: { async createAsync() { return { createStream: () => ({ acceptWaveform() {} }), decodeAsync: async () => ({ text: 'must not decode empty audio' }) }; } },
  };
  try {
    const session = await new SherpaWhisperSTTProvider(temporary.paths, runtime).start(
      { sessionId: 'empty' }, { signal: new AbortController().signal, correlationId: 'empty' },
    );
    await session.endInput();
    const events = [];
    for await (const event of session.events()) events.push(event);
    assert.deepEqual(events, []);
    await session.close();
  } finally {
    await rm(temporary.directory, { recursive: true, force: true });
  }
});

test('push-to-talk sends the final local transcript through the existing conversation orchestrator', async () => {
  const temporary = await temporaryModelFiles();
  const cpal = fakeCpal();
  const sherpa: SherpaRuntime = {
    OfflineRecognizer: {
      async createAsync() {
        return {
          createStream: () => ({ acceptWaveform() {} }),
          decodeAsync: async () => ({ text: 'prueba de voz local' }),
        };
      },
    },
  };
  const provider = new MockAIProvider({ responseText: 'Te escuché.' });
  const core = new AssistantCore({ provider });
  const runner = new ConversationRunner(core);
  const local = createLocalMicrophoneVoiceService(temporary.paths, { cpalRuntime: cpal, sherpaRuntime: sherpa, defaultTimeoutMs: 2000 });
  const orchestrator = new VoiceConversationOrchestrator({ runner, voiceService: local.service });
  const controller = new PushToTalkController(local.microphone, orchestrator);
  const events: VoiceConversationEvent[] = [];
  orchestrator.subscribe((event) => events.push(event));
  try {
    await local.stt.prepare();
    assert.equal(cpal.counts.started, 0, 'model preparation must not open the microphone');
    await controller.start();
    await controller.stop();
    assert.deepEqual(events.filter(({ type }) => type === 'error'), [], JSON.stringify(events));
    assert.deepEqual(runner.session.getMessages().map(({ role, content }) => ({ role, content })), [
      { role: 'user', content: 'prueba de voz local' },
      { role: 'assistant', content: 'Te escuché.' },
    ]);
    assert.equal(provider.name, 'mock');
    assert.equal(cpal.counts.started, 1);
  } finally {
    await orchestrator.shutdown();
    await local.service.shutdownStreaming();
    await rm(temporary.directory, { recursive: true, force: true });
  }
});

test('push-to-talk controller requires explicit start before stop and rejects duplicate capture', async () => {
  let resolveCapture!: () => void;
  let starts = 0;
  let stops = 0;
  const capture = new Promise<void>((resolve) => { resolveCapture = resolve; });
  const fake = {
    startTranscriptionCapture: () => { starts += 1; return capture; },
    whenIdle: async () => {},
  } as unknown as VoiceConversationOrchestrator;
  const controller = new PushToTalkController({ stopCapture: async () => { stops += 1; resolveCapture(); } }, fake);
  await assert.rejects(controller.stop(), /not active/u);
  const started = controller.start();
  await assert.rejects(controller.start(), /already active/u);
  await started;
  await controller.stop();
  assert.equal(starts, 1);
  assert.equal(stops, 1);
  assert.equal(controller.isCapturing, false);
});

test('STT rejects non-canonical audio and bounds utterances to 30 seconds', async () => {
  const temporary = await temporaryModelFiles();
  const runtime: SherpaRuntime = {
    OfflineRecognizer: { async createAsync() { return { createStream: () => ({ acceptWaveform() {} }), decodeAsync: async () => ({ text: 'x' }) }; } },
  };
  try {
    const provider = new SherpaWhisperSTTProvider(temporary.paths, runtime);
    const session = await provider.start({ sessionId: 'bounded' }, { signal: new AbortController().signal, correlationId: 'c' });
    await assert.rejects(session.pushAudio({ data: new Uint8Array(4), format: { ...CANONICAL_AUDIO_FORMAT, sampleRateHz: 8000 }, sequence: 0, capturedAt: '' }), /16 kHz mono/u);
    await assert.rejects(session.pushAudio({ data: new Uint8Array(16000 * 2 * 31), format: CANONICAL_AUDIO_FORMAT, sequence: 0, capturedAt: '' }), /duration limit/u);
    await session.close();
  } finally {
    await rm(temporary.directory, { recursive: true, force: true });
  }
});
